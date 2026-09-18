import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { copyText, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { formatReview } from "../shared/review";
import { clearAgent, getComments, removeComment, subscribe } from "./review-store";

export function ReviewPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const comments = useSyncExternalStore(subscribe, getComments).filter(
    (comment) => comment.agentId === agentId,
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const styles = useMemo(
    () => ({
      root: { flex: 1, padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0 } as const,
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" } as const,
      empty: { color: theme.colors.foregroundMuted, fontSize: 14 } as const,
      list: { flex: 0 } as const,
      card: {
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        padding: 12,
        gap: 6,
      } as const,
      quote: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" } as const,
      text: { color: theme.colors.foreground, fontSize: 14 } as const,
      remove: { color: theme.colors.statusDanger, fontSize: 12 } as const,
      actions: { gap: 8 } as const,
      primary: { backgroundColor: theme.colors.accent, borderRadius: 10, padding: 12, alignItems: "center" as const } as const,
      primaryText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" } as const,
      secondary: { borderColor: theme.colors.border, borderWidth: 1, borderRadius: 10, padding: 12, alignItems: "center" as const } as const,
      secondaryText: { color: theme.colors.foreground, fontSize: 14 } as const,
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        minHeight: 72,
        textAlignVertical: "top",
      } as const,
    }),
    [theme, layout.compact],
  );

  async function copy() {
    const formatted = formatReview(comments);
    if (formatted.length === 0) {
      toast.error("No hay comentarios todavia.");
      return;
    }
    try {
      await copyText(formatted);
      toast.show("Review copiado. Pegalo en el composer.", { variant: "success" });
    } catch {
      toast.error("No se pudo copiar al portapapeles.");
    }
  }

  async function send() {
    const formatted = formatReview(comments);
    if (formatted.length === 0) {
      toast.error("No hay comentarios que enviar.");
      return;
    }
    const message = draft.trim().length > 0 ? `${draft.trim()}\n\n${formatted}` : formatted;
    setBusy(true);
    try {
      await paseo.agents.ref(agentId).send(message);
      toast.show("Review enviado al agente.", { variant: "success" });
      clearAgent(agentId);
      setDraft("");
    } catch {
      toast.error("No se pudo enviar el review.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Review ({comments.length})</Text>
      {comments.length === 0 ? (
        <Text style={styles.empty}>
          Sin comentarios todavia. Toca un parrafo de una respuesta del agente para comentarlo.
        </Text>
      ) : (
        <ScrollView style={styles.list}>
          <View style={{ gap: 8 }}>
            {comments.map((comment) => (
              <View key={comment.id} style={styles.card}>
                <Text style={styles.quote}>"{comment.paragraphText.slice(0, 160)}"</Text>
                <Text style={styles.text}>{comment.text}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Eliminar comentario" hitSlop={8} onPress={() => removeComment(comment.id)}>
                  <Text style={styles.remove}>Eliminar</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Nota general opcional para acompanar el review..."
        multiline
        style={styles.input}
      />
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Copiar review al composer" style={styles.primary} onPress={copy}>
          <Text style={styles.primaryText}>Copiar al composer</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Enviar review al agente" style={styles.secondary} disabled={busy} onPress={send}>
          <Text style={styles.secondaryText}>{busy ? "Enviando..." : "Enviar al agente"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Limpiar comentarios" style={styles.secondary} onPress={() => clearAgent(agentId)}>
          <Text style={styles.secondaryText}>Limpiar</Text>
        </Pressable>
      </View>
    </View>
  );
}
