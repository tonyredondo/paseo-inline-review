import type { PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { setActiveAgentRpc } from "../shared/review";
import { clearAgent, getComments, subscribe } from "./review-store";

/**
 * Pill icon that reports its agent as the visible conversation on mount, so
 * the attachment picker scopes to the agent whose composer is on screen.
 */
function makePillIcon(agentId: string) {
  return function PillIcon(props: PluginButtonIconProps) {
    const setActiveAgent = useRpc(setActiveAgentRpc);
    useEffect(() => {
      void setActiveAgent({ agentId }).catch(() => {});
    }, [agentId, setActiveAgent]);
    return <Icon name="MessageSquareQuote" size={props.size} color={props.color} />;
  };
}

/**
 * Adds one composer pill per agent that opens the review panel for that agent,
 * and keeps its label showing the pending comment count.
 */
export function registerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, { remove(): void; update(patch: { label?: string }): void }>();

  function refreshLabels(): void {
    const snapshot = getComments();
    const counts = new Map<string, number>();
    for (const comment of snapshot) {
      if (comment.status !== "pending") continue;
      counts.set(comment.agentId, (counts.get(comment.agentId) ?? 0) + 1);
    }
    for (const [agentId, pill] of pills) {
      const count = counts.get(agentId) ?? 0;
      pill.update({ label: count > 0 ? `Review (${count})` : "Review" });
    }
  }

  const unsubscribeComments = subscribe(refreshLabels);

  // Seed pills for agents that already existed before this subscription; the
  // agent_update stream may only carry future changes.
  void client.paseo.agents
    .list()
    .then((result) => {
      for (const entry of result.entries) {
        const agent = entry.agent;
        if (!agent.workspaceId || pills.has(agent.id)) continue;
        pills.set(
          agent.id,
          client.addComposerPill({
            id: "review",
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            button: {
              title: "Review inline",
              icon: "MessageSquareQuote",
              label: "Review",
              behavior: {
                kind: "action",
                onPress() {
                  client.openPanel("review", {
                    workspaceId: agent.workspaceId!,
                    agentId: agent.id,
                  });
                },
              },
            },
          }),
        );
      }
      refreshLabels();
    })
    .catch(() => {});

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      pills.get(update.agentId)?.remove();
      pills.delete(update.agentId);
      clearAgent(update.agentId);
      return;
    }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    if (pills.has(agentId)) return;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        workspaceId,
        agentId,
        button: {
          title: "Review inline",
          icon: makePillIcon(agentId),
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
    refreshLabels();
  });

  return () => {
    unsubscribeComments();
    unsubscribeAgents();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
