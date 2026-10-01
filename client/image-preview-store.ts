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
  | { status: "ready"; dataUri: string; fileVersion?: string; bytes: number }
  | { status: "error"; message: string };

type Loader = (input: {
  path: string;
  maxEdge: number;
  quality: number;
  knownFileVersion?: string;
}) => Promise<ThumbnailResult>;

export type ThumbnailOptions = {
  autoLoad?: boolean;
  maxEdge?: number;
  quality?: number;
  /** Stable RPC owner; paths on different hosts must never share payloads. */
  scope?: object;
  variant?: string;
};

type Entry = {
  path: string;
  maxEdge: number;
  quality: number;
  state: ThumbnailState;
  ready: Extract<ThumbnailState, { status: "ready" }> | null;
  listeners: Set<(state: ThumbnailState) => void>;
  interests: number;
  loader: Loader;
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  running: boolean;
  force: boolean;
  touchedAt: number;
  loadedAt: number;
};

export function createImagePreviewStore({
  concurrency = 2,
  maxEntries = 96,
  maxBytes = 16 * 1024 * 1024,
  cacheTtlMs = 60_000,
  mountDelayMs = 80,
  requireFileVersion = true,
  keepPreviousOnRefresh = true,
  loadErrorMessage = "Could not load the image",
  now = Date.now,
  schedule = (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: {
  concurrency?: number;
  maxEntries?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
  mountDelayMs?: number;
  requireFileVersion?: boolean;
  keepPreviousOnRefresh?: boolean;
  loadErrorMessage?: string;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}) {
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  const scopes = new WeakMap<object, number>();
  let nextScope = 0;
  let active = 0;
  let disposed = false;
  let cachedBytes = 0;
  let hits = 0;
  let misses = 0;
  let maxActive = 0;

  function entryBytes(entry: Entry): number {
    return entry.ready?.bytes ?? 0;
  }

  function publish(entry: Entry, state: ThumbnailState): void {
    const previousBytes = entryBytes(entry);
    entry.state = state;
    if (state.status === "ready") {
      entry.ready = state;
      entry.loadedAt = now();
    } else if (state.status === "error") {
      entry.ready = null;
    }
    cachedBytes += entryBytes(entry) - previousBytes;
    entry.touchedAt = now();
    if (entry.interests > 0) {
      for (const listener of entry.listeners) listener(state);
    }
    evict();
  }

  function evict(): void {
    if (entries.size <= maxEntries && cachedBytes <= maxBytes) return;
    for (const [key, entry] of entries) {
      if (entry.interests > 0 || entry.running || entry.queued) continue;
      entries.delete(key);
      cachedBytes -= entryBytes(entry);
      if (entries.size <= maxEntries && cachedBytes <= maxBytes) break;
    }
  }

  function entryKey(path: string, maxEdge: number, quality: number, scope?: object, variant = "thumbnail"): string {
    let scopeId = 0;
    if (scope) {
      scopeId = scopes.get(scope) ?? ++nextScope;
      scopes.set(scope, scopeId);
    }
    return `${scopeId}\u0000${variant}\u0000${path}\u0000${maxEdge}\u0000${quality}`;
  }

  function enqueue(key: string, force = false): void {
    const entry = entries.get(key);
    if (!entry || disposed || entry.running || entry.queued || entry.interests === 0) return;
    if (!force && entry.ready && now() - entry.loadedAt < cacheTtlMs) {
      hits += 1;
      return;
    }
    misses += 1;
    entry.queued = true;
    entry.force = force;
    if (!keepPreviousOnRefresh || !entry.ready) publish(entry, { status: "loading" });
    queue.push(key);
    drain();
  }

  function drain(): void {
    while (!disposed && active < concurrency && queue.length > 0) {
      const key = queue.shift()!;
      const entry = entries.get(key);
      if (!entry) continue;
      entry.queued = false;
      if (entry.interests === 0) continue;
      entry.running = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const knownFileVersion = entry.force ? undefined : entry.ready?.fileVersion;
      let request: Promise<ThumbnailResult>;
      try {
        request = entry.loader({ path: entry.path, maxEdge: entry.maxEdge, quality: entry.quality, knownFileVersion });
      } catch (error) {
        request = Promise.reject(error);
      }
      void request
        .then((result) => {
          if (disposed) return;
          if (result.ok && result.unchanged && entry.ready && result.fileVersion === entry.ready.fileVersion) {
            publish(entry, entry.ready);
            return;
          }
          if (!result.ok || !result.mimeType?.startsWith("image/") || !result.base64 || (requireFileVersion && !result.fileVersion)) {
            publish(entry, { status: "error", message: result.error ?? loadErrorMessage });
            return;
          }
          const dataUri = `data:${result.mimeType};base64,${result.base64}`;
          publish(entry, {
            status: "ready",
            dataUri,
            fileVersion: result.fileVersion,
            // The client retains the encoded URI, not the compressed source
            // buffer. Budget two bytes per character conservatively; engine
            // string compression and native decoded caches are independent.
            bytes: dataUri.length * 2,
          });
        })
        .catch(() => {
          if (!disposed) publish(entry, { status: "error", message: loadErrorMessage });
        })
        .finally(() => {
          entry.running = false;
          active -= 1;
          evict();
          drain();
        });
    }
    // Draining can unpin abandoned queued entries after the last active reply.
    evict();
  }

  function retain(
    path: string,
    loader: Loader,
    listener: (state: ThumbnailState) => void,
    options: ThumbnailOptions = {},
  ): () => void {
    if (disposed) return () => {};
    const maxEdge = options.maxEdge ?? 640;
    const quality = options.quality ?? 78;
    const key = entryKey(path, maxEdge, quality, options.scope, options.variant);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        path, maxEdge, quality,
        state: { status: "idle" }, ready: null, listeners: new Set(), interests: 0, loader,
        timer: null, queued: false, running: false, force: false, touchedAt: now(), loadedAt: 0,
      };
      entries.set(key, entry);
    } else {
      entries.delete(key);
      entries.set(key, entry);
      entry.loader = loader;
    }
    entry.interests += 1;
    entry.listeners.add(listener);
    entry.touchedAt = now();
    listener(entry.state);
    if (options.autoLoad !== false && (
      entry.state.status === "idle" || entry.state.status === "error" || !entry.ready || now() - entry.loadedAt >= cacheTtlMs
    )) {
      if (mountDelayMs <= 0) {
        enqueue(key);
      } else if (!entry.timer) {
        entry.timer = schedule(() => {
          entry!.timer = null;
          enqueue(key);
        }, mountDelayMs);
      }
    } else {
      hits += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = entries.get(key);
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

  function retry(path: string, options: ThumbnailOptions = {}): void {
    const key = entryKey(path, options.maxEdge ?? 640, options.quality ?? 78, options.scope, options.variant);
    const entry = entries.get(key);
    if (!entry) return;
    enqueue(key, true);
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
    setLimits(limits: { maxEntries: number; maxBytes: number }): void {
      maxEntries = limits.maxEntries;
      maxBytes = limits.maxBytes;
      evict();
    },
    diagnostics: () => ({ active, queued: queue.length, entries: entries.size, cachedBytes, hits, misses, maxActive, maxEntries, maxBytes }),
  };
}

let defaultStore = createImagePreviewStore();

export type FullImageLoader = (input: {
  path: string;
  mode: "image";
  optimizeImage: true;
  imageMaxBytes: number;
  fileVersion?: string;
}) => Promise<ThumbnailResult & { size?: number }>;

/** Full-image payloads share the same LRU/queue machinery as thumbnails. */
export function createFullImagePreviewStore(options: Parameters<typeof createImagePreviewStore>[0] = {}) {
  const store = createImagePreviewStore({
    maxEntries: 16, maxBytes: 64 * 1024 * 1024, cacheTtlMs: 60_000,
    mountDelayMs: 0, requireFileVersion: false, keepPreviousOnRefresh: true,
    loadErrorMessage: "Could not load the full image.",
    ...options,
  });
  function profile(loader: FullImageLoader, imageMaxBytes: number): ThumbnailOptions {
    // The byte limit separates mobile and desktop variants of the same path.
    return { scope: loader, variant: `viewer:${imageMaxBytes}`, maxEdge: 4096, quality: 88 };
  }
  return {
    retain(path: string, loader: FullImageLoader, listener: (state: ThumbnailState) => void, imageMaxBytes: number): () => void {
      return store.retain(path, ({ path, knownFileVersion }) => loader({
        path, mode: "image", optimizeImage: true, imageMaxBytes, fileVersion: knownFileVersion,
      }), listener, profile(loader, imageMaxBytes));
    },
    retry(path: string, loader: FullImageLoader, imageMaxBytes: number): void {
      store.retry(path, profile(loader, imageMaxBytes));
    },
    dispose: store.dispose,
    setLimits: store.setLimits,
    diagnostics: store.diagnostics,
  };
}

let defaultFullStore: ReturnType<typeof createFullImagePreviewStore> | null = null;

function fullImageStore(imageMaxBytes: number) {
  defaultFullStore ??= createFullImagePreviewStore();
  defaultFullStore.setLimits(imageMaxBytes <= 3 * 1024 * 1024
    ? { maxEntries: 8, maxBytes: 24 * 1024 * 1024 }
    : { maxEntries: 16, maxBytes: 64 * 1024 * 1024 });
  return defaultFullStore;
}

export function retainFullImage(path: string, loader: FullImageLoader, listener: (state: ThumbnailState) => void, imageMaxBytes: number): () => void {
  return fullImageStore(imageMaxBytes).retain(path, loader, listener, imageMaxBytes);
}

export function retryFullImage(path: string, loader: FullImageLoader, imageMaxBytes: number): void {
  fullImageStore(imageMaxBytes).retry(path, loader, imageMaxBytes);
}

export function retainImagePreview(
  path: string,
  loader: Loader,
  listener: (state: ThumbnailState) => void,
  options: ThumbnailOptions = {},
): () => void {
  return defaultStore.retain(path, loader, listener, options);
}

export function retryImagePreview(path: string, options: ThumbnailOptions = {}): void {
  defaultStore.retry(path, options);
}

export function disposeImagePreviews(): void {
  defaultStore.dispose();
  defaultFullStore?.dispose();
  defaultFullStore = null;
  defaultStore = createImagePreviewStore();
}
