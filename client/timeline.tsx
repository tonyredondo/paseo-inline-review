import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  copyText,
  Icon,
  Modal,
  TextInput,
  useRevealedText,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { classifyLocalFileLink, type LocalFileTarget } from "../shared/markdown-parse";
import { openFileTab } from "./preview-store";
import {
  getTurnFinalCardPosition,
  getTurnFinalCardText,
  mountTurnFinalFragment,
  retainTurnIndex,
  subscribeTurnIndex,
  subscribeTurnFinalFragments,
  turnFinalFragmentVersion,
  turnIndexVersion,
  updateTurnAgentStatus,
} from "./turn-final-store";
import { z } from "zod";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import {
  openLocalFileRpc,
  COMPACT_FILE_TRANSFER_CHUNK_BYTES,
  DESKTOP_FILE_TRANSFER_CHUNK_BYTES,
  reviewItemSchema,
  sentReviewSchema,
  userMessageCardSchema,
  userMessageHasHostAttachments,
  findReviewCommentParagraphIndex,
  locateCodeLineAnchor,
  reviewCommentMatchesParagraph,
  sameCodeLineAnchor,
  looksLikeSentReview,
  parseCodeReviewQuote,
  parseReviewMessage,
  type ReviewComment,
  type CodeLineAnchor,
  previewLanguage,
  type ReviewItemData,
  type SentReviewData,
  type UserMessageCardData,
} from "../shared/review";
import {
  addComment,
  getCommentsForSource,
  relocateComment,
  removeComment,
  subscribeCommentsForSource,
  updateComment,
} from "./review-store";
import { FileCodeBlock, MarkdownText } from "./markdown";
import { downloadLocalFileProgressively, formatFileSize } from "./file-download";
import { createStableReferenceDefinitions } from "./markdown-stream";
import { createStableParagraphs } from "./paragraph-stream";
import { createStreamingTextCoalescer } from "./stream-text";
import { DownloadCancelledError } from "./web";
import { WideFrameController, useWideFrameControllerOwner } from "./wide-frame-controller";
import { finalCardHoverStore } from "./final-card-hover";

/** Data for the dotted compaction divider replacing the host's hairline. */
const compactionDividerSchema = z.object({
  status: z.enum(["loading", "completed"]),
  trigger: z.string().nullable(),
  preTokens: z.number().nullable(),
});

type CompactionDividerData = z.output<typeof compactionDividerSchema>;

type EditingTarget = {
  paragraphIndex: number;
  paragraphText: string;
  draft: string;
  /** Set when the target is one markdown list item (per-item comment). */
  itemIndex?: number | null;
  /** Set when the target is one source line inside a Markdown code block. */
  codeAnchor?: CodeLineAnchor | null;
  /** When set, the editor updates an existing comment instead of adding one. */
  commentId?: string;
};

/**
 * Anchoring rules. A comment renders under a paragraph only when the message
 * identity and the paragraph identity both match exactly, so a comment can
 * never leak into other paragraphs or messages:
 * - With a known message id: the comment must carry the same id.
 * - Without one (id-less messages): the saved paragraph snapshot must equal
 *   the paragraph exactly, in a message that has no id either.
 */
/** Converts #rrggbb to rgba() so borders can fade without losing hue. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function commentAnchorsHere(
  messageId: string | null,
  paragraph: string,
  index: number,
  comment: ReviewComment,
): boolean {
  // Per-list-item comments render inside their item row, never chunk-level.
  if (comment.itemIndex !== undefined && comment.itemIndex !== null) return false;
  if (comment.codeAnchor) return false;
  if (comment.messageId !== null && comment.messageId !== messageId) return false;
  if (comment.paragraphIndex !== index) return false;
  return reviewCommentMatchesParagraph(comment, paragraph);
}

type CodeLineComment = ReviewComment & { codeAnchor: CodeLineAnchor };

function codeLineComments(
  comments: ReviewComment[],
  messageId: string | null,
  paragraph: string,
  paragraphIndex: number,
): CodeLineComment[] {
  return comments.filter((comment): comment is CodeLineComment =>
    comment.paragraphIndex === paragraphIndex &&
    comment.codeAnchor !== null && comment.codeAnchor !== undefined &&
    (comment.messageId === null || comment.messageId === messageId) &&
    reviewCommentMatchesParagraph(comment, paragraph),
  );
}

/** Comments anchored to one list item of the chunk at chunkIndex. */
function listItemComments(
  comments: ReviewComment[],
  chunkIndex: number,
  itemIndex: number,
): ReviewComment[] {
  return comments.filter(
    (comment) =>
      comment.paragraphIndex === chunkIndex &&
      comment.itemIndex === itemIndex,
  );
}

function useMessageComments(agentId: string, data: ReviewItemData, sourceKey: string) {
  const subscribeToSource = useCallback(
    (listener: () => void) =>
      subscribeCommentsForSource(agentId, data.messageId, sourceKey, listener),
    [agentId, data.messageId, sourceKey],
  );
  const getSourceSnapshot = useCallback(
    () => getCommentsForSource(agentId, data.messageId, sourceKey),
    [agentId, data.messageId, sourceKey],
  );
  return useSyncExternalStore(subscribeToSource, getSourceSnapshot, getSourceSnapshot);
}

let nextMessageSourceKey = 1;

/** Bounds streaming reparse frequency while returning the final snapshot synchronously. */
function useCoalescedStreamingText(text: string, phase: ReviewItemData["phase"]): string {
  const [coalesced, setCoalesced] = useState(text);
  const coalescer = useRef<ReturnType<typeof createStreamingTextCoalescer> | null>(null);
  if (!coalescer.current) {
    coalescer.current = createStreamingTextCoalescer({ publish: setCoalesced });
  }
  useEffect(() => {
    coalescer.current?.update(text, phase === "complete");
  }, [text, phase]);
  useEffect(() => () => coalescer.current?.dispose(), []);
  return phase === "complete" ? text : coalesced;
}

/**
 * Left-ellipsis for long paths: keep the tail (the file name and its
 * nearest parent dirs), cutting at a "/" boundary so no segment breaks
 * mid-word, and prefix with an ellipsis.
 */
function startEllipsis(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  const cut = path.length - maxChars;
  const slash = path.indexOf("/", cut);
  const tail = slash === -1 ? path.slice(-maxChars) : path.slice(slash + 1);
  return `…/${tail}`;
}

/** Preview state for a tapped local-file link. */
type FilePreviewBase = {
  path: string;
  size: number;
  lineStart?: number;
  lineEnd?: number;
};

type FilePreviewState = FilePreviewBase & (
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; dataUri?: string; mimeType: string }
);

/**
 * Desktop (web) file preview. The host AdaptiveModalSheet caps its card at
 * 520px wide and the plugin Modal.Content exposes no size props, so on web the
 * plugin draws its own full-viewport overlay with a big, inner-scrolling card.
 */
function WebFilePreviewOverlay({
  filePreview,
  theme,
  compact,
  onClose,
  onOpenLocally,
  onDownload,
}: {
  filePreview: FilePreviewState;
  theme: PluginTheme;
  compact: boolean;
  onClose(): void;
  onOpenLocally(): void;
  onDownload(): void;
}): ReactNode {
  // Escape closes the overlay.
  useEffect(() => {
    const g = globalThis as unknown as {
      addEventListener(type: string, listener: (event: { key: string }) => void): void;
      removeEventListener(type: string, listener: (event: { key: string }) => void): void;
    };
    const listener = (event: { key: string }): void => {
      if (event.key === "Escape") onClose();
    };
    g.addEventListener("keydown", listener);
    return () => g.removeEventListener("keydown", listener);
  }, [onClose]);
  return (
    <View
      style={{
        // RN types say "absolute"; RN Web renders "fixed" as-is (viewport overlay).
        ...( { position: "fixed", top: 0, left: 0, right: 0, bottom: 0 } as object),
        backgroundColor: "rgba(0,0,0,0.6)",
        zIndex: 60,
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
      }}
      // Backdrop press closes; the card claims the responder first, so
      // presses inside the card never reach the backdrop.
      onStartShouldSetResponder={() => true}
      onResponderRelease={onClose}
    >
      <View
        style={{
          width: "94%",
          maxWidth: 1500,
          height: "92%",
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 12,
          overflow: "hidden",
          padding: 8,
          gap: 6,
        }}
        onStartShouldSetResponder={() => true}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 }} numberOfLines={2}>
            {`${filePreview.path}${filePreview.kind === "text" && filePreview.truncated ? " (truncated)" : ""}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the file on the agent machine"
            hitSlop={6}
            onPress={onOpenLocally}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Open locally</Text>
          </Pressable>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>|</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Download the file"
            hitSlop={6}
            onPress={onDownload}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Download</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close the file preview"
            hitSlop={6}
            onPress={onClose}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>
        <View style={{ flex: 1, padding: 4 }}>
          {filePreview.kind === "image" ? (
            filePreview.dataUri ? (
              <Image
                source={{ uri: filePreview.dataUri }}
                style={{ width: "100%", height: "100%" }}
                resizeMode="contain"
                accessibilityLabel={`Preview of ${filePreview.path}`}
              />
            ) : (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {`Image · ${formatFileSize(filePreview.size)} exceeds the 5 MB preview limit.`}
                </Text>
              </View>
            )
          ) : (
            <FileCodeBlock
              code={filePreview.content}
              language={previewLanguage(filePreview.path)}
              theme={theme}
              compact={compact}
              virtualized
              highlightStart={filePreview.lineStart}
              highlightEnd={filePreview.lineEnd}
            />
          )}
        </View>
      </View>
    </View>
  );
}

function CommentCard({
  comment,
  theme,
  targetLabel,
  onEdit,
  onRemove,
}: {
  comment: ReviewComment;
  theme: PluginTheme;
  targetLabel?: string;
  onEdit(comment: ReviewComment): void;
  onRemove(): void;
}) {
  const sent = comment.status === "sent";
  const styles = useMemo(
    () => ({
      card: {
        borderRadius: 8,
        backgroundColor: sent ? theme.colors.surface1 : theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        // Sent cards keep the guiding border, dimmed via alpha.
        borderLeftWidth: 3,
        borderLeftColor: sent ? withAlpha(theme.colors.accent, 0.35) : theme.colors.accent,
        // Inset from sibling blocks and pad the sides so comment cards read
        // as their own element, not as another full-width block.
        marginHorizontal: 10,
        marginVertical: 4,
        paddingHorizontal: 10,
        paddingVertical: 10,
        gap: 4,
      } as const,
      header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } as const,
      label: { color: theme.colors.foregroundMuted, fontSize: 11 } as const,
      text: { color: sent ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 13 } as const,
      delete: { color: theme.colors.statusDanger, fontSize: 12 } as const,
    }),
    [theme, sent],
  );
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.label}>
          {["Your comment", targetLabel, sent ? "sent \u2713" : "pending"].filter(Boolean).join(" \u00b7 ")}
        </Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit comment" onPress={() => onEdit(comment)} hitSlop={6}>
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Edit</Text>
          </Pressable>
          {/* Sent comments are part of the conversation: no delete. */}
          {!sent ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Delete comment" onPress={onRemove} hitSlop={6}>
              <Text style={styles.delete}>Delete</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Text style={styles.text}>{comment.text}</Text>
    </View>
  );
}

const ReviewParagraph = memo(function ReviewParagraph({
  paragraph,
  index,
  messageId,
  phase,
  sourceKey,
  theme,
  compact,
  platform,
  refs,
  workspaceRoot,
  comments,
  editing,
  editorNode,
  commentsStyle,
  onSetEditing,
  onChunkTap,
  onListItemTap,
  onLocalFilePress,
}: {
  paragraph: string;
  index: number;
  messageId: string | null;
  phase: ReviewItemData["phase"];
  sourceKey: string;
  theme: PluginTheme;
  compact: boolean;
  platform: string;
  refs: Map<string, string>;
  workspaceRoot: string | null;
  comments: ReviewComment[];
  editing: EditingTarget | null;
  editorNode: ReactNode;
  commentsStyle: object;
  onSetEditing(next: EditingTarget | null): void;
  onChunkTap(chunkIndex: number, itemIndex: number, itemText: string): void;
  onListItemTap(chunkIndex: number, itemIndex: number, itemText: string, event?: unknown): void;
  onLocalFilePress(target: LocalFileTarget): void;
}) {
  const anchored = comments.filter((comment) =>
    commentAnchorsHere(messageId, paragraph, index, comment),
  );
  const commentsByCodeBlock = useMemo(() => {
    const grouped = new Map<number, CodeLineComment[]>();
    for (const comment of codeLineComments(comments, messageId, paragraph, index)) {
      const bucket = grouped.get(comment.codeAnchor.blockIndex) ?? [];
      bucket.push(comment);
      grouped.set(comment.codeAnchor.blockIndex, bucket);
    }
    return grouped;
  }, [comments, index, messageId, paragraph]);
  const itemEditing = editing?.itemIndex !== null && editing?.itemIndex !== undefined;
  const codeEditing = editing?.codeAnchor !== null && editing?.codeAnchor !== undefined;
  const openParagraphEditor = (): void => {
    onSetEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" });
  };
  const listExtras = (itemIndex: number): ReactNode => (
    <>
      {editing?.itemIndex === itemIndex ? editorNode : null}
      {listItemComments(comments, index, itemIndex).map((comment) => (
        <CommentCard
          key={comment.id}
          comment={comment}
          theme={theme}
          onEdit={() =>
            onSetEditing({
              paragraphIndex: index,
              itemIndex,
              paragraphText: comment.paragraphText,
              draft: comment.text,
              commentId: comment.id,
            })
          }
          onRemove={() => removeComment(comment.id)}
        />
      ))}
    </>
  );
  const openCodeLineEditor = (anchor: CodeLineAnchor, event?: unknown): void => {
    const carrier = event as {
      preventDefault?: () => void;
      stopPropagation?: () => void;
      nativeEvent?: { metaKey?: boolean; ctrlKey?: boolean };
    } | undefined;
    const native = carrier?.nativeEvent;
    if (!(native?.metaKey || native?.ctrlKey)) return;
    carrier?.preventDefault?.();
    carrier?.stopPropagation?.();
    onSetEditing({
      paragraphIndex: index,
      paragraphText: paragraph,
      codeAnchor: anchor,
      draft: "",
    });
  };
  const codeExtras = (blockIndex: number): ReactNode => {
    const blockComments = commentsByCodeBlock.get(blockIndex) ?? [];
    const editorHere = editing?.codeAnchor?.blockIndex === blockIndex;
    if (!editorHere && blockComments.length === 0) return null;
    return (
      <View style={{ gap: 4, marginTop: 2 }}>
        {editorHere ? editorNode : null}
        {blockComments.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            theme={theme}
            targetLabel={`Line ${comment.codeAnchor.lineIndex + 1}`}
            onEdit={() =>
              onSetEditing({
                paragraphIndex: index,
                paragraphText: comment.paragraphText,
                codeAnchor: comment.codeAnchor,
                draft: comment.text,
                commentId: comment.id,
              })
            }
            onRemove={() => removeComment(comment.id)}
          />
        ))}
      </View>
    );
  };
  const annotatedCodeLines = (blockIndex: number): ReadonlySet<number> => {
    const lines = new Set(
      (commentsByCodeBlock.get(blockIndex) ?? [])
        .map((comment) => comment.codeAnchor.lineIndex),
    );
    if (editing?.codeAnchor?.blockIndex === blockIndex) lines.add(editing.codeAnchor.lineIndex);
    return lines;
  };
  const markdown = (
    <MarkdownText
      text={paragraph}
      cacheKey={phase === "complete" ? `${messageId ?? sourceKey}:${index}` : undefined}
      theme={theme}
      compact={compact}
      refs={refs}
      selectable={platform === "web" ? undefined : platform !== "ios"}
      onChunkPress={platform === "web" ? undefined : () => onChunkTap(index, -1, paragraph)}
      onCommentRequest={openParagraphEditor}
      onCodeLinePress={platform === "web" ? openCodeLineEditor : undefined}
      codeBlockExtras={codeExtras}
      annotatedCodeLines={annotatedCodeLines}
      localFileResolver={(url) => classifyLocalFileLink(url, { workspaceRoot })}
      onLocalFilePress={onLocalFilePress}
      onListItemPress={(itemIndex, itemText, event) => onListItemTap(index, itemIndex, itemText, event)}
      listItemExtras={listExtras}
    />
  );

  return (
    <View style={commentsStyle}>
      {platform === "web" ? (
        <Pressable
          style={{ cursor: "text", userSelect: "text" } as object}
          onPress={(event) => {
            const native = event.nativeEvent as unknown as { metaKey?: boolean; ctrlKey?: boolean };
            if (native.metaKey || native.ctrlKey) openParagraphEditor();
          }}
        >
          {markdown}
        </Pressable>
      ) : (
        <View>{markdown}</View>
      )}
      {editing && !itemEditing && !codeEditing ? editorNode : null}
      {anchored.map((comment) => (
        <CommentCard
          key={comment.id}
          comment={comment}
          theme={theme}
          onEdit={() =>
            onSetEditing({
              paragraphIndex: index,
              paragraphText: comment.paragraphText,
              draft: comment.text,
              commentId: comment.id,
            })
          }
          onRemove={() => removeComment(comment.id)}
        />
      ))}
    </View>
  );
});

/** Compact card replacing the raw review text in the timeline. */
/** Dotted-line divider for compaction markers (replaces the host hairline). */
const NATIVE_COMPACTION_DOTS = "● ".repeat(160);

function CompactionRule({
  platform,
  theme,
}: {
  platform: "web" | "native";
  theme: PluginTheme;
}) {
  if (platform === "web") {
    return (
      <View
        style={{
          flex: 1,
          borderBottomWidth: 4,
          borderBottomColor: theme.colors.border,
          borderStyle: "dotted",
        }}
      />
    );
  }

  return (
    <Text
      accessible={false}
      numberOfLines={1}
      ellipsizeMode="clip"
      style={{
        flex: 1,
        height: 9,
        overflow: "hidden",
        color: theme.colors.border,
        fontSize: 9,
        lineHeight: 9,
        letterSpacing: 2,
      }}
    >
      {NATIVE_COMPACTION_DOTS}
    </Text>
  );
}

function CompactionDivider({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<CompactionDividerData>) {
  const styles = useMemo(
    () => ({
      root: {
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 14,
      } as const,
      label: { color: theme.colors.foregroundMuted, fontSize: 12 } as const,
    }),
    [theme],
  );
  const label =
    item.data.status === "loading" ? "Compacting context…" : "Context compacted";
  const rulePlatform = layout.platform === "web" ? "web" : "native";
  return (
    <View testID="inline-review-root" style={styles.root}>
      <CompactionRule platform={rulePlatform} theme={theme} />
      <Icon name="Link" size={12} color={theme.colors.foregroundMuted} />
      <Text style={styles.label}>{label}</Text>
      <CompactionRule platform={rulePlatform} theme={theme} />
    </View>
  );
}

/** Short wall-clock label ("13:38") for the native user card. */
function timestampLabel(timestamp: Date): string {
  return timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Keeps hover subscriptions inside the controls so markdown never rerenders. */
const FinalCardShell = memo(function FinalCardShell({
  children,
  style,
  timestamp,
  text,
  theme,
  platform,
  hoverKey,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  timestamp: Date;
  text: string | null;
  theme: PluginTheme;
  platform: string;
  hoverKey: string | null;
}) {
  return (
    <View
      testID="inline-review-root"
      style={style}
      onPointerMove={hoverKey !== null && platform === "web"
        ? () => finalCardHoverStore.show(hoverKey)
        : undefined}
      onPointerLeave={hoverKey !== null && platform === "web"
        ? () => finalCardHoverStore.hide(hoverKey)
        : undefined}
    >
      {children}
      {text !== null && hoverKey !== null ? (
        <FinalCardControls
          timestamp={timestamp}
          text={text}
          theme={theme}
          platform={platform}
          hoverKey={hoverKey}
        />
      ) : null}
    </View>
  );
});

const FinalCardControls = memo(function FinalCardControls({
  timestamp,
  text,
  theme,
  platform,
  hoverKey,
}: {
  timestamp: Date;
  text: string;
  theme: PluginTheme;
  platform: string;
  hoverKey: string;
}) {
  const subscribeHover = useCallback(
    (listener: () => void) => finalCardHoverStore.subscribe(hoverKey, listener),
    [hoverKey],
  );
  const hovered = useSyncExternalStore(
    subscribeHover,
    () => finalCardHoverStore.isHovered(hoverKey),
    () => false,
  );
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  async function copy(): Promise<void> {
    try {
      await copyText(text);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be unavailable in restricted clients.
    }
  }

  const controlsVisible = platform !== "web" || hovered || focused || copied;
  return (
    <View
      style={{
        position: "absolute",
        right: 12,
        bottom: 4,
        zIndex: 3,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        opacity: controlsVisible ? 1 : 0,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {timestampLabel(timestamp)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy agent response"
        hitSlop={6}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={() => void copy()}
        style={{ minWidth: 18, minHeight: 18, alignItems: "center", justifyContent: "center" }}
      >
        <Icon
          name={copied ? "Check" : "Copy"}
          size={14}
          color={copied ? theme.colors.accent : theme.colors.foregroundMuted}
        />
      </Pressable>
    </View>
  );
});

/**
 * Native equivalent of the desktop user-message card. Web keeps Paseo's host
 * row so its image rail and edit/copy controls remain available; iOS and
 * Android need a React Native renderer because there is no DOM styling pass.
 */
function UserMessageCard({
  item,
  timestamp,
  theme,
  layout,
}: PluginTimelineItemProps<UserMessageCardData>) {
  const styles = useMemo(
    () => ({
      root: {
        alignSelf: "flex-end",
        maxWidth: "100%",
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderTopColor: theme.colors.border,
        borderRightColor: theme.colors.border,
        borderBottomColor: theme.colors.border,
        borderLeftWidth: 5,
        borderLeftColor: withAlpha(theme.colors.accent, 0.35),
        paddingHorizontal: 10,
        paddingTop: 12,
        paddingBottom: 8,
        marginVertical: 2,
      } as const,
      time: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        textAlign: "right",
        paddingTop: 2,
      } as const,
    }),
    [theme],
  );
  return (
    <View testID="inline-review-user-message" style={styles.root}>
      <MarkdownText text={item.data.text} theme={theme} compact={layout.compact} />
      <Text style={styles.time}>{timestampLabel(timestamp)}</Text>
    </View>
  );
}

function SentReviewCard({
  item,
  theme,
}: PluginTimelineItemProps<SentReviewData>) {
  const parsed = useMemo(() => parseReviewMessage(item.data.text), [item.data.text]);
  const [open, setOpen] = useState(false);
  const styles = useMemo(
    () => ({
      card: {
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      } as const,
      header: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10 } as const,
      title: { color: theme.colors.foreground, fontWeight: "600", fontSize: 13, flex: 1 } as const,
      badge: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" } as const,
      note: {
        color: theme.colors.foreground,
        fontSize: 14,
        lineHeight: 21,
        paddingHorizontal: 10,
        paddingBottom: parsed.entries.length > 0 ? 6 : 10,
      } as const,
      entry: { paddingHorizontal: 10, paddingVertical: 8, gap: 3 } as const,
      entryBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border } as const,
      quote: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" } as const,
      codeHeader: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        marginBottom: 4,
      } as const,
      codeFrame: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 7,
        overflow: "hidden",
        marginBottom: 3,
      } as const,
      codeRow: {
        flexDirection: "row",
        alignItems: "stretch",
        borderLeftWidth: 3,
        borderLeftColor: "transparent",
        minHeight: 22,
      } as const,
      codeSelectedRow: {
        backgroundColor: withAlpha(theme.colors.accent, 0.16),
        borderLeftColor: theme.colors.accent,
      } as const,
      codeLineNumber: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 22,
        width: 34,
        paddingRight: 8,
        textAlign: "right",
        userSelect: "none",
      } as const,
      codeSelectedLineNumber: { color: theme.colors.accent } as const,
      codeLineText: {
        color: theme.colors.foreground,
        fontFamily: Platform.OS === "ios"
          ? "Menlo"
          : Platform.OS === "android"
            ? "monospace"
            : "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        fontSize: 11,
        lineHeight: 22,
        paddingRight: 10,
      } as const,
      comment: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 } as const,
    }),
    [theme, parsed.entries.length],
  );
  const count = parsed.entries.length;
  return (
    <View testID="inline-review-sent" style={styles.card}>
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.header}>
        <Icon name="MessageSquareQuote" size={14} color={theme.colors.accent} />
        <Text style={styles.title}>{`Review sent`}</Text>
        <Text style={styles.badge}>{count === 1 ? "1 comment" : `${count} comments`}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{open ? "▼" : "▶"}</Text>
      </Pressable>
      {open || count === 0 ? (
        <View>
          {parsed.note.length > 0 ? <Text style={styles.note}>{parsed.note}</Text> : null}
          {parsed.entries.map((entry, index) => {
            const codeQuote = parseCodeReviewQuote(entry.quote);
            return (
              <View key={index} style={[styles.entry, index > 0 ? styles.entryBorder : null]}>
                {codeQuote ? (
                  <View>
                    <Text style={styles.codeHeader}>
                      {`Code block ${codeQuote.blockNumber} · Line ${codeQuote.lineNumber}`}
                    </Text>
                    <View style={styles.codeFrame}>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={{ minWidth: "100%" }}>
                          {codeQuote.lines.map((codeLine) => (
                            <View
                              key={codeLine.lineNumber}
                              style={[styles.codeRow, codeLine.selected ? styles.codeSelectedRow : null]}
                            >
                              <Text
                                style={[
                                  styles.codeLineNumber,
                                  codeLine.selected ? styles.codeSelectedLineNumber : null,
                                ]}
                              >
                                {codeLine.lineNumber}
                              </Text>
                              <Text style={styles.codeLineText}>
                                {codeLine.text.length > 0 ? codeLine.text : " "}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </ScrollView>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.quote} numberOfLines={2}>{`"${entry.quote}"`}</Text>
                )}
                <Text style={styles.comment}>{entry.comment}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function ReviewAssistantMessage({
  agentId,
  item,
  timestamp,
  theme,
  layout,
}: PluginTimelineItemProps<ReviewItemData>) {
  const data = item.data;
  const sourceKeyRef = useRef<string | null>(null);
  if (sourceKeyRef.current === null) sourceKeyRef.current = `stream-${nextMessageSourceKey++}`;
  const sourceKey = sourceKeyRef.current;
  const openLocalFile = useRpc(openLocalFileRpc);

  const toast = useToast();
  const paseo = usePaseo();
  const subscribeToTurnIndex = useCallback(
    (listener: () => void) => subscribeTurnIndex(agentId, listener),
    [agentId],
  );
  // Turn-final card: derive finality from ordered timeline data on every
  // platform. Merged history rows intentionally cannot identify their still-
  // separate live fragments by messageId; those fragments remain plain until
  // Paseo supplies the consolidated final text.
  const turnVersion = useSyncExternalStore(
    subscribeToTurnIndex,
    () => turnIndexVersion(agentId),
    () => turnIndexVersion(agentId),
  );
  const subscribeToFinalFragments = useCallback(
    (listener: () => void) => subscribeTurnFinalFragments(agentId, sourceKey, listener),
    [agentId, sourceKey],
  );
  const fragmentVersion = useSyncExternalStore(
    subscribeToFinalFragments,
    () => turnFinalFragmentVersion(agentId, sourceKey),
    () => turnFinalFragmentVersion(agentId, sourceKey),
  );
  const timestampValue = timestamp.getTime();
  const finalCardPosition = useMemo(() => {
    // These versions are the external-store snapshots that invalidate the lookup.
    void turnVersion;
    void fragmentVersion;
    return getTurnFinalCardPosition(agentId, sourceKey);
  }, [turnVersion, fragmentVersion, agentId, sourceKey]);
  const finalCardText = useMemo(() => {
    void turnVersion;
    void fragmentVersion;
    return getTurnFinalCardText(agentId, sourceKey);
  }, [turnVersion, fragmentVersion, agentId, sourceKey]);
  const finalCardHoverKey = finalCardPosition === "none"
    ? null
    : `${agentId}:${data.messageId ?? sourceKey}`;
  useLayoutEffect(() => {
    try {
      const handle = paseo?.agents?.ref(agentId);
      if (!handle?.timeline) return;
      return retainTurnIndex(agentId, handle.timeline);
    } catch {
      return;
    }
  }, [paseo, agentId]);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const ownsWideFrameController = useWideFrameControllerOwner();
  // Host-maintained state updates when the agent snapshot arrives or its cwd changes.
  const agentSnapshot = useAgent(agentId, (agent) => agent
    ? { workspaceId: agent.workspaceId, cwd: agent.cwd, status: agent.status }
    : null);
  const agentWorkspaceId = agentSnapshot?.workspaceId ?? null;
  // The workspace root lives on the daemon machine; relative file links
  // resolve against it.
  const workspaceRoot = agentSnapshot?.cwd ?? null;
  useLayoutEffect(() => {
    updateTurnAgentStatus(agentId, agentSnapshot?.status);
  }, [agentId, agentSnapshot?.status]);
  const revealedRaw = useRevealedText(data.text, data.phase);
  const revealed = useCoalescedStreamingText(revealedRaw, data.phase);
  const referenceDefinitions = useRef<ReturnType<typeof createStableReferenceDefinitions> | null>(null);
  if (!referenceDefinitions.current) {
    referenceDefinitions.current = createStableReferenceDefinitions();
  }
  const refs = useMemo(
    () => referenceDefinitions.current!.update(revealed),
    [revealed],
  );
  const paragraphStream = useRef<ReturnType<typeof createStableParagraphs> | null>(null);
  if (!paragraphStream.current) paragraphStream.current = createStableParagraphs();
  const finalFragmentHandle = useRef<ReturnType<typeof mountTurnFinalFragment> | null>(null);
  useLayoutEffect(() => {
    const handle = mountTurnFinalFragment({
      agentId,
      sourceKey,
      messageId: data.messageId,
      text: revealed,
      timestamp: timestampValue,
      phase: data.phase,
    });
    finalFragmentHandle.current = handle;
    return () => {
      if (finalFragmentHandle.current === handle) finalFragmentHandle.current = null;
      handle.release();
    };
  }, [agentId, sourceKey]);
  useLayoutEffect(() => {
    finalFragmentHandle.current?.update({
      messageId: data.messageId,
      text: revealed,
      timestamp: timestampValue,
      phase: data.phase,
    });
  }, [data.messageId, data.phase, revealed, timestampValue]);
  const paragraphs = useMemo(
    () => paragraphStream.current!.update(revealed),
    [revealed],
  );
  const comments = useMessageComments(agentId, data, sourceKey);
  const reanchoredVersions = useRef(new Map<string, string>());
  // Re-anchor streaming-time comments once the complete message exists: bind
  // id-less comments to this message and heal paragraph-index drift caused by
  // re-chunking between the streaming and complete snapshots.
  useEffect(() => {
    if (data.messageId === null) return;
    const candidates = comments.filter((comment) =>
      (
        comment.messageId === data.messageId ||
        (
          comment.messageId === null &&
          (comment.sourceKey === sourceKey || comment.sourceKey === null || comment.sourceKey === undefined)
        )
      ),
    );
    for (const comment of candidates) {
      const anchorKey = `${comment.revision}:${data.messageId}:${paragraphs.length}:${comment.paragraphText}`;
      if (reanchoredVersions.current.get(comment.id) === anchorKey) continue;
      const index = findReviewCommentParagraphIndex(comment, paragraphs);
      const codeAnchor = comment.codeAnchor && index !== -1
        ? locateCodeLineAnchor(paragraphs[index], comment.codeAnchor)
        : undefined;
      if (index !== -1 && (
        comment.messageId !== data.messageId ||
        comment.paragraphIndex !== index ||
        (codeAnchor !== undefined && !sameCodeLineAnchor(comment.codeAnchor, codeAnchor)) ||
        comment.sourceKey !== null
      )) {
        relocateComment(comment.id, data.messageId, index, codeAnchor);
      }
      reanchoredVersions.current.set(comment.id, anchorKey);
    }
  }, [comments, paragraphs, data.messageId, sourceKey]);
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  // Web: scroll the open editor into the viewport (DOM scrollIntoView). On
  // native the timeline ScrollView is host-owned and the SDK exposes no scroll
  // API, so this is web-only.
  const editorRef = useRef<View>(null);
  const editingOpen = editing !== null;
  useEffect(() => {
    if (!editingOpen || layout.platform !== "web") return;
    const timer = setTimeout(() => {
      const node = editorRef.current as unknown as { scrollIntoView?: (options?: { block?: string; behavior?: string }) => void };
      node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }, 120);
    return () => clearTimeout(timer);
  }, [editingOpen, layout.platform]);
  // Double-tap detection for touch devices (web uses modifier-click).
  const lastTapRef = useRef<{ index: number; itemIndex: number; at: number } | null>(null);

  const styles = useMemo(
    () => {
      const inFinalCard = finalCardPosition !== "none";
      const startsFinalCard = finalCardPosition === "single" || finalCardPosition === "start";
      const endsFinalCard = finalCardPosition === "single" || finalCardPosition === "end";
      const bridgeHeight = layout.compact ? 16 : 22;
      return {
        root: {
        gap: layout.compact ? 6 : 8,
        paddingBottom: inFinalCard ? (endsFinalCard ? 28 : 4) : 10,
        // Live merged fragments become adjacent slices of one final card.
        // Every source row keeps its own content and measured height.
        ...(inFinalCard
          ? {
              backgroundColor: theme.colors.surface1,
              borderRightWidth: 5,
              borderRightColor: withAlpha(theme.colors.accent, 0.35),
              borderLeftWidth: 5,
              borderLeftColor: withAlpha(theme.colors.accent, 0.35),
              borderTopWidth: startsFinalCard ? 1 : 0,
              borderTopColor: theme.colors.border,
              borderBottomWidth: endsFinalCard ? 1 : 0,
              borderBottomColor: theme.colors.border,
              borderTopLeftRadius: startsFinalCard ? 8 : 0,
              borderTopRightRadius: startsFinalCard ? 8 : 0,
              borderBottomLeftRadius: endsFinalCard ? 8 : 0,
              borderBottomRightRadius: endsFinalCard ? 8 : 0,
              paddingLeft: 16,
              paddingRight: 16,
              paddingTop: startsFinalCard ? 14 : 4,
              marginTop: startsFinalCard ? 4 : 0,
              position: "relative" as const,
            }
          : {}),
        } as const,
        cardBridge: {
          position: "absolute" as const,
          left: -5,
          right: -5,
          bottom: -bridgeHeight,
          height: bridgeHeight,
          backgroundColor: theme.colors.surface1,
          borderLeftWidth: 5,
          borderLeftColor: withAlpha(theme.colors.accent, 0.35),
          borderRightWidth: 5,
          borderRightColor: withAlpha(theme.colors.accent, 0.35),
        } as const,
        comments: { gap: 4, marginTop: 2 } as const,
        editor: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 8,
        } as const,
        actions: { flexDirection: "row", gap: 8 } as const,
        input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        minHeight: 64,
        textAlignVertical: "top",
        } as const,
        save: {
        backgroundColor: theme.colors.accent,
        borderRadius: 8,
        padding: 10,
        alignItems: "center" as const,
        } as const,
        saveText: { color: theme.colors.accentForeground, fontSize: 14 } as const,
        cancel: { padding: 10, alignItems: "center" as const } as const,
        cancelText: { color: theme.colors.foregroundMuted, fontSize: 14 } as const,
      };
    },
    [theme, layout.compact, finalCardPosition],
  );

  const handleChunkTap = useCallback((chunkIndex: number, itemIndex: number, itemText: string): void => {
    // Touch: a double-tap on the same chunk (or list item) opens the editor, so
    // single taps and long-presses stay free for scroll and native selection.
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && last.index === chunkIndex && last.itemIndex === itemIndex && now - last.at < 350) {
      lastTapRef.current = null;
      setEditing({
        paragraphIndex: chunkIndex,
        itemIndex: itemIndex >= 0 ? itemIndex : null,
        paragraphText: itemText,
        draft: "",
      });
      return;
    }
    lastTapRef.current = { index: chunkIndex, itemIndex, at: now };
  }, []);

  /** List item taps: web opens per-item with Cmd/Ctrl; native uses double-tap. */
  const handleListItemTap = useCallback((
    chunkIndex: number,
    itemIndex: number,
    itemText: string,
    event?: unknown,
  ): void => {
    const carrier = event as {
      preventDefault?: () => void;
      nativeEvent?: { metaKey?: boolean; ctrlKey?: boolean };
    } | undefined;
    const native = event === undefined || event === null ? undefined : carrier?.nativeEvent;
    if (layout.platform === "web") {
      if (native?.metaKey || native?.ctrlKey) {
        carrier?.preventDefault?.();
        setEditing({
          paragraphIndex: chunkIndex,
          itemIndex,
          paragraphText: itemText,
          draft: "",
        });
      }
      return;
    }
    handleChunkTap(chunkIndex, itemIndex, itemText);
  }, [handleChunkTap, layout.platform]);

  const handleLocalFilePress = useCallback((target: LocalFileTarget): void => {
    // Desktop and tablets (iPad): open the review panel tab with the file
    // preview — the panel is the large surface (the host sheet caps at
    // 520px with no size escape). Phones get the host bottom sheet.
    if (layout.platform === "web" || !layout.compact) {
      // The client handle from agents.ref() reads null until a snapshot
      // arrives; useAgent() reads the host-maintained state instead.
      const workspaceId = agentWorkspaceId;
      if (workspaceId) {
        openFileTab(target.path, target.lineStart, target.lineEnd, workspaceId, agentId);
        return;
      }
    }
    // Mobile: content preview in the host bottom sheet, which offers the
    // explicit "open on the agent machine" action.
    void openLocalFile({
      path: target.path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
      mode: "read",
    }).then((result) => {
      if (!result.ok) {
        toast.error(result.error ?? "Could not open the file.");
        return;
      }
      if (result.mimeType) {
        setFilePreview({
          kind: "image",
          path: target.path,
          dataUri: result.base64 ? `data:${result.mimeType};base64,${result.base64}` : undefined,
          mimeType: result.mimeType,
          size: result.size ?? 0,
          lineStart: target.lineStart,
          lineEnd: target.lineEnd,
        });
        return;
      }
      if (result.binary) {
        toast.show(`Binary file${result.size ? ` (${result.size} bytes)` : ""} — nothing to preview. Use "Open locally" instead.`);
        return;
      }
      setFilePreview({
        kind: "text",
        path: target.path,
        content: result.content ?? "",
        truncated: result.truncated ?? false,
        size: result.size ?? 0,
        lineStart: target.lineStart,
        lineEnd: target.lineEnd,
      });
    }).catch(() => {
      toast.error("Could not open the file.");
    });
  }, [agentId, agentWorkspaceId, layout.compact, layout.platform, openLocalFile, toast]);

  function openFileOnAgentMachine(): void {
    if (!filePreview) return;
    void openLocalFile({ path: filePreview.path, mode: "open" }).then((result) => {
      if (result.ok) {
        toast.show("Opened on the agent machine.", { variant: "success" });
      } else {
        toast.error(result.error ?? "Could not open the file.");
      }
    }).catch(() => {
      toast.error("Could not open the file.");
    });
  }

  /** Streams the previewed file to a user-selected destination, 5 MB at a time. */
  function downloadPreviewedFile(): void {
    if (!filePreview) return;
    void downloadLocalFileProgressively({
      path: filePreview.path,
      openFile: openLocalFile,
      chunkBytes: layout.compact ? COMPACT_FILE_TRANSFER_CHUNK_BYTES : DESKTOP_FILE_TRANSFER_CHUNK_BYTES,
    }).then((size) => {
      toast.show(`Downloaded ${formatFileSize(size)}.`);
    }).catch((error) => {
      if (!(error instanceof DownloadCancelledError)) {
        toast.error(error instanceof Error ? error.message : "Could not download the file.");
      }
    });
  }

  /** Moves the sheet preview into its own file tab (leaves it open). */
  function openFileInPanel(): void {
    if (!filePreview) return;
    const workspaceId = agentWorkspaceId;
    if (!workspaceId) {
      toast.error("The panel is not available right now.");
      return;
    }
    openFileTab(filePreview.path, filePreview.lineStart, filePreview.lineEnd, workspaceId, agentId);
    setFilePreview(null);
  }

  function save() {
    if (!editing || editing.draft.trim().length === 0) {
      setEditing(null);
      return;
    }
    if (editing.commentId) {
      updateComment(editing.commentId, editing.draft);
    } else {
      addComment({
        agentId,
        messageId: data.messageId,
        paragraphIndex: editing.paragraphIndex,
        itemIndex: editing.itemIndex ?? null,
        codeAnchor: editing.codeAnchor ?? null,
        paragraphText: editing.paragraphText,
        text: editing.draft.trim(),
        sourceKey: data.messageId === null ? sourceKey : null,
      });
    }
    setEditing(null);
  }

  // The inline editor renders either at chunk level (paragraph comments) or
  // inside the tapped list item (per-item comments).
  const editorNode = editing ? (
    <View ref={editorRef} style={styles.editor}>
      {editing.codeAnchor ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {`Code block ${editing.codeAnchor.blockIndex + 1} \u00b7 line ${editing.codeAnchor.lineIndex + 1}`}
        </Text>
      ) : null}
      <TextInput
        value={editing.draft}
        onChangeText={(draft) => setEditing({ ...editing, draft })}
        placeholder="Write your comment about this passage..."
        multiline
        autoFocus
        onKeyPress={(event) => {
          // Platform+Return saves; plain Return inserts a newline.
          const native = event.nativeEvent as unknown as {
            key?: string;
            metaKey?: boolean;
            ctrlKey?: boolean;
          };
          if (native.key === "Enter" && (native.metaKey || native.ctrlKey)) {
            event.preventDefault?.();
            save();
          }
          if (native.key === "Escape") {
            event.preventDefault?.();
            setEditing(null);
          }
        }}
        style={styles.input}
      />
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Save comment" style={styles.save} onPress={save}>
          <Text style={styles.saveText}>{editing.commentId ? "Update" : "Save"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel comment" style={styles.cancel} onPress={() => setEditing(null)}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  return (
    <>
      {ownsWideFrameController ? <WideFrameController theme={theme} layout={layout} /> : null}
      <FinalCardShell
        style={styles.root}
        timestamp={timestamp}
        text={finalCardText}
        theme={theme}
        platform={layout.platform}
        hoverKey={finalCardHoverKey}
      >
      {paragraphs.map((paragraph, index) => (
        <ReviewParagraph
          key={index}
          paragraph={paragraph}
          index={index}
          messageId={data.messageId}
          phase={data.phase}
          sourceKey={sourceKey}
          theme={theme}
          compact={layout.compact}
          platform={layout.platform}
          refs={refs}
          workspaceRoot={workspaceRoot}
          comments={comments}
          editing={editing?.paragraphIndex === index ? editing : null}
          editorNode={editing?.paragraphIndex === index ? editorNode : null}
          commentsStyle={styles.comments}
          onSetEditing={setEditing}
          onChunkTap={handleChunkTap}
          onListItemTap={handleListItemTap}
          onLocalFilePress={handleLocalFilePress}
        />
      ))}
      {finalCardPosition === "start" || finalCardPosition === "middle" ? (
        <View pointerEvents="none" style={styles.cardBridge} />
      ) : null}
      {layout.platform === "web" ? (
        filePreview ? (
          <WebFilePreviewOverlay
            filePreview={filePreview}
            theme={theme}
            compact={layout.compact}
            onClose={() => setFilePreview(null)}
            onOpenLocally={openFileOnAgentMachine}
            onDownload={downloadPreviewedFile}
          />
        ) : null
      ) : (
        <Modal
          title="File preview"
          icon={<Icon name="FileText" size={14} color={theme.colors.accent} />}
          open={filePreview !== null}
          onOpenChange={(open) => {
            if (!open) setFilePreview(null);
          }}
        >
          <Modal.Content
            scrollable={false}
            style={{ flex: 1, padding: 4, gap: 4 }}
            contentContainerStyle={{ flex: 1, padding: 4, gap: 4 }}
          >
            {filePreview ? (
              <View style={{ flex: 1, gap: 8 }}>
                <View style={{ gap: 6 }}>
                  {/* Mobile: the full path gets its own line, ellipsized at
                      the start (the tail matters); links sit on their own
                      right-aligned row below. */}
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                    {`${startEllipsis(filePreview.path, 78)}${filePreview.kind === "text" && filePreview.truncated ? " (truncated)" : ""}`}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                  {/* Mobile: the file lives on the agent machine, so no
                      "open locally" or download here — move to the tab. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open the file in the review panel"
                    hitSlop={6}
                    onPress={openFileInPanel}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Open in tab</Text>
                  </Pressable>
                  </View>
                </View>
                {filePreview.kind === "image" ? (
                  filePreview.dataUri ? (
                    <Image
                      source={{ uri: filePreview.dataUri }}
                      style={{ width: "100%", flex: 1 }}
                      resizeMode="contain"
                      accessibilityLabel={`Preview of ${filePreview.path}`}
                    />
                  ) : (
                    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                        {`Image · ${formatFileSize(filePreview.size)} exceeds the 5 MB preview limit.`}
                      </Text>
                    </View>
                  )
                ) : (
                  <FileCodeBlock
                    code={filePreview.content}
                    language={previewLanguage(filePreview.path)}
                    theme={theme}
                    compact={layout.compact}
                    virtualized
                    highlightStart={filePreview.lineStart}
                    highlightEnd={filePreview.lineEnd}
                  />
                )}
              </View>
            ) : null}
          </Modal.Content>
        </Modal>
      )}
      </FinalCardShell>
</>
  );
}

/**
 * Registers the optional web-only wide reading frame.
 * Every host element capped at MAX_CONTENT_WIDTH (820px) — stream items,
 * tool calls, user messages, the composer — is re-capped inline to the
 * timeline pane width minus breathing room, so the conversation uses the
 * available space and stays aligned. Re-applied on a timer to catch new
 * items.
 */
export function registerTimeline(client: PluginClientContext): () => void {
  const cleanups: Array<() => void> = [];
  // Make every renderer available before a transformer can replace a native
  // row. Hosts that publish registrations incrementally never observe a plugin
  // item without the component that draws it.
  cleanups.push(client.addTimelineRenderer({
    kind: "inline-review",
    version: 1,
    schema: reviewItemSchema,
    Component: ReviewAssistantMessage,
  }));
  cleanups.push(client.addTimelineRenderer({
    kind: "inline-review-sent",
    version: 1,
    schema: sentReviewSchema,
    Component: SentReviewCard,
  }));
  cleanups.push(client.addTimelineRenderer({
    kind: "user-message-card",
    version: 1,
    schema: userMessageCardSchema,
    Component: UserMessageCard,
  }));
  cleanups.push(client.addTimelineRenderer({
    kind: "compaction-divider",
    version: 1,
    schema: compactionDividerSchema,
    Component: CompactionDivider,
  }));

  cleanups.push(client.addTimelineTransformer({
    id: "inline-review",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      // Streaming can emit the host's visual separator as its own source row.
      // Removing that formatting-only row at the transformer avoids an empty
      // measured item without discarding any assistant content.
      if (/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(item.text.trim())) {
        return { items: [] };
      }
      return {
        items: [
          {
            type: "plugin",
            kind: "inline-review",
            version: 1,
            data: {
              messageId: item.messageId ?? null,
              text: item.text,
              phase,
            },
          },
        ],
      };
    },
  }));
  // Reviews sent through the panel become a compact review card. Plain user
  // messages keep the host row on web and use the native card below on mobile.
  cleanups.push(client.addTimelineTransformer({
    id: "inline-review-sent",
    query: { itemType: "user_message" },
    transform({ item }) {
      if (looksLikeSentReview(item.text)) {
        return {
          items: [
            {
              type: "plugin",
              kind: "inline-review-sent",
              version: 1,
              data: { messageId: item.messageId ?? null, text: item.text },
            },
          ],
        };
      }
      // Web owns the attachment rail, lightbox, timestamp and actions. Native
      // has no DOM pass, so use the cross-platform card unless the client has
      // supplied host-owned attachment metadata that must stay native.
      if (Platform.OS === "web" || userMessageHasHostAttachments(item)) return undefined;
      return {
        items: [
          {
            type: "plugin",
            kind: "user-message-card",
            version: 1,
            data: { messageId: item.messageId ?? null, text: item.text },
          },
        ],
      };
    },
  }));
  // Compaction divider: same "Context compacted" marker but with dotted
  // side lines instead of the host's continuous hairline.
  cleanups.push(client.addTimelineTransformer({
    id: "inline-review-compaction",
    query: { itemType: "compaction" },
    transform({ item }) {
      return {
        items: [
          {
            type: "plugin",
            kind: "compaction-divider",
            version: 1,
            data: {
              status: item.status,
              trigger: item.trigger ?? null,
              preTokens: typeof item.preTokens === "number" ? item.preTokens : null,
            },
          },
        ],
      };
    },
  }));
  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
