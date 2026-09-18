import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Modal,
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

type EditingTarget = {
  paragraphIndex: number;
  paragraphText: string;
  draft: string;
};

function commentBelongsToMessage(data: ReviewItemData, comment: ReviewComment): boolean {
  if (comment.messageId !== null) return comment.messageId === data.messageId;
  // Unknown message id: fall back to the paragraph snapshot being a prefix of the
  // message text. Streaming only appends, so the snapshot stays a prefix.
  return data.text.includes(comment.paragraphText);
}

function useMessageComments(agentId: string, data: ReviewItemData) {
  const all = useSyncExternalStore(subscribe, getComments);
  return useMemo(
    () => all.filter((comment) => comment.agentId === agentId && commentBelongsToMessage(data, comment)),
    // data.text changes while streaming; recompute so orphan recovery stays correct.
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
      paragraph: { color: theme.colors.foreground, fontSize: layout.compact ? 14 : 15, lineHeight: 22 } as const,
      hint: { color: theme.colors.foregroundMuted, fontSize: 11 } as const,
      comments: { gap: 4, marginTop: 2 } as const,
      quote: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" } as const,
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
        const anchored = comments.filter(
          (comment) =>
            comment.paragraphIndex === index &&
            // Accept prefix matches: comments saved mid-stream snapshot a shorter paragraph.
            (comment.messageId === data.messageId || paragraph.startsWith(comment.paragraphText)),
        );
        return (
          <View key={`${index}-${paragraph.slice(0, 24)}`} style={styles.comments}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Comment on paragraph ${index + 1}`}
              onPress={() =>
                setEditing({ paragraphIndex: index, paragraphText: paragraph, draft: "" })
              }
            >
              <Text style={styles.paragraph}>{paragraph}</Text>
            </Pressable>
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
      <Text style={styles.hint}>
        Tap a paragraph to comment on it.{" "}
        {comments.length > 0 ? `${comments.length} comment(s) on this response.` : ""}
      </Text>
      <Modal title="Comment on paragraph" open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <Modal.Content>
          {editing !== null && (
            <View style={{ gap: 10 }}>
              <Text style={styles.quote}>"{editing.paragraphText.slice(0, 200)}"</Text>
              <TextInput
                value={editing.draft}
                onChangeText={(draft) => setEditing({ ...editing, draft })}
                placeholder="Write your comment about this passage..."
                multiline
                style={styles.input}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Save comment" style={styles.save} onPress={save}>
                <Text style={styles.saveText}>Save comment</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel comment" style={styles.cancel} onPress={() => setEditing(null)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </Modal.Content>
      </Modal>
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
