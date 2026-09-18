import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  TextInput,
  useRevealedText,
} from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import {
  reviewItemSchema,
  splitParagraphs,
  type ReviewComment,
  type ReviewItemData,
} from "../shared/review";
import { addComment, getComments, removeComment, subscribe } from "./review-store";
import { MarkdownText } from "./markdown";

type EditingTarget = {
  paragraphIndex: number;
  paragraphText: string;
  draft: string;
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
  onRemove,
}: {
  comment: ReviewComment;
  theme: PluginTheme;
  onRemove(): void;
}) {
  const styles = useMemo(
    () => ({
      card: {
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        padding: 8,
        gap: 4,
      } as const,
      header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } as const,
      text: { color: theme.colors.foreground, fontSize: 13 } as const,
      delete: { color: theme.colors.statusDanger, fontSize: 12 } as const,
    }),
    [theme],
  );
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Your comment</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Delete comment" onPress={onRemove} hitSlop={8}>
          <Text style={styles.delete}>Delete</Text>
        </Pressable>
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
  const revealed = useRevealedText(data.text, data.phase);
  const paragraphs = useMemo(() => splitParagraphs(revealed), [revealed]);
  const comments = useMessageComments(agentId, data);
  const [editing, setEditing] = useState<EditingTarget | null>(null);

  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 6 : 8 } as const,
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

  function save() {
    if (!editing || editing.draft.trim().length === 0) {
      setEditing(null);
      return;
    }
    addComment({
      agentId,
      messageId: data.messageId,
      paragraphIndex: editing.paragraphIndex,
      paragraphText: editing.paragraphText,
      text: editing.draft.trim(),
    });
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
            <Pressable
              // Web: keep the text cursor and selectable text; only the
              // modifier click is interactive, so a normal drag selects text.
              style={
                layout.platform === "web"
                  ? ({ cursor: "text", userSelect: "text" } as object)
                  : undefined
              }
              onPress={(event) => {
                // Plain clicks stay free for text selection; only the
                // platform modifier opens the inline comment editor.
                const native = event.nativeEvent as unknown as {
                  metaKey?: boolean;
                  ctrlKey?: boolean;
                };
                if (native.metaKey || native.ctrlKey) {
                  setEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" });
                }
              }}
              // Native fallback: desktop builds are web; use long-press there.
              onLongPress={
                layout.platform !== "web"
                  ? () =>
                      setEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" })
                  : undefined
              }
            >
              <MarkdownText text={paragraph} theme={theme} compact={layout.compact} />
            </Pressable>
            {isEditing && (
              <View style={styles.editor}>
                <TextInput
                  value={editing.draft}
                  onChangeText={(draft) => setEditing({ ...editing, draft })}
                  placeholder="Write your comment about this passage..."
                  multiline
                  autoFocus
                  style={styles.input}
                />
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Save comment" style={styles.save} onPress={save}>
                    <Text style={styles.saveText}>Save</Text>
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
