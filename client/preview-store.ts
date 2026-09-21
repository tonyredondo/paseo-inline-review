/**
 * Request state for the desktop file preview. Tapping a local-file link in
 * the timeline stores the target here and opens the review panel tab; the
 * panel then shows the file preview until the user goes back to the review.
 * (The host AdaptiveModalSheet caps at 520px wide with no size escape hatch,
 * so the panel is the only large surface a plugin can present.)
 */
type PreviewTarget = {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  /** Monotonic id: re-tapping the same file still re-fetches. */
  requestId: number;
};

let target: PreviewTarget | null = null;
const listeners = new Set<() => void>();
let nextId = 1;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPreviewTarget(): PreviewTarget | null {
  return target;
}

export function requestPreview(path: string, lineStart?: number, lineEnd?: number): void {
  target = { path, lineStart, lineEnd, requestId: nextId };
  nextId += 1;
  emit();
}

/** Returns to the review view (panel "back"). */
export function clearPreview(): void {
  if (target === null) return;
  target = null;
  emit();
}

/**
 * The plugin client context is only handed out at registration time, but a
 * timeline tap needs it later to open the panel. Registration stores the
 * opener here; the timeline component calls it when a file link is tapped.
 */
let openPanelRef: ((workspaceId: string, agentId: string) => void) | null = null;

export function registerPanelOpener(
  opener: (workspaceId: string, agentId: string) => void,
): void {
  openPanelRef = opener;
}

export function openPreviewPanel(workspaceId: string, agentId: string): void {
  openPanelRef?.(workspaceId, agentId);
}
