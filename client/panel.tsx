import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { loadCommentsRpc, saveCommentsRpc, setActiveAgentRpc } from "../shared/review";
import { formatReview, type ReviewComment } from "../shared/review";
import {
  clearAgent,
  getComments,
  hydrateFromServer,
  registerPersist,
  removeComment,
  scheduleSave,
  subscribe,
  updateComment,
} from "./review-store";

export function ReviewPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const load = useRpc(loadCommentsRpc);
  const persistComments = useRpc(saveCommentsRpc);
  useEffect(() => {
    registerPersist(persistComments);
  }, [persistComments]);
  const all = useSyncExternalStore(subscribe, getComments).filter(
    (comment) => comment.agentId === agentId,
  );
  const comments = all.filter((comment) => comment.status === "pending");
  const sent = all.filter((comment) => comment.status === "sent");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Refresh from the daemon when it opens, and whenever a new user message
  // arrives (the server marks attached drafts sent on the next user message).
  const setActiveAgent = useRpc(setActiveAgentRpc);
  useEffect(() => {
    void setActiveAgent({ agentId }).catch(() => {});
    hydrateFromServer(agentId, load);
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = paseo.agents.ref(agentId).timeline.subscribe((event) => {
        if (event.event.type !== "timeline") return;
        if (event.event.item.type !== "user_message") return;
        hydrateFromServer(agentId, load);
      });
    } catch {
      // agent subscription unavailable; panel refresh happens on reopen
    }
    const removeSaveWatcher = subscribe(() => scheduleSave(agentId, persistComments));
    return () => {
      unsubscribe?.();
      removeSaveWatcher();
    };
  }, [agentId, load, persistComments, paseo, setActiveAgent]);

  const styles = useMemo(
    () => ({
      root: { flex: 1, padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0 } as const,
      titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } as const,
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" } as const,
      clearText: { color: theme.colors.statusDanger, fontSize: 13 } as const,
      composer: { flexDirection: "row", gap: 8, alignItems: "center" } as const,
      sendButton: { backgroundColor: theme.colors.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 } as const,
      sendText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" } as const,
      label: { color: theme.colors.foregroundMuted, fontSize: 11 } as const,
      reopen: { color: theme.colors.accent, fontSize: 12 } as const,
      empty: { color: theme.colors.foregroundMuted, fontSize: 14 } as const,
      list: { flex: 1 } as const,
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

  function composeMessage(): string {
    const note = draft.trim();
    const formatted = formatReview(comments);
    return note.length > 0 && formatted.length > 0
      ? `${note}\n\n${formatted}`
      : note.length > 0
        ? note
        : formatted;
  }

  function setStatus(comment: ReviewComment, status: "pending" | "sent"): void {
    void persistComments({
      agentId,
      comments: all.map((existing) => (existing.id === comment.id ? { ...existing, status } : existing)),
    });
  }

  async function send() {
    if (comments.length === 0 && draft.trim().length === 0) {
      toast.error("Nothing to send yet.");
      return;
    }
    const message = composeMessage();
    setBusy(true);
    try {
      await paseo.agents.ref(agentId).send(message);
      toast.show("Review sent to the agent.", { variant: "success" });
      // Sent comments stay visible as muted context instead of disappearing.
      const sentIds = new Set(comments.map((comment) => comment.id));
      void persistComments({
        agentId,
        comments: all.map((existing) =>
          sentIds.has(existing.id) ? { ...existing, status: "sent" as const } : existing,
        ),
      });
      setDraft("");
    } catch {
      toast.error("Could not send the review.");
    } finally {
      setBusy(false);
    }
  }

  function clear(): void {
    clearAgent(agentId);
    setDraft("");
    setEditingId(null);
  }

  return (
    <View style={styles.root}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Review ({comments.length})</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Clear comments" hitSlop={6} onPress={clear}>
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      </View>
      {comments.length === 0 ? (
        <Text style={styles.empty}>
          No comments yet. Tap a paragraph on an agent response to comment on it.
        </Text>
      ) : (
        <ScrollView style={styles.list}>
          <View style={{ gap: 8 }}>
            {all.map((comment) => (
              <View
                key={comment.id}
                style={[
                  styles.card,
                  comment.status === "pending"
                    ? { borderLeftWidth: 3, borderLeftColor: theme.colors.accent }
                    : null,
                ]}
              >
                <Text style={styles.label}>
                  {comment.status === "pending"
                    ? "Pending \u00b7 will be attached to your next message"
                    : "Sent \u2713 \u00b7 already part of the conversation"}
                </Text>
                <Text style={styles.quote}>"{comment.paragraphText.slice(0, 160)}"</Text>
                {editingId === comment.id ? (
                  <View style={{ gap: 6 }}>
                    <TextInput
                      value={editDraft}
                      onChangeText={setEditDraft}
                      placeholder="Edit your comment..."
                      multiline
                      autoFocus
                      onKeyPress={(event) => {
                        const native = event.nativeEvent as unknown as {
                          key?: string;
                          metaKey?: boolean;
                          ctrlKey?: boolean;
                        };
                        if (native.key === "Enter" && (native.metaKey || native.ctrlKey)) {
                          event.preventDefault?.();
                          if (editingId) updateComment(editingId, editDraft);
                          setEditingId(null);
                          setEditDraft("");
                        }
                      }}
                      style={styles.input}
                    />
                    <View style={{ flexDirection: "row", gap: 12 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Save edited comment"
                        hitSlop={8}
                        onPress={() => {
                          if (editingId) updateComment(editingId, editDraft);
                          setEditingId(null);
                          setEditDraft("");
                        }}
                      >
                        <Text style={styles.reopen}>Save</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" accessibilityLabel="Cancel comment edit" hitSlop={8} onPress={() => setEditingId(null)}>
                        <Text style={styles.remove}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.text}>{comment.text}</Text>
                )}
                {editingId !== comment.id ? (
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Edit comment" hitSlop={8} onPress={() => { setEditingId(comment.id); setEditDraft(comment.text); }}>
                      <Text style={styles.reopen}>Edit</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel="Delete comment" hitSlop={8} onPress={() => removeComment(comment.id)}>
                      <Text style={styles.remove}>Delete</Text>
                    </Pressable>
                    {comment.status === "sent" ? (
                      <Pressable accessibilityRole="button" accessibilityLabel="Re-open comment" hitSlop={8} onPress={() => setStatus(comment, "pending")}>
                        <Text style={styles.reopen}>Re-open</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Optional note..."
          multiline
          style={[styles.input, { flex: 1, minHeight: 48 }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Send review to the agent" style={styles.sendButton} disabled={busy} onPress={send}>
          <Text style={styles.sendText}>{busy ? "..." : "Send"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
