import type { PluginClientContext } from "@getpaseo/plugin/client";

import { formatReview, saveCommentDeltaRpc, syncCommentsRpc } from "../shared/review";
import {
  clearAgent,
  getComments,
  hasPendingSaves,
  hydrate,
  markCommentsSent,
  persistAgentNow,
  registerPersist,
  subscribe,
  subscribePersistence,
} from "./review-store";
import { createCommentSyncController } from "./comment-sync";
import { AppState } from "react-native";
import { createCommentDeltaAdapter } from "./comment-delta";

type PillHandle = { remove(): void; update(patch: { label?: string; disabled?: boolean }): void };

/**
 * Adds two composer pills per agent:
 * - "Review (n)": opens the review panel;
 * - "Send Review (n)": fastpath that sends the pending comments directly.
 * Both labels track the pending count; the send pill disables itself at zero.
 */
export function registerPills(client: PluginClientContext): () => Promise<void> {
  const pills = new Map<string, PillHandle>();
  const sendPills = new Map<string, PillHandle>();
  const sendingAgents = new Set<string>();
  let disposed = false;

  // Store-owned persistence: every mutation saves through the client context,
  // so sent statuses reach the daemon even when the panel is not open.
  const delta = createCommentDeltaAdapter((input) => client.rpc(saveCommentDeltaRpc, input));
  const unregisterPersist = registerPersist((input) => delta.save(input));

  // Plugin data has no push channel. One revision-aware request refreshes all
  // agent pills without the previous per-agent five-second RPC burst.
  const commentSync = createCommentSyncController({
    sync: (input) => client.rpc(syncCommentsRpc, input),
    hydrate(agentId, comments, deleted) {
      delta.seed(agentId, comments, deleted);
      hydrate(agentId, comments, deleted);
    },
    hasPendingSaves,
  });
  commentSync.setActive(AppState.currentState === "active");
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    commentSync.setActive(state === "active");
  });
  const unsubscribePersistence = subscribePersistence((agentId, pending) => {
    if (!pending) commentSync.notifySaveSettled(agentId);
  });

  function refreshLabels(): void {
    const counts = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const comment of getComments()) {
      totals.set(comment.agentId, (totals.get(comment.agentId) ?? 0) + 1);
      if (comment.status !== "pending") continue;
      counts.set(comment.agentId, (counts.get(comment.agentId) ?? 0) + 1);
    }
    for (const [agentId, pill] of pills) {
      const count = counts.get(agentId) ?? 0;
      // The panel opens empty when the agent has no comments at all; disable
      // the pill in that case, like the send pill.
      pill.update({
        label: count > 0 ? `Review (${count})` : "Review",
        disabled: (totals.get(agentId) ?? 0) === 0,
      });
    }
    for (const [agentId, pill] of sendPills) {
      const count = counts.get(agentId) ?? 0;
      pill.update({
        label: count > 0 ? `Send Review (${count})` : "Send Review",
        disabled: count === 0,
      });
    }
  }

  function registerFor(agentId: string, workspaceId: string): void {
    if (disposed || pills.has(agentId)) return;
    commentSync.addAgent(agentId);
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        workspaceId,
        agentId,
        button: {
          // No SDK tooltip field; the title doubles as the hover tooltip on
          // desktop and the accessibility label everywhere.
          title: "Add a review: Cmd+Click a paragraph or code line on desktop; double-tap a paragraph on mobile or tablet",
          icon: "MessageSquareQuote",
          label: "Review",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("review", { workspaceId, agentId });
            },
          },
        },
      }),
    );
    sendPills.set(
      agentId,
      client.addComposerPill({
        id: "review-send",
        workspaceId,
        agentId,
        button: {
          title: "Send pending review comments",
          icon: "Send",
          label: "Send Review",
          disabled: true,
          behavior: {
            kind: "action",
            async onPress() {
              if (sendingAgents.has(agentId)) return;
              const pending = getComments().filter(
                (comment) => comment.agentId === agentId && comment.status === "pending",
              );
              if (pending.length === 0) return;
              sendingAgents.add(agentId);
              let sent = false;
              try {
                await client.paseo.agents.ref(agentId).send(formatReview(pending));
                sent = true;
                markCommentsSent(pending);
                await persistAgentNow(agentId);
              } catch (error) {
                if (sent) {
                  throw new Error("Review was sent, but its status could not be saved", { cause: error });
                }
                throw error;
              } finally {
                sendingAgents.delete(agentId);
              }
            },
          },
        },
      }),
    );
  }

  const unsubscribeComments = subscribe(refreshLabels);

  // Seed pills for agents that already existed before this subscription; the
  // agent_update stream may only carry future changes.
  void client.paseo.agents
    .list()
    .then((result) => {
      if (disposed) return;
      for (const entry of result.entries) {
        const agent = entry.agent;
        if (agent.workspaceId) registerFor(agent.id, agent.workspaceId);
      }
      commentSync.start();
      void commentSync.refresh();
      refreshLabels();
    })
    .catch(() => {});

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (disposed) return;
    if (update.kind === "remove") {
      pills.get(update.agentId)?.remove();
      pills.delete(update.agentId);
      sendPills.get(update.agentId)?.remove();
      sendPills.delete(update.agentId);
      commentSync.removeAgent(update.agentId);
      delta.clear(update.agentId);
      clearAgent(update.agentId);
      return;
    }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    if (pills.has(agentId)) return;
    registerFor(agentId, workspaceId);
    void commentSync.refresh();
    refreshLabels();
  });

  return async () => {
    disposed = true;
    appStateSubscription.remove();
    unsubscribePersistence();
    commentSync.stop();
    unsubscribeComments();
    unsubscribeAgents();
    for (const pill of pills.values()) pill.remove();
    for (const pill of sendPills.values()) pill.remove();
    pills.clear();
    sendPills.clear();
    await unregisterPersist();
  };
}
