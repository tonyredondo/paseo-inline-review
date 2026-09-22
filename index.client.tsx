import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FilePreviewPanel, ReviewPanel } from "./client/panel";
import {
  clearPreview,
  getPreviewTarget,
  registerFileTabOpener,
  requestPreview,
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
  // at once. The least-recently-used registration is removed when too many
  // pile up; a new id prevents another agent's open tab changing in place.
  const previewPanels = new Map<string, PluginCleanup>();
  const previewOrder: string[] = [];
  const MAX_FILE_TABS = 6;
  let nextPreviewId = 1;

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

  function unregisterPreviewPanel(id: string): void {
    previewPanels.get(id)?.();
    previewPanels.delete(id);
    const orderIndex = previewOrder.indexOf(id);
    if (orderIndex >= 0) previewOrder.splice(orderIndex, 1);
    clearPreview(id);
  }

  const unregisterFileTabOpener = registerFileTabOpener((path, lineStart, lineEnd, workspaceId, agentId) => {
    // Reuse only a tab owned by the same agent/workspace. Moving it to the
    // end makes the bounded list a real least-recently-used queue.
    const existing = [...previewPanels.keys()].find(
      (id) => {
        const target = getPreviewTarget(id);
        return target?.path === path && target.workspaceId === workspaceId && target.agentId === agentId;
      },
    );
    if (existing) {
      const index = previewOrder.indexOf(existing);
      if (index >= 0) previewOrder.splice(index, 1);
      previewOrder.push(existing);
      requestPreview(path, workspaceId, agentId, lineStart, lineEnd, existing);
      client.openPanel(existing, { workspaceId, agentId });
      return;
    }

    if (previewOrder.length >= MAX_FILE_TABS) {
      const evicted = previewOrder[0];
      if (evicted) unregisterPreviewPanel(evicted);
    }
    const id = `file-preview-${nextPreviewId++}`;
    previewOrder.push(id);
    const { target } = requestPreview(path, workspaceId, agentId, lineStart, lineEnd, id);
    registerPreviewPanel(id, target.path.split("/").pop() ?? "File preview");
    client.openPanel(id, { workspaceId, agentId });
  });

  registerTimeline(client);
  const removePills = registerPills(client);
  return async () => {
    unregisterFileTabOpener();
    panelRegistration?.();
    panelRegistration = null;
    for (const [id, remove] of previewPanels) {
      remove();
      clearPreview(id);
    }
    previewPanels.clear();
    previewOrder.length = 0;
    await removePills();
  };
}
