import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewPanel } from "./client/panel";
import { getPreviewTarget, subscribe as subscribePreview } from "./client/preview-store";
import { registerPills } from "./client/pills";
import { registerTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  // The panel tab title is read live from the plugin registry, so the panel
  // can be re-registered with a new title and the open tab updates at once:
  // "Review summary" for the comment list, the opened file's name while a
  // file preview is on screen.
  let panelRegistration: PluginCleanup | null = null;
  function setPanelTitle(title: string): void {
    panelRegistration?.();
    panelRegistration = client.addWorkspacePanel({
      id: "review",
      title,
      icon: "MessageSquareQuote",
      context: "agent",
      Component: ReviewPanel,
    });
  }
  setPanelTitle("Review summary");

  function syncPanelTitle(): void {
    const target = getPreviewTarget();
    setPanelTitle(target ? target.path.split("/").pop() ?? "File preview" : "Review summary");
  }
  const removePreviewWatcher = subscribePreview(syncPanelTitle);

  registerTimeline(client);
  const removePills = registerPills(client);
  return () => {
    removePreviewWatcher();
    panelRegistration?.();
    panelRegistration = null;
    removePills();
  };
}
