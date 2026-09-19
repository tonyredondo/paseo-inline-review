import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Icon,
  TextInput,
  useRevealedText,
} from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  loadCommentsRpc,
  reviewItemSchema,
  saveCommentsRpc,
  sentReviewSchema,
  splitParagraphs,
  looksLikeSentReview,
  type ReviewComment,
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
import { MarkdownText } from "./markdown";
import { turnClassifier } from "./turn-classifier";
import { extractRefDefs } from "../shared/markdown-parse";

type EditingTarget = {
  paragraphIndex: number;
  paragraphText: string;
  draft: string;
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
function matchesCapturedText(captured: string, paragraph: string | undefined): boolean {
  if (paragraph === undefined) return false;
  return paragraph === captured || paragraph.startsWith(captured);
}

function commentAnchorsHere(
  data: ReviewItemData,
  paragraph: string,
  index: number,
  comment: ReviewComment,
): boolean {
  if (comment.messageId !== null && comment.messageId !== data.messageId) return false;
  if (comment.paragraphIndex !== index) return false;
  return matchesCapturedText(comment.paragraphText, paragraph);
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
        borderLeftWidth: sent ? 1 : 3,
        borderLeftColor: sent ? theme.colors.border : theme.colors.accent,
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
          <Pressable accessibilityRole="button" accessibilityLabel="Delete comment" onPress={onRemove} hitSlop={6}>
            <Text style={styles.delete}>Delete</Text>
          </Pressable>
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
  const paseo = usePaseo();
  const roleVersion = useSyncExternalStore(
    (listener) => turnClassifier.subscribe(agentId, listener),
    () => turnClassifier.roleVersion(agentId),
  );
  const role = useMemo(
    () => turnClassifier.role(agentId, data.messageId),
    [roleVersion, agentId, data.messageId],
  );
  const [expanded, setExpanded] = useState(false);
  // Classify once per agent: full timeline rebuild + live subscription.
  useEffect(() => {
    void turnClassifier.ensure(paseo, agentId);
  }, [agentId, paseo]);
  // Hydrate persisted comments once per mount, and keep the daemon store in
  // sync (debounced) whenever this agent's comments change.
  useEffect(() => {
    hydrateFromServer(agentId, load);
    return subscribe(() => {
      void scheduleSave(agentId, persistComments);
    });
  }, [agentId, load, persistComments]);
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
  const lastTapRef = useRef<{ index: number; at: number } | null>(null);

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

  function handleChunkTap(chunkIndex: number): void {
    // Touch: a double-tap on the same chunk opens the editor, so single taps
    // and long-presses stay free for scroll and native text selection.
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && last.index === chunkIndex && now - last.at < 350) {
      lastTapRef.current = null;
      setEditing({
        paragraphIndex: chunkIndex,
        paragraphText: paragraphs[chunkIndex] ?? "",
        draft: "",
      });
      return;
    }
    lastTapRef.current = { index: chunkIndex, at: now };
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
        paragraphText: editing.paragraphText,
        text: editing.draft.trim(),
      });
    }
    setEditing(null);
  }

  const isIntermediate = role === "intermediate" && data.phase === "complete";
  const isCollapsed = isIntermediate && !expanded;
  return (
    <View style={[styles.root, isIntermediate ? { opacity: 0.75 } : null]}>
      {isIntermediate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isCollapsed ? "Show intermediate message" : "Collapse intermediate message"}
          onPress={() => setExpanded((value) => !value)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic", flex: 1 }} numberOfLines={1}>
            {`Working note \u00b7 ${data.text.replace(/\s+/g, " ").trim().slice(0, 90)}`}
          </Text>
          <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{isCollapsed ? "Show" : "Hide"}</Text>
        </Pressable>
      ) : null}
      {!isCollapsed ? (
      paragraphs.map((paragraph, index) => {
        const anchored = comments.filter((comment) =>
          commentAnchorsHere(data, paragraph, index, comment),
        );
        const isEditing = editing !== null && editing.paragraphIndex === index;
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
                />
              </View>
            )}
            {isEditing && (
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
            )}
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
      })
      ) : null}
    </View>
  );
}

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
