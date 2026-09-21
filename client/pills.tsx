import type { PluginClientContext } from "@getpaseo/plugin/client";

import { formatReview, loadCommentsRpc, saveCommentsRpc } from "../shared/review";
import {
  clearAgent,
  getComments,
  hydrateFromServer,
  markAgentCommentsSent,
  registerPersist,
  subscribe,
} from "./review-store";

type PillHandle = { remove(): void; update(patch: { label?: string; disabled?: boolean }): void };

/**
 * Adds two composer pills per agent:
 * - "Review (n)": opens the review panel;
 * - "Send Review (n)": fastpath that sends the pending comments directly.
 * Both labels track the pending count; the send pill disables itself at zero.
 */
export function registerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PillHandle>();
  const sendPills = new Map<string, PillHandle>();

  // Store-owned persistence: every mutation saves through the client context,
  // so sent statuses reach the daemon even when the panel is not open.
  registerPersist((input) => client.rpc(saveCommentsRpc, input));

  // Plugin data has no push channel, so poll the daemon for comment changes
  // (new comments, status flips, deletions from other devices) while the app
  // is running. hydrate() is idempotent and tombstones stop stale copies.
  const load = (input: { agentId: string }) => client.rpc(loadCommentsRpc, input);
  const poll = setInterval(() => {
    for (const agentId of pills.keys()) hydrateFromServer(agentId, load);
  }, 5000);

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
    if (pills.has(agentId)) return;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        workspaceId,
        agentId,
        button: {
          // No SDK tooltip field; the title doubles as the hover tooltip on
          // desktop and the accessibility label everywhere.
          title: "Add a review: Cmd+Click a paragraph on desktop, double-tap it on mobile or tablet",
          icon: "MessageSquareQuote",
          label: "Review",
          behavior: {
            kind: "action",
            onPress() {
              // Opening the agent panel also reports it as the active agent.
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
            onPress() {
              const pending = getComments().filter(
                (comment) => comment.agentId === agentId && comment.status === "pending",
              );
              if (pending.length === 0) return;
              void client.paseo.agents.ref(agentId)
                .send(formatReview(pending))
                .then(() => {
                  markAgentCommentsSent(agentId);
                  // The store auto-saves on mutation; keep a direct save too so
                  // the status lands on the daemon immediately after a send.
                  void client
                    .rpc(saveCommentsRpc, {
                      agentId,
                      comments: getComments().filter((comment) => comment.agentId === agentId),
                    })
                    .catch(() => {});
                })
                .catch(() => {});
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
      for (const entry of result.entries) {
        const agent = entry.agent;
        if (agent.workspaceId) registerFor(agent.id, agent.workspaceId);
      }
      refreshLabels();
    })
    .catch(() => {});

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      pills.get(update.agentId)?.remove();
      pills.delete(update.agentId);
      sendPills.get(update.agentId)?.remove();
      sendPills.delete(update.agentId);
      clearAgent(update.agentId);
      return;
    }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    if (pills.has(agentId)) return;
    registerFor(agentId, workspaceId);
    refreshLabels();
  });

  return () => {
    clearInterval(poll);
    unsubscribeComments();
    unsubscribeAgents();
    for (const pill of pills.values()) pill.remove();
    for (const pill of sendPills.values()) pill.remove();
    pills.clear();
    sendPills.clear();
  };
}
