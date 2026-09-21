import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FilePreviewPanel, ReviewPanel } from "./client/panel";
import {
  getPreviewTarget,
  registerFileTabOpener,
  requestPreview,
  subscribe as subscribePreview,
} from "./client/preview-store";
import { registerPills } from "./client/pills";
import { registerTimeline } from "./client/timeline";
import { WideFrameSettingsScreen } from "./client/wide-frame-settings";

export default function contribute(client: PluginClientContext) {
  // The panel tab title is read live from the plugin registry, so panels
  // can be re-registered with a new title and open tabs update at once.
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

  client.addSettingsScreen({
    id: "wide-frame",
    title: "Feature flags",
    icon: "ToggleRight",
    Component: WideFrameSettingsScreen,
  });

  // --- File preview tabs -------------------------------------------------
  // Each opened file gets its own panel: a unique id with the file's name
  // as the tab title, so several files and the review summary can be open
  // at once. Panel ids are recycled LRU-style when too many pile up — the
  // tab then swaps its content in place.
  const previewPanels = new Map<string, PluginCleanup>();
  const previewOrder: string[] = [];
  const MAX_FILE_TABS = 6;

  function registerPreviewPanel(id: string, title: string): void {
    previewPanels.get(id)?.();
    previewPanels.set(
      id,
      client.addWorkspacePanel({
        id,
        title,
        icon: "FileText",
        context: "agent",
        Component: (props) => (
          <FilePreviewPanel panelId={id} {...props} />
        ),
      }),
    );
  }

  registerFileTabOpener((path, lineStart, lineEnd, workspaceId, agentId) => {
    // Reuse a tab already showing this file; otherwise the least recently
    // used id (its tab swaps content in place), else a fresh one.
    const existing = [...previewPanels.keys()].find(
      (id) => getPreviewTarget(id)?.path === path,
    );
    let id = existing ?? null;
    if (id === null) {
      if (previewOrder.length >= MAX_FILE_TABS) {
        id = previewOrder.shift() ?? null;
      } else {
        id = `file-preview-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      }
    }
    if (id === null) return;
    if (!previewOrder.includes(id)) previewOrder.push(id);
    const { target } = requestPreview(path, lineStart, lineEnd, id);
    registerPreviewPanel(id, target.path.split("/").pop() ?? "File preview");
    client.openPanel(id, { workspaceId, agentId });
  });

  const syncPreviewTitles = (): void => {
    for (const id of previewPanels.keys()) {
      const target = getPreviewTarget(id);
      const title = target ? target.path.split("/").pop() ?? "File preview" : "File preview";
      registerPreviewPanel(id, title);
    }
  };
  const removePreviewTitleWatcher = subscribePreview(syncPreviewTitles);
  void syncPreviewTitles;

  registerTimeline(client);
  const removePills = registerPills(client);
  return () => {
    removePreviewTitleWatcher();
    panelRegistration?.();
    panelRegistration = null;
    for (const remove of previewPanels.values()) remove();
    previewPanels.clear();
    removePills();
  };
}
