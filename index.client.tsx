import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewPanel } from "./client/panel";
import { registerPills } from "./client/pills";
import { registerTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "review",
    title: "Review inline",
    icon: "MessageSquareQuote",
    context: "agent",
    Component: ReviewPanel,
  });
  registerTimeline(client);
  const removePills = registerPills(client);
  return () => {
    removePills();
  };
}
