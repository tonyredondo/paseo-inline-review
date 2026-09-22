import assert from "node:assert/strict";
import { test } from "node:test";

import { createImagePreviewStore, type ThumbnailState } from "../client/image-preview-store.ts";

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
