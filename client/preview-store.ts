/**
 * File-preview tab state. Each opened file gets its own review-panel tab:
 * the timeline stores the target under the tab's id and opens that panel;
 * the panel renders the file until the user closes it.
 * (The host AdaptiveModalSheet caps at 520px wide with no size escape
 * hatch, so plugin panels are the only large file surfaces.)
 */
export type PreviewTarget = {
  path: string;
  workspaceId: string;
  agentId: string;
  lineStart?: number;
  lineEnd?: number;
  /** Monotonic id: re-tapping the same file still re-fetches. */
  requestId: number;
};

const targets = new Map<string, PreviewTarget>();
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

export function getPreviewTarget(panelId: string): PreviewTarget | null {
  return targets.get(panelId) ?? null;
}

/** Stores the target for a file tab and returns the target (with fresh requestId). */
export function requestPreview(
  path: string,
  workspaceId: string,
  agentId: string,
  lineStart?: number,
  lineEnd?: number,
  panelId?: string,
): { panelId: string; target: PreviewTarget } {
  const id = panelId ?? `file-preview-${nextId}`;
  if (panelId === undefined) nextId += 1;
  const target: PreviewTarget = {
    path,
    workspaceId,
    agentId,
    lineStart,
    lineEnd,
    requestId: nextId++,
  };
  targets.set(id, target);
  emit();
  return { panelId: id, target };
}

/** Closes a file tab's preview (panel back / close). */
export function clearPreview(panelId: string): void {
  if (!targets.has(panelId)) return;
  targets.delete(panelId);
  emit();
}

/**
 * The plugin client context is only handed out at registration time, but a
 * timeline tap needs it later to open the panel. Registration stores the
 * opener here; the timeline component calls it when a file link is tapped.
 */
type FileTabOpener = (
  path: string,
  lineStart: number | undefined,
  lineEnd: number | undefined,
  workspaceId: string,
  agentId: string,
) => void;

let openFileTabRef: FileTabOpener | null = null;

export function registerFileTabOpener(opener: FileTabOpener): () => void {
  openFileTabRef = opener;
  return () => {
    if (openFileTabRef === opener) openFileTabRef = null;
  };
}

export function openFileTab(
  path: string,
  lineStart: number | undefined,
  lineEnd: number | undefined,
  workspaceId: string,
  agentId: string,
): void {
  openFileTabRef?.(path, lineStart, lineEnd, workspaceId, agentId);
}
