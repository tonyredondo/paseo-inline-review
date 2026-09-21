import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { loadCommentsRpc, openLocalFileRpc, previewLanguage, saveCommentsRpc, setActiveAgentRpc } from "../shared/review";
import { formatReview, type ReviewComment } from "../shared/review";
import {
  clearAgent,
  getComments,
  hydrateFromServer,
  markAgentCommentsSent,
  registerPersist,
  removeComment,
  scheduleSave,
  subscribe,
  updateComment,
} from "./review-store";
import {
  clearPreview,
  getPreviewTarget,
  subscribe as subscribePreview,
} from "./preview-store";
import { FileCodeBlock } from "./markdown";

/** Converts #rrggbb to rgba() so borders can fade without losing hue. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Cross-device poll: re-hydrate plugin comments from the daemon this often. */
const POLL_INTERVAL_MS = 5000;

/** Mirrors the server's download cap (server/review.ts MAX_DOWNLOAD_BYTES). */
const MAX_DOWNLOAD_TOTAL = 1024 * 1024 * 1024;

/**
 * Full-height file preview shown inside a dedicated panel tab. Created per
 * file tab id so several files can be open at once; reads the target from
 * the preview store.
 */
export function FilePreviewPanel({ panelId, workspaceId, theme, layout }: {
  panelId: string;
  workspaceId: string;
  theme: PluginTheme;
  layout: PluginAgentPanelProps["layout"];
}): ReactNode {
  const target = useSyncExternalStore(subscribePreview, () => getPreviewTarget(panelId));
  if (!target) {
    return <View style={{ flex: 1 }} />;
  }
  return (
    <PanelFilePreview
      workspaceId={workspaceId}
      target={target}
      theme={theme}
      layout={layout}
      panelId={panelId}
    />
  );
}

/** Full-height file preview shown inside the panel tab (desktop). */
function PanelFilePreview({
  workspaceId,
  target,
  theme,
  layout,
  panelId,
}: {
  workspaceId: string;
  target: { path: string; lineStart?: number; lineEnd?: number; requestId: number };
  theme: PluginTheme;
  layout: PluginAgentPanelProps["layout"];
  panelId: string;
}): ReactNode {
  const openFile = useRpc(openLocalFileRpc);
  const toast = useToast();
  const scrollRef = useRef<ScrollView>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [state, setState] = useState<{
    loading: boolean;
    content?: string;
    truncated?: boolean;
    error?: string;
    binary?: boolean;
    size?: number;
  }>({ loading: true });

  // Auto-scroll to the linked line range once the file content is on screen.
  // Scroll-mode rows are fixed-height (lineHeight 18), so the offset is exact
  // enough; land a couple of lines above the target for context.
  useEffect(() => {
    if (state.loading || !state.content || !target.lineStart) return;
    const y = Math.max(0, (target.lineStart - 3) * 18);
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y, animated: false });
    }, 80);
    return () => clearTimeout(timer);
  }, [state.loading, state.content, target.requestId, target.lineStart]);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    void openFile({
      path: target.path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
      mode: "read",
    })
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.binary) {
          setState({ loading: false, binary: true, truncated: result.truncated ?? false, size: result.size });
        } else if (result.ok) {
          setState({ loading: false, content: result.content ?? "", truncated: result.truncated ?? false });
        } else {
          setState({ loading: false, error: result.error ?? "Could not read the file." });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, error: "Could not read the file." });
      });
    return () => {
      cancelled = true;
    };
  }, [target.requestId, target.path, target.lineStart, target.lineEnd, openFile]);

  const styles = useMemo(
    () => ({
      root: { flex: 1, padding: layout.compact ? 12 : 20, gap: 8, backgroundColor: theme.colors.surface0 } as const,
      header: { flexDirection: "row", alignItems: "center", gap: 8 } as const,
      path: { color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 } as const,
      link: { color: theme.colors.accent, fontSize: 12 } as const,
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 } as const,
      error: { color: theme.colors.statusDanger, fontSize: 12 } as const,
      body: { flex: 1 } as const,
      binaryBox: { gap: 8, paddingVertical: 24, alignItems: "center" } as const,
      downloadButton: {
        backgroundColor: theme.colors.accent,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 8,
      } as const,
    }),
    [theme, layout.compact],
  );

  function formatSize(bytes?: number): string {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
 * Saves the file via a data: URI anchor (desktop/web). The payload arrives
 * in base64 chunks the client requests one by one: no single RPC carries
 * the whole file, so large downloads stay reliable. Chunk sizes are
 * multiples of 3 bytes so independently encoded base64 chunks concatenate
 * into a valid stream.
 */
const DOWNLOAD_CHUNK_BYTES = 786432; // 0.75 MB, divisible by 3

  function download(): void {
    void (async () => {
      const parts: string[] = [];
      let offset = 0;
      let size: number | undefined;
      let last = false;
      for (;;) {
        const result = await openFile({
          path: target.path,
          mode: "download",
          offset,
          length: DOWNLOAD_CHUNK_BYTES,
        });
        if (!result.ok || !result.base64) {
          toast.error(result.error ?? "Could not download the file.");
          return;
        }
        parts.push(result.base64);
        size = result.size ?? size;
        last = result.done ?? true;
        setDownloadProgress(size ? Math.min(1, parts.length * DOWNLOAD_CHUNK_BYTES / size) : null);
        if (last) break;
        offset += DOWNLOAD_CHUNK_BYTES;
        if (offset > MAX_DOWNLOAD_TOTAL) {
          toast.error("File exceeds the download cap.");
          return;
        }
      }
      setDownloadProgress(null);
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
      const name = target.path.split("/").pop() ?? "download";
      const anchor = g.document.createElement("a");
      anchor.href = `data:application/octet-stream;base64,${parts.join("")}`;
      anchor.download = name;
      g.document.body.appendChild(anchor);
      anchor.click?.();
      anchor.remove?.();
      if (size) toast.show(`Downloaded ${formatSize(size)}.`);
    })().catch(() => {
      setDownloadProgress(null);
      toast.error("Could not download the file.");
    });
  }

  function openLocally(): void {
    void openFile({ path: target.path, mode: "open" }).then((result) => {
      if (!result.ok) toast.error(result.error ?? "Could not open the file.");
    }).catch(() => toast.error("Could not open the file."));
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the file preview"
          hitSlop={6}
          onPress={() => clearPreview(panelId)}
        >
          <Text style={styles.link}>✕ Close</Text>
        </Pressable>
        <Text style={styles.path} numberOfLines={2}>
          {`${target.path}${state.truncated ? " (truncated)" : ""}`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open the file on the agent machine"
          hitSlop={6}
          onPress={openLocally}
        >
          <Text style={styles.link}>Open locally</Text>
        </Pressable>
        <Text style={styles.muted}>|</Text>
        {downloadProgress === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Download the file"
            hitSlop={6}
            onPress={download}
          >
            <Text style={styles.link}>Download</Text>
          </Pressable>
        ) : (
          <Text style={styles.muted}>{`${Math.round(downloadProgress * 100)}%`}</Text>
        )}
      </View>
      {state.loading ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : state.error ? (
        <Text style={styles.error}>{state.error}</Text>
      ) : state.binary ? (
        <View style={styles.binaryBox}>
          <Text style={styles.muted}>
            {`Binary file${state.size ? ` · ${formatSize(state.size)}` : ""} — nothing to show as text.`}
          </Text>
          {downloadProgress === null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Download the file"
              onPress={download}
              style={styles.downloadButton}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12 }}>Download</Text>
            </Pressable>
          ) : (
            <Text style={styles.muted}>{`Downloading… ${Math.round(downloadProgress * 100)}%`}</Text>
          )}
        </View>
      ) : (
        <ScrollView ref={scrollRef} style={styles.body} contentContainerStyle={{ padding: 4, gap: 4 }}>
          <FileCodeBlock
            code={state.content ?? ""}
            language={previewLanguage(target.path)}
            theme={theme}
            compact={layout.compact}
            forceShowAll
            highlightStart={target.lineStart}
            highlightEnd={target.lineEnd}
          />
        </ScrollView>
      )}
    </View>
  );
}

export function ReviewPanel({ agentId, workspaceId, theme, layout }: PluginAgentPanelProps) {
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
    // Multi-device: plugin data has no push channel, so poll the daemon.
    // hydrate() merges server statuses over local ones, so this is idempotent.
    const poll = setInterval(() => {
      hydrateFromServer(agentId, load);
    }, POLL_INTERVAL_MS);
    const removeSaveWatcher = subscribe(() => scheduleSave(agentId, persistComments));
    return () => {
      clearInterval(poll);
      unsubscribe?.();
      removeSaveWatcher();
    };
  }, [agentId, load, persistComments, paseo, setActiveAgent]);

  const styles = useMemo(
    () => ({
      root: { flex: 1, padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0 } as const,
      titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } as const,
      titleActions: { flexDirection: "row", alignItems: "center", gap: 14 } as const,
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" } as const,
      clearText: { color: theme.colors.statusDanger, fontSize: 13 } as const,
      markSentText: { color: theme.colors.statusSuccess, fontSize: 13 } as const,
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

  /** Marks every pending comment sent without messaging the agent. */
  function markAllSent(): void {
    markAgentCommentsSent(agentId);
    setEditingId(null);
    toast.show("Marked as sent.", { variant: "success" });
  }

  return (
    <View style={styles.root}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Review ({comments.length})</Text>
        <View style={styles.titleActions}>
          {comments.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Mark all comments as sent" hitSlop={6} onPress={markAllSent}>
              <Text style={styles.markSentText}>Mark all as sent</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Clear comments" hitSlop={6} onPress={clear}>
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        </View>
      </View>
      {all.length === 0 ? (
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
                    : { borderLeftWidth: 3, borderLeftColor: withAlpha(theme.colors.accent, 0.35) },
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
                    {/* Sent comments are part of the conversation: no delete.
                        Re-open first if you really want to remove one. */}
                    {comment.status !== "sent" ? (
                      <Pressable accessibilityRole="button" accessibilityLabel="Delete comment" hitSlop={8} onPress={() => removeComment(comment.id)}>
                        <Text style={styles.remove}>Delete</Text>
                      </Pressable>
                    ) : null}
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
          placeholder="Optional note... (Cmd+Shift+Return to send)"
          multiline
          onKeyPress={(event) => {
            // Cmd/Ctrl+Shift+Return sends the review straight from the note.
            const native = event.nativeEvent as unknown as {
              key?: string;
              metaKey?: boolean;
              ctrlKey?: boolean;
              shiftKey?: boolean;
            };
            if (native.key === "Enter" && (native.metaKey || native.ctrlKey) && native.shiftKey) {
              event.preventDefault?.();
              if (!busy) void send();
            }
          }}
          style={[styles.input, { flex: 1, minHeight: 48 }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Send review to the agent" style={styles.sendButton} disabled={busy} onPress={send}>
          <Text style={styles.sendText}>{busy ? "..." : "Send"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

