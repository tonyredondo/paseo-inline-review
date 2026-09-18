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

function useMessageComments(agentId: string, data: ReviewItemData) {
  const all = useSyncExternalStore(subscribe, getComments);
  return useMemo(
    () =>
      all.filter(
        (comment) => comment.agentId === agentId && comment.messageId === data.messageId,
      ),
    [all, agentId, data.messageId],
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
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Tu comentario</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Eliminar comentario" onPress={onRemove} hitSlop={8}>
          <Text style={styles.delete}>Eliminar</Text>
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
}: PluginTimelineItemProps<ReviewItemData> & { agentId: string }) {
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
      quote: { color: theme.colors.foregroundMuted, fontSize: 12 } as const,
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
            (data.messageId !== null || comment.paragraphText === paragraph),
        );
        return (
          <View key={`${index}-${paragraph.slice(0, 24)}`} style={styles.comments}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Comentar párrafo ${index + 1}`}
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
        Toca un párrafo para comentarlo. {comments.length > 0 ? `${comments.length} comentario(s) en esta respuesta.` : ""}
      </Text>
      <Modal title="Comentar párrafo" open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <Modal.Content>
          {editing !== null && (
            <View style={{ gap: 10 }}>
              <Text style={styles.quote}>"{editing.paragraphText.slice(0, 200)}"</Text>
              <TextInput
                value={editing.draft}
                onChangeText={(draft) => setEditing({ ...editing, draft })}
                placeholder="Escribe tu comentario sobre este fragmento..."
                multiline
                style={styles.input}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Guardar comentario" style={styles.save} onPress={save}>
                <Text style={styles.saveText}>Guardar comentario</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancelar comentario" style={styles.cancel} onPress={() => setEditing(null)}>
                <Text style={styles.cancelText}>Cancelar</Text>
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
