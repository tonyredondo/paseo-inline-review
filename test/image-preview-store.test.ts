import assert from "node:assert/strict";
import { test } from "node:test";

import { createFullImagePreviewStore, createImagePreviewStore, type FullImageLoader, type ThumbnailState } from "../client/image-preview-store.ts";

const ready = (version = "v1", bytes = 10) => ({
  ok: true, fileVersion: version, mimeType: "image/webp", base64: "AAAA", thumbnailSize: bytes,
});

test("two mounted rows share one thumbnail request and never request a full image", async () => {
  let calls = 0;
  const store = createImagePreviewStore({ mountDelayMs: 0 });
  const states: ThumbnailState[] = [];
  const loader = async (input: { path: string }) => {
    calls += 1;
    assert.equal(input.path, "/image.png");
    return ready();
  };
  const releaseOne = store.retain("/image.png", loader, (state) => states.push(state));
  const releaseTwo = store.retain("/image.png", loader, (state) => states.push(state));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.ok(states.some((state) => state.status === "ready"));
  releaseTwo();
  releaseOne();
  store.dispose();
});

test("thumbnail queue never exceeds two active processors", async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const store = createImagePreviewStore({ mountDelayMs: 0, concurrency: 2 });
  const loader = () => new Promise<ReturnType<typeof ready>>((resolve) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    releases.push(() => { active -= 1; resolve(ready()); });
  });
  const cleanup = ["a", "b", "c", "d"].map((path) => store.retain(path, loader, () => {}));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(maxActive, 2);
  releases.shift()?.();
  releases.shift()?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(maxActive, 2);
  while (releases.length) releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  cleanup.forEach((release) => release());
  store.dispose();
});

test("release before the mount delay performs no request or stale publication", async () => {
  const callbacks: Array<() => void> = [];
  let calls = 0;
  let publications = 0;
  const store = createImagePreviewStore({
    schedule(callback) {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {},
  });
  const release = store.retain("a", async () => { calls += 1; return ready(); }, () => { publications += 1; });
  assert.equal(publications, 1);
  release();
  callbacks[0]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(publications, 1);
  store.dispose();
});

test("a compact manual preview performs no request until explicitly requested", async () => {
  let calls = 0;
  let requestedEdge = 0;
  let requestedQuality = 0;
  const store = createImagePreviewStore({ mountDelayMs: 0 });
  const release = store.retain(
    "manual.png",
    async (input) => {
      calls += 1;
      requestedEdge = input.maxEdge;
      requestedQuality = input.quality;
      return ready();
    },
    () => {},
    { autoLoad: false, maxEdge: 320, quality: 65 },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 0);
  store.retry("manual.png", { maxEdge: 320, quality: 65 });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(requestedEdge, 320);
  assert.equal(requestedQuality, 65);
  release();
  store.dispose();
});

test("cache is byte bounded and retry recovers a processor error", async () => {
  let calls = 0;
  const store = createImagePreviewStore({ mountDelayMs: 0, maxEntries: 2, maxBytes: 15 });
  const loader = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, error: "temporary" };
    return ready(`v${calls}`, 10);
  };
  const states: ThumbnailState[] = [];
  const releaseA = store.retain("a", loader, (state) => states.push(state));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(states.at(-1)?.status, "error");
  store.retry("a");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(states.at(-1)?.status, "ready");
  releaseA();
  for (const path of ["b", "c"]) {
    const release = store.retain(path, loader, () => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    release();
  }
  assert.ok(store.diagnostics().cachedBytes <= 15);
  assert.ok(store.diagnostics().entries <= 2);
  store.dispose();
});

test("cache accounting includes the retained data URI instead of compressed source bytes", async () => {
  const store = createImagePreviewStore({ mountDelayMs: 0 });
  const release = store.retain("memory.png", async () => ready("v1", 1), () => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.ok(store.diagnostics().cachedBytes >= "data:image/webp;base64,AAAA".length);
  release();
  store.dispose();
});

test("revalidation keeps stale ready memory charged and clears it after an error", async () => {
  let now = 0;
  let calls = 0;
  let resolveSecond: ((value: { ok: false; error: string }) => void) | null = null;
  const store = createImagePreviewStore({ mountDelayMs: 0, cacheTtlMs: 10, now: () => now });
  const loader = async () => {
    calls += 1;
    if (calls === 1) return ready("v1", 1);
    return new Promise<{ ok: false; error: string }>((resolve) => { resolveSecond = resolve; });
  };
  const releaseFirst = store.retain("stale.png", loader, () => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  releaseFirst();
  const charged = store.diagnostics().cachedBytes;
  assert.ok(charged > 1);

  now = 20;
  const releaseSecond = store.retain("stale.png", loader, () => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(store.diagnostics().cachedBytes, charged);
  (resolveSecond as unknown as (value: { ok: false; error: string }) => void)({ ok: false, error: "failed" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.diagnostics().cachedBytes, 0);
  releaseSecond();
  store.dispose();
});

test("an expired entry revalidates with its file version and replaces changed content", async () => {
  let now = 0;
  const scheduled: Array<() => void> = [];
  const knownVersions: Array<string | undefined> = [];
  let version = 1;
  const store = createImagePreviewStore({
    cacheTtlMs: 10,
    now: () => now,
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {},
  });
  const states: ThumbnailState[] = [];
  const loader = async (input: { knownFileVersion?: string }) => {
    knownVersions.push(input.knownFileVersion);
    return ready(`v${version}`);
  };
  const releaseFirst = store.retain("changed.png", loader, (state) => states.push(state));
  scheduled.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1)?.status, "ready");
  releaseFirst();

  now = 20;
  version = 2;
  const releaseSecond = store.retain("changed.png", loader, (state) => states.push(state));
  scheduled.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(knownVersions, [undefined, "v1"]);
  const finalState = states.at(-1);
  assert.equal(finalState?.status === "ready" && finalState.fileVersion, "v2");
  releaseSecond();
  store.dispose();
});

test("a row released during an RPC receives no stale completion", async () => {
  let resolveRequest: ((result: ReturnType<typeof ready>) => void) | null = null;
  const states: ThumbnailState[] = [];
  const store = createImagePreviewStore({ mountDelayMs: 0 });
  const release = store.retain(
    "slow.png",
    () => new Promise((resolve) => { resolveRequest = resolve; }),
    (state) => states.push(state),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(states.at(-1)?.status, "loading");
  const publicationsBeforeRelease = states.length;
  release();
  (resolveRequest as unknown as (result: ReturnType<typeof ready>) => void)(ready());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(states.length, publicationsBeforeRelease);
  store.dispose();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const MOBILE_LIMIT = 3 * 1024 * 1024;

test("full image LRU evicts the least recently used path and charges encoded heap memory", async () => {
  const cost = "data:image/webp;base64,AAAA".length * 2;
  const store = createFullImagePreviewStore({ maxEntries: 10, maxBytes: cost * 2 });
  const calls: string[] = [];
  const loader: FullImageLoader = async ({ path, mode, optimizeImage, imageMaxBytes }) => {
    calls.push(path);
    assert.equal(mode, "image"); assert.equal(optimizeImage, true); assert.equal(imageMaxBytes, MOBILE_LIMIT);
    return ready();
  };
  const visit = async (path: string) => {
    const release = store.retain(path, loader, () => {}, MOBILE_LIMIT);
    await settle(); release();
    assert.ok(store.diagnostics().cachedBytes <= cost * 2);
  };
  await visit("a"); await visit("b"); await visit("a"); await visit("c");
  await visit("a"); await visit("b");
  assert.deepEqual(calls, ["a", "b", "c", "b"]);
  assert.equal(store.diagnostics().cachedBytes, cost * 2);
  store.dispose();
});

test("full image cache also bounds many tiny entries by count", async () => {
  const store = createFullImagePreviewStore({ maxEntries: 2 });
  const calls: string[] = [];
  const loader: FullImageLoader = async ({ path }) => { calls.push(path); return ready(); };
  for (const path of ["a", "b", "c", "a"]) {
    const release = store.retain(path, loader, () => {}, MOBILE_LIMIT);
    await settle(); release();
    assert.ok(store.diagnostics().entries <= 2);
  }
  assert.deepEqual(calls, ["a", "b", "c", "a"]);
  store.dispose();
});

test("an oversized released in-flight image is evicted as soon as its reply settles", async () => {
  const store = createFullImagePreviewStore({ maxBytes: 1 });
  let resolve!: (result: ReturnType<typeof ready>) => void;
  let publications = 0;
  const release = store.retain("large", () => new Promise(r => { resolve = r; }), () => { publications += 1; }, MOBILE_LIMIT);
  release(); const before = publications;
  resolve(ready()); await settle();
  assert.equal(publications, before);
  assert.equal(store.diagnostics().cachedBytes, 0);
  assert.equal(store.diagnostics().entries, 0);
  store.dispose();
});

test("full image cache separates RPC owners and mobile/desktop transfer profiles", async () => {
  const store = createFullImagePreviewStore();
  const calls: string[] = [];
  const hostA: FullImageLoader = async ({ imageMaxBytes }) => { calls.push(`a:${imageMaxBytes}`); return { ...ready(), base64: "HOST_A" }; };
  const hostB: FullImageLoader = async ({ imageMaxBytes }) => { calls.push(`b:${imageMaxBytes}`); return { ...ready(), base64: "HOST_B" }; };
  for (const [loader, limit] of [[hostA, MOBILE_LIMIT], [hostB, MOBILE_LIMIT], [hostA, 5 * 1024 * 1024], [hostA, MOBILE_LIMIT]] as const) {
    const states: ThumbnailState[] = [];
    const release = store.retain("same-path", loader, state => states.push(state), limit);
    await settle();
    const state = states.at(-1);
    assert.equal(state?.status === "ready" && state.dataUri.endsWith(loader === hostA ? "HOST_A" : "HOST_B"), true);
    release();
  }
  assert.deepEqual(calls, [`a:${MOBILE_LIMIT}`, `b:${MOBILE_LIMIT}`, `a:${5 * 1024 * 1024}`]);
  store.dispose();
});

test("expired full images stay visible and revalidate without a repeated payload", async () => {
  let now = 0;
  const store = createFullImagePreviewStore({ cacheTtlMs: 10, now: () => now });
  const versions: (string | undefined)[] = [];
  const loader: FullImageLoader = async ({ fileVersion }) => {
    versions.push(fileVersion);
    return fileVersion ? { ok: true, unchanged: true, fileVersion } : ready("v1");
  };
  let release = store.retain("a", loader, () => {}, MOBILE_LIMIT);
  await settle(); release();
  now = 11;
  const states: ThumbnailState[] = [];
  release = store.retain("a", loader, state => states.push(state), MOBILE_LIMIT);
  assert.ok(states.every(s => s.status === "ready"));
  await settle(); release();
  assert.deepEqual(versions, [undefined, "v1"]);
  assert.ok(states.every(s => s.status === "ready"));
  const state = states.at(-1);
  assert.equal(state?.status === "ready" && state.dataUri, "data:image/webp;base64,AAAA");
  store.dispose();
});

test("cache hits do not postpone the full image file-version check", async () => {
  let now = 0, calls = 0;
  const store = createFullImagePreviewStore({ cacheTtlMs: 10, now: () => now });
  const loader: FullImageLoader = async () => { calls += 1; return ready(`v${calls}`); };
  for (now of [0, 5, 9, 11]) {
    const release = store.retain("a", loader, () => {}, MOBILE_LIMIT);
    await settle(); release();
  }
  assert.equal(calls, 2);
  store.dispose();
});

test("full image retry handles synchronous RPC throws without stranding a queue slot", async () => {
  let calls = 0;
  const store = createFullImagePreviewStore();
  const states: ThumbnailState[] = [];
  const loader: FullImageLoader = () => {
    if (++calls === 1) throw new Error("Disconnected");
    return Promise.resolve(ready());
  };
  const release = store.retain("a", loader, state => states.push(state), MOBILE_LIMIT);
  await settle();
  assert.equal(states.at(-1)?.status, "error");
  assert.equal(store.diagnostics().active, 0);
  store.retry("a", loader, MOBILE_LIMIT);
  await settle();
  assert.equal(states.at(-1)?.status, "ready");
  release(); store.dispose();
});

test("disposing full images clears retained data and ignores late active replies", async () => {
  const store = createFullImagePreviewStore();
  let resolve!: (value: ReturnType<typeof ready>) => void;
  let publications = 0;
  store.retain("a", () => new Promise(r => { resolve = r; }), () => { publications += 1; }, MOBILE_LIMIT);
  const before = publications;
  store.dispose(); resolve(ready()); await settle();
  assert.equal(publications, before);
  assert.equal(store.diagnostics().cachedBytes, 0);
  assert.equal(store.diagnostics().entries, 0);
});

test("reducing the viewer budget evicts inactive entries across both profiles", async () => {
  const store = createFullImagePreviewStore();
  const loader: FullImageLoader = async () => ready();
  for (const limit of [MOBILE_LIMIT, 5 * 1024 * 1024]) {
    const release = store.retain("a", loader, () => {}, limit);
    await settle(); release();
  }
  assert.equal(store.diagnostics().entries, 2);
  const oneImage = store.diagnostics().cachedBytes / 2;
  store.setLimits({ maxBytes: oneImage, maxEntries: 8 });
  assert.equal(store.diagnostics().entries, 1);
  assert.equal(store.diagnostics().cachedBytes, oneImage);
  store.dispose();
});

test("released queued images are skipped and full image processors stay bounded", async () => {
  const store = createFullImagePreviewStore({ concurrency: 1 });
  const calls: string[] = [];
  const resolve: Array<(value: ReturnType<typeof ready>) => void> = [];
  const loader: FullImageLoader = ({ path }) => {
    calls.push(path); return new Promise(r => resolve.push(r));
  };
  const releaseA = store.retain("a", loader, () => {}, MOBILE_LIMIT);
  const releaseB = store.retain("b", loader, () => {}, MOBILE_LIMIT);
  releaseB();
  const releaseC = store.retain("c", loader, () => {}, MOBILE_LIMIT);
  assert.deepEqual(calls, ["a"]);
  resolve.shift()!(ready()); await settle();
  assert.deepEqual(calls, ["a", "c"]);
  assert.equal(store.diagnostics().maxActive, 1);
  resolve.shift()!(ready()); await settle();
  releaseA(); releaseC(); store.dispose();
});

test("retry forces a new full payload even when a cached file version exists", async () => {
  const store = createFullImagePreviewStore();
  const versions: (string | undefined)[] = [];
  const loader: FullImageLoader = async ({ fileVersion }) => { versions.push(fileVersion); return ready("v1"); };
  const release = store.retain("a", loader, () => {}, MOBILE_LIMIT);
  await settle();
  store.retry("a", loader, MOBILE_LIMIT);
  await settle();
  assert.deepEqual(versions, [undefined, undefined]);
  release(); store.dispose();
});

test("fully abandoned queues release their entries after the last active RPC", async () => {
  const store = createFullImagePreviewStore({ concurrency: 1, maxEntries: 1 });
  let resolve!: (value: ReturnType<typeof ready>) => void;
  const loader: FullImageLoader = () => new Promise(r => { resolve = r; });
  const releases = ["a", "b", "c"].map(path => store.retain(path, loader, () => {}, MOBILE_LIMIT));
  releases.forEach(release => release());
  resolve(ready()); await settle();
  assert.equal(store.diagnostics().active, 0);
  assert.equal(store.diagnostics().queued, 0);
  assert.ok(store.diagnostics().entries <= 1);
  assert.equal(store.diagnostics().cachedBytes, 0);
  store.dispose();
});
