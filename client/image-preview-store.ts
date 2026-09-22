export type ThumbnailResult = {
  ok: boolean;
  error?: string;
  fileVersion?: string;
  mimeType?: string;
  base64?: string;
  thumbnailSize?: number;
  unchanged?: boolean;
};

export type ThumbnailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string; fileVersion: string; bytes: number }
  | { status: "error"; message: string };

type Loader = (input: {
  path: string;
  maxEdge: number;
  quality: number;
  knownFileVersion?: string;
}) => Promise<ThumbnailResult>;

type Entry = {
  state: ThumbnailState;
  ready: Extract<ThumbnailState, { status: "ready" }> | null;
  listeners: Set<(state: ThumbnailState) => void>;
  interests: number;
  loader: Loader;
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  running: boolean;
  touchedAt: number;
  loadedAt: number;
};

export function createImagePreviewStore({
  concurrency = 2,
  maxEntries = 96,
  maxBytes = 16 * 1024 * 1024,
  cacheTtlMs = 60_000,
  mountDelayMs = 80,
  now = Date.now,
  schedule = (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: {
  concurrency?: number;
  maxEntries?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
  mountDelayMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}) {
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  let active = 0;
  let disposed = false;
  let cachedBytes = 0;
  let hits = 0;
  let misses = 0;
  let maxActive = 0;

  function bytesOf(state: ThumbnailState): number {
    return state.status === "ready" ? state.bytes : 0;
  }

  function publish(entry: Entry, state: ThumbnailState): void {
    cachedBytes -= bytesOf(entry.state);
    entry.state = state;
    if (state.status === "ready") {
      entry.ready = state;
      entry.loadedAt = now();
    }
    cachedBytes += bytesOf(state);
    entry.touchedAt = now();
    if (entry.interests > 0) {
      for (const listener of entry.listeners) listener(state);
    }
    evict();
  }

  function evict(): void {
    if (entries.size <= maxEntries && cachedBytes <= maxBytes) return;
    for (const [path, entry] of entries) {
      if (entry.interests > 0 || entry.running || entry.queued) continue;
      entries.delete(path);
      cachedBytes -= bytesOf(entry.state);
      if (entries.size <= maxEntries && cachedBytes <= maxBytes) break;
    }
  }

  function enqueue(path: string, force = false): void {
    const entry = entries.get(path);
    if (!entry || disposed || entry.running || entry.queued || entry.interests === 0) return;
    if (!force && entry.ready && now() - entry.loadedAt < cacheTtlMs) {
      hits += 1;
      publish(entry, entry.ready);
      return;
    }
    misses += 1;
    entry.queued = true;
    publish(entry, { status: "loading" });
    queue.push(path);
    drain();
  }

  function drain(): void {
    while (!disposed && active < concurrency && queue.length > 0) {
      const path = queue.shift()!;
      const entry = entries.get(path);
      if (!entry) continue;
      entry.queued = false;
      if (entry.interests === 0) continue;
      entry.running = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const knownFileVersion = entry.ready?.fileVersion;
      void entry.loader({ path, maxEdge: 640, quality: 78, knownFileVersion })
        .then((result) => {
          if (disposed) return;
          if (result.ok && result.unchanged && entry.ready) {
            publish(entry, entry.ready);
            return;
          }
          if (!result.ok || !result.mimeType || !result.base64 || !result.fileVersion) {
            publish(entry, { status: "error", message: result.error ?? "Could not load the image" });
            return;
          }
          publish(entry, {
            status: "ready",
            dataUri: `data:${result.mimeType};base64,${result.base64}`,
            fileVersion: result.fileVersion,
            bytes: result.thumbnailSize ?? Math.ceil(result.base64.length * 0.75),
          });
        })
        .catch(() => {
          if (!disposed) publish(entry, { status: "error", message: "Could not load the image" });
        })
        .finally(() => {
          entry.running = false;
          active -= 1;
          drain();
        });
    }
  }

  function retain(
    path: string,
    loader: Loader,
    listener: (state: ThumbnailState) => void,
  ): () => void {
    if (disposed) return () => {};
    let entry = entries.get(path);
    if (!entry) {
      entry = {
        state: { status: "idle" }, ready: null, listeners: new Set(), interests: 0, loader,
        timer: null, queued: false, running: false, touchedAt: now(), loadedAt: 0,
      };
      entries.set(path, entry);
    } else {
      entries.delete(path);
      entries.set(path, entry);
      entry.loader = loader;
    }
    entry.interests += 1;
    entry.listeners.add(listener);
    entry.touchedAt = now();
    listener(entry.state);
    if (entry.state.status === "idle" || entry.state.status === "error" || !entry.ready || now() - entry.loadedAt >= cacheTtlMs) {
      if (!entry.timer) {
        entry.timer = schedule(() => {
          entry!.timer = null;
          enqueue(path);
        }, mountDelayMs);
      }
    } else {
      hits += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = entries.get(path);
      if (!current) return;
      current.listeners.delete(listener);
      current.interests = Math.max(0, current.interests - 1);
      if (current.interests === 0 && current.timer) {
        cancel(current.timer);
        current.timer = null;
      }
      evict();
    };
  }

  function retry(path: string): void {
    const entry = entries.get(path);
    if (!entry) return;
    enqueue(path, true);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    queue.length = 0;
    for (const entry of entries.values()) {
      if (entry.timer) cancel(entry.timer);
      entry.timer = null;
      entry.listeners.clear();
    }
    entries.clear();
    cachedBytes = 0;
  }

  return {
    retain,
    retry,
    dispose,
    diagnostics: () => ({ active, queued: queue.length, entries: entries.size, cachedBytes, hits, misses, maxActive }),
  };
}

let defaultStore = createImagePreviewStore();

export function retainImagePreview(
  path: string,
  loader: Loader,
  listener: (state: ThumbnailState) => void,
): () => void {
  return defaultStore.retain(path, loader, listener);
}

export function retryImagePreview(path: string): void {
  defaultStore.retry(path);
}

export function disposeImagePreviews(): void {
  defaultStore.dispose();
  defaultStore = createImagePreviewStore();
}
