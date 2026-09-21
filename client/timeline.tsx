import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Icon,
  Modal,
  TextInput,
  useRevealedText,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useAgent, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { classifyLocalFileLink, type LocalFileTarget } from "../shared/markdown-parse";
import { openFileTab, registerFileTabOpener } from "./preview-store";
import { ensureWideFrame, undoWideFrame, wideFrameSettings } from "./wide-frame";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  loadCommentsRpc,
  openLocalFileRpc,
  reviewItemSchema,
  saveCommentsRpc,
  sentReviewSchema,
  splitParagraphs,
  looksLikeSentReview,
  type ReviewComment,
  previewLanguage,
  type ReviewItemData,
  type SentReviewData,
} from "../shared/review";
import {
  addComment,
  getComments,
  hydrateFromServer,
  relocateComment,
  removeComment,
  scheduleSave,
  subscribe,
  updateComment,
} from "./review-store";
import { FileCodeBlock, MarkdownText } from "./markdown";
import { extractRefDefs } from "../shared/markdown-parse";

type EditingTarget = {
  paragraphIndex: number;
  paragraphText: string;
  draft: string;
  /** Set when the target is one markdown list item (per-item comment). */
  itemIndex?: number | null;
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
/** A captured streaming snapshot may be a prefix of the completed paragraph. */
/** Converts #rrggbb to rgba() so borders can fade without losing hue. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * A captured streaming snapshot may be a prefix of the completed paragraph.
 * Prefix matching requires a substantial capture so short quotes cannot steal
 * anchors across messages (exact matches are always accepted).
 */
function matchesCapturedText(captured: string, paragraph: string | undefined): boolean {
  if (paragraph === undefined) return false;
  if (paragraph === captured) return true;
  return captured.length >= 40 && paragraph.startsWith(captured);
}

function commentAnchorsHere(
  data: ReviewItemData,
  paragraph: string,
  index: number,
  comment: ReviewComment,
): boolean {
  // Per-list-item comments render inside their item row, never chunk-level.
  if (comment.itemIndex !== undefined && comment.itemIndex !== null) return false;
  if (comment.messageId !== null && comment.messageId !== data.messageId) return false;
  if (comment.paragraphIndex !== index) return false;
  return matchesCapturedText(comment.paragraphText, paragraph);
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

function commentBelongsToMessage(data: ReviewItemData, comment: ReviewComment): boolean {
  if (comment.messageId !== null) return comment.messageId === data.messageId;
  // Unknown message id (commented while streaming): any message may adopt it;
  // paragraph-text anchoring decides where it actually lives.
  return true;
}

function useMessageComments(agentId: string, data: ReviewItemData) {
  const all = useSyncExternalStore(subscribe, getComments);
  return useMemo(
    () => all.filter((comment) => comment.agentId === agentId && commentBelongsToMessage(data, comment)),
    [all, agentId, data.text, data.messageId],
  );
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
type FilePreviewState = {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  lineStart?: number;
  lineEnd?: number;
};

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
            {`${filePreview.path}${filePreview.truncated ? " (truncated)" : ""}`}
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
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 4, gap: 4 }}>
          <FileCodeBlock
            code={filePreview.content}
            language={previewLanguage(filePreview.path)}
            theme={theme}
            compact={compact}
            forceShowAll
            highlightStart={filePreview.lineStart}
            highlightEnd={filePreview.lineEnd}
          />
        </ScrollView>
      </View>
    </View>
  );
}

function CommentCard({
  comment,
  theme,
  onEdit,
  onRemove,
}: {
  comment: ReviewComment;
  theme: PluginTheme;
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
        <Text style={styles.label}>{sent ? "Your comment \u00b7 sent \u2713" : "Your comment \u00b7 pending"}</Text>
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

/** Parses a formatted review into its optional note and per-paragraph entries. */
function parseSentReview(text: string): { note: string; entries: { quote: string; comment: string }[] } {
  const headerIndex = text.search(/(?:^|\n)Review:\s*\n/);
  const note = headerIndex > 0 ? text.slice(0, headerIndex).trim() : "";
  const body = headerIndex >= 0 ? text.slice(headerIndex).replace(/^(?:\n)?Review:\s*\n/, "") : text;
  const entries: { quote: string; comment: string }[] = [];
  const entryPattern = /\[\d+\] On: "([^"]*)"[^\n]*\nComment: ((?:.|\n)*?)(?=\n\s*\n|\n\[\d+\] On: |$)/g;
  for (const match of body.matchAll(entryPattern)) {
    entries.push({ quote: match[1], comment: match[2].trim() });
  }
  return { note, entries };
}

/** Compact card replacing the raw review text in the timeline. */
function SentReviewCard({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<SentReviewData>) {
  const parsed = useMemo(() => parseSentReview(item.data.text), [item.data.text]);
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
      comment: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 } as const,
    }),
    [theme, parsed.entries.length],
  );
  const count = parsed.entries.length;
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.header}>
        <Icon name="MessageSquareQuote" size={14} color={theme.colors.accent} />
        <Text style={styles.title}>{`Review sent`}</Text>
        <Text style={styles.badge}>{count === 1 ? "1 comment" : `${count} comments`}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{open ? "▼" : "▶"}</Text>
      </Pressable>
      {open || count === 0 ? (
        <View>
          {parsed.note.length > 0 ? <Text style={styles.note}>{parsed.note}</Text> : null}
          {parsed.entries.map((entry, index) => (
            <View key={index} style={[styles.entry, index > 0 ? styles.entryBorder : null]}>
              <Text style={styles.quote} numberOfLines={2}>{`"${entry.quote}"`}</Text>
              <Text style={styles.comment}>{entry.comment}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ReviewAssistantMessage({
  agentId,
  item,
  theme,
  layout,
}: PluginTimelineItemProps<ReviewItemData>) {
  const data = item.data;
  const refs = useMemo(() => extractRefDefs(data.text), [data.text]);
  const load = useRpc(loadCommentsRpc);
  const persistComments = useRpc(saveCommentsRpc);
  const openLocalFile = useRpc(openLocalFileRpc);
  const toast = useToast();
  const paseo = usePaseo();
  const [filePreview, setFilePreview] = useState<{
    path: string;
    content: string;
    truncated: boolean;
    size: number;
    lineStart?: number;
    lineEnd?: number;
  } | null>(null);
  // Wide reading frame (user flag): web only — the DOM pass widens the whole
  // host frame; native platforms (iPad) keep the host's 820px column.
  const wideFrameState = useSettings(wideFrameSettings);
  const wideFrameReady = wideFrameState.status === "ready";
  const wideFrame = wideFrameReady ? wideFrameState.values.wideFrame : false;
  // A read that raced a plugin reload leaves an error state; retry once.
  const wideFrameRetried = useRef(false);
  useEffect(() => {
    if (!wideFrameReady && !wideFrameRetried.current && wideFrameState.status !== "loading") {
      wideFrameRetried.current = true;
      void wideFrameState.reload();
    }
  }, [wideFrameReady, wideFrameState]);
  useEffect(() => {
    if (layout.platform === "web" && wideFrame) ensureWideFrame();
    else undoWideFrame();
  }, [layout.platform, wideFrame]);
  // Host-maintained agent snapshot: agents.ref() reads null until a snapshot
  // arrives, but the host state is always populated.
  const agentWorkspaceId = useAgent(agentId, (agent) => (agent ? agent.workspaceId : null));
  // The workspace root lives on the daemon machine; relative file links
  // resolve against it.
  const workspaceRoot = useMemo(
    () => paseo?.agents?.ref(agentId)?.cwd ?? null,
    [paseo, agentId],
  );
  // Hydrate persisted comments once per mount, and keep the daemon store in
  // sync (debounced) whenever this agent's comments change.
  useEffect(() => {
    hydrateFromServer(agentId, load);
    const handle = paseo?.agents?.ref(agentId);
    if (handle?.cwd === null) void handle.refresh().catch(() => {});
    return subscribe(() => {
      void scheduleSave(agentId, persistComments);
    });
  }, [agentId, load, persistComments, paseo]);
  const revealed = useRevealedText(data.text, data.phase);
  const paragraphs = useMemo(() => splitParagraphs(revealed), [revealed]);
  const paragraphTexts = paragraphs;
  const comments = useMessageComments(agentId, data);
  // Re-anchor streaming-time comments once the complete message exists: bind
  // id-less comments to this message and heal paragraph-index drift caused by
  // re-chunking between the streaming and complete snapshots.
  useEffect(() => {
    if (data.messageId === null) return;
    for (const comment of comments) {
      // Per-item comments anchor by (paragraphIndex, itemIndex): no healing.
      if (comment.itemIndex !== undefined && comment.itemIndex !== null) continue;
      const storedParagraph = paragraphs[comment.paragraphIndex];
      const storedMatches = matchesCapturedText(comment.paragraphText, storedParagraph);
      if (comment.messageId === null || !storedMatches) {
        let index = paragraphs.indexOf(comment.paragraphText);
        if (index === -1) {
          index = paragraphs.findIndex((paragraph) => matchesCapturedText(comment.paragraphText, paragraph));
        }
        if (index !== -1) {
          relocateComment(comment.id, data.messageId, index);
        }
      }
    }
  }, [comments, paragraphs, data.messageId]);
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
    () => ({
      root: { gap: layout.compact ? 6 : 8, paddingBottom: 10 } as const,
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
    }),
    [theme, layout.compact],
  );

  function handleChunkTap(chunkIndex: number, itemIndex: number = -1, itemText: string = ""): void {
    // Touch: a double-tap on the same chunk (or list item) opens the editor, so
    // single taps and long-presses stay free for scroll and native selection.
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && last.index === chunkIndex && last.itemIndex === itemIndex && now - last.at < 350) {
      lastTapRef.current = null;
      setEditing({
        paragraphIndex: chunkIndex,
        itemIndex: itemIndex >= 0 ? itemIndex : null,
        paragraphText: itemIndex >= 0 ? itemText : paragraphs[chunkIndex] ?? "",
        draft: "",
      });
      return;
    }
    lastTapRef.current = { index: chunkIndex, itemIndex, at: now };
  }

  /** List item taps: web opens per-item with Cmd/Ctrl; native uses double-tap. */
  function handleListItemTap(
    chunkIndex: number,
    itemIndex: number,
    itemText: string,
    event?: unknown,
  ): void {
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
  }

  function handleLocalFilePress(target: LocalFileTarget): void {
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
      if (result.binary) {
        toast.show(`Binary file${result.size ? ` (${result.size} bytes)` : ""} — nothing to preview. Use "Open locally" instead.`);
        return;
      }
      setFilePreview({
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
  }

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

  /** Saves the previewed file via chunked base64 + a data: URI anchor (web). */
  function downloadPreviewedFile(): void {
    if (!filePreview) return;
    void (async () => {
      const CHUNK = 786432; // 0.75 MB, divisible by 3 so chunk base64s concatenate
      const parts: string[] = [];
      let offset = 0;
      let last = false;
      let size: number | undefined;
      for (;;) {
        const result = await openLocalFile({
          path: filePreview.path,
          mode: "download",
          offset,
          length: CHUNK,
        });
        if (!result.ok || !result.base64) {
          toast.error(result.error ?? "Could not download the file.");
          return;
        }
        parts.push(result.base64);
        size = result.size ?? size;
        last = result.done ?? true;
        if (last) break;
        offset += CHUNK;
      }
      const g = globalThis as unknown as {
        document?: {
          createElement(tag: string): { href?: string; download?: string; click?(): void; remove?(): void };
          body?: { appendChild(node: unknown): void; removeChild(node: unknown): void };
        };
      };
      if (!g.document?.body) {
        toast.error("Download is only available on desktop.");
        return;
      }
      const name = filePreview.path.split("/").pop() ?? "download";
      const anchor = g.document.createElement("a");
      anchor.href = `data:application/octet-stream;base64,${parts.join("")}`;
      anchor.download = name;
      g.document.body.appendChild(anchor);
      anchor.click?.();
      anchor.remove?.();
      if (size) toast.show(`Downloaded ${size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`}.`);
    })().catch(() => toast.error("Could not download the file."));
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
        paragraphText: editing.paragraphText,
        text: editing.draft.trim(),
      });
    }
    setEditing(null);
  }

  // The inline editor renders either at chunk level (paragraph comments) or
  // inside the tapped list item (per-item comments).
  const editorNode = editing ? (
    <View ref={editorRef} style={styles.editor}>
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
      <View testID="inline-review-root" style={styles.root}>
      {paragraphs.map((paragraph, index) => {
        const anchored = comments.filter((comment) =>
          commentAnchorsHere(data, paragraph, index, comment),
        );
        const isEditing = editing !== null && editing.paragraphIndex === index;
        const itemEditing = isEditing && editing.itemIndex !== null && editing.itemIndex !== undefined;
        return (
          <View key={index} style={styles.comments}>
            {layout.platform === "web" ? (
              <Pressable
                // Web: keep the text cursor and selectable text; only the
                // platform modifier opens the inline comment editor, so a
                // normal drag selects text.
                style={{ cursor: "text", userSelect: "text" } as object}
                onPress={(event) => {
                  const native = event.nativeEvent as unknown as {
                    metaKey?: boolean;
                    ctrlKey?: boolean;
                  };
                  if (native.metaKey || native.ctrlKey) {
                    setEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" });
                  }
                }}
              >
                <MarkdownText
                  text={paragraph}
                  theme={theme}
                  compact={layout.compact}
                  refs={refs}
                  onCommentRequest={() => setEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" })}
                  localFileResolver={(url) => classifyLocalFileLink(url, { workspaceRoot })}
                  onLocalFilePress={handleLocalFilePress}
                  onListItemPress={(itemIndex, itemText, event) => handleListItemTap(index, itemIndex, itemText, event)}
                  listItemExtras={(itemIndex) => (
                    <>
                      {editing !== null && editing.paragraphIndex === index && editing.itemIndex === itemIndex ? editorNode : null}
                      {listItemComments(comments, index, itemIndex).map((comment) => (
                        <CommentCard
                          key={comment.id}
                          comment={comment}
                          theme={theme}
                          onEdit={(target) =>
                            setEditing({
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
                  )}
                />
              </Pressable>
            ) : (
              // Native: no Pressable (it cancels text selection). Texts are
              // selectable and the double-tap opens the comment editor.
              <View>
                <MarkdownText
                  text={paragraph}
                  theme={theme}
                  compact={layout.compact}
                  refs={refs}
                  // iOS: RN selectable Text is block-level-only (Copy menu);
                  // disable selection there entirely per user decision.
                  selectable={layout.platform !== "ios"}
                  onChunkPress={() => handleChunkTap(index)}
                  onCommentRequest={() => setEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" })}
                  localFileResolver={(url) => classifyLocalFileLink(url, { workspaceRoot })}
                  onLocalFilePress={handleLocalFilePress}
                  onListItemPress={(itemIndex, itemText, event) => handleListItemTap(index, itemIndex, itemText, event)}
                  listItemExtras={(itemIndex) => (
                    <>
                      {editing !== null && editing.paragraphIndex === index && editing.itemIndex === itemIndex ? editorNode : null}
                      {listItemComments(comments, index, itemIndex).map((comment) => (
                        <CommentCard
                          key={comment.id}
                          comment={comment}
                          theme={theme}
                          onEdit={(target) =>
                            setEditing({
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
                  )}
                />
              </View>
            )}
            {isEditing && !itemEditing ? editorNode : null}
            {anchored.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                theme={theme}
                onEdit={(target) =>
                  setEditing({
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
      })}
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
          <Modal.Content style={{ padding: 4, gap: 4 }} contentContainerStyle={{ padding: 4, gap: 4 }}>
            {filePreview ? (
              <View style={{ gap: 8 }}>
                <View style={{ gap: 6 }}>
                  {/* Mobile: the full path gets its own line, ellipsized at
                      the start (the tail matters); links sit on their own
                      right-aligned row below. */}
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                    {`${startEllipsis(filePreview.path, 78)}${filePreview.truncated ? " (truncated)" : ""}`}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                  {/* Mobile: the file lives on the agent machine, so no
                      "open locally" here — download or move to the tab. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Download the file"
                    hitSlop={6}
                    onPress={downloadPreviewedFile}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Download</Text>
                  </Pressable>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>|</Text>
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
                <FileCodeBlock
                  code={filePreview.content}
                  language={previewLanguage(filePreview.path)}
                  theme={theme}
                  compact={layout.compact}
                  forceShowAll
                  highlightStart={filePreview.lineStart}
                  highlightEnd={filePreview.lineEnd}
                />
              </View>
            ) : null}
          </Modal.Content>
        </Modal>
      )}
      </View>
      </>
  );
}

/**
 * EXPERIMENT (web only, NOT for commit): widen the host's reading frame.
 * Every host element capped at MAX_CONTENT_WIDTH (820px) — stream items,
 * tool calls, user messages, the composer — is re-capped inline to the
 * timeline pane width minus breathing room, so the conversation uses the
 * available space and stays aligned. Re-applied on a timer to catch new
 * items.
 */
export function registerTimeline(client: PluginClientContext): void {
  client.addTimelineTransformer({
    id: "inline-review",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
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
  });
  client.addTimelineRenderer({
    kind: "inline-review",
    version: 1,
    schema: reviewItemSchema,
    Component: ReviewAssistantMessage,
  });
  // Reviews we send through the panel or the fastpath pill become a compact
  // card instead of the plain user bubble. Other user messages stay native.
  client.addTimelineTransformer({
    id: "inline-review-sent",
    query: { itemType: "user_message" },
    transform({ item }) {
      if (!looksLikeSentReview(item.text)) return undefined;
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
    },
  });
  client.addTimelineRenderer({
    kind: "inline-review-sent",
    version: 1,
    schema: sentReviewSchema,
    Component: SentReviewCard,
  });
}
