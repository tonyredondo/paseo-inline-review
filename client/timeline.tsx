import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  TextInput,
  useRevealedText,
} from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import {
  loadCommentsRpc,
  reviewItemSchema,
  saveCommentsRpc,
  splitParagraphs,
  type ReviewComment,
  type ReviewItemData,
} from "../shared/review";
import {
  addComment,
  getComments,
  hydrateFromServer,
  removeComment,
  scheduleSave,
  subscribe,
  updateComment,
} from "./review-store";
import { MarkdownText } from "./markdown";
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
function commentAnchorsHere(
  data: ReviewItemData,
  paragraph: string,
  index: number,
  comment: ReviewComment,
): boolean {
  if (comment.paragraphIndex !== index) return false;
  if (comment.messageId !== null) return comment.messageId === data.messageId;
  return data.messageId === null && comment.paragraphText === paragraph;
}

function commentBelongsToMessage(data: ReviewItemData, comment: ReviewComment): boolean {
  if (comment.messageId !== null) return comment.messageId === data.messageId;
  // Unknown message id: the comment may belong to any id-less message of the
  // agent; paragraph anchoring decides where it renders.
  return data.messageId === null;
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
  const [editing, setEditing] = useState<EditingTarget | null>(null);
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

  return (
    <View style={styles.root}>
      {paragraphs.map((paragraph, index) => {
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
                <MarkdownText text={paragraph} theme={theme} compact={layout.compact} refs={refs} />
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
                  selectable
                  onChunkPress={() => handleChunkTap(index)}
                />
              </View>
            )}
            {isEditing && (
              <View style={styles.editor}>
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
      })}
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
}
