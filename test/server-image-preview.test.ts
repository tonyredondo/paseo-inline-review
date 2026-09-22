import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagePreviewService, type ImageProcessor } from "../server/image-preview.ts";
import { IMAGE_THUMBNAIL_MAX_BYTES } from "../shared/review.ts";

const roots: string[] = [];
function imageFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "inline-review-image-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  return path;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const fakeProcessor = (buffer = Buffer.from("thumbnail")): ImageProcessor => async () => ({
  buffer, mimeType: "image/webp", originalWidth: 1200, originalHeight: 800, width: 640, height: 427,
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("thumbnail requests are singleflight, cached, and bounded", async () => {
  const path = imageFile("singleflight.png");
  let calls = 0;
  let release: (() => void) | null = null;
  const service = createImagePreviewService({
    processor: async (...args) => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return fakeProcessor()(...args);
    },
  });
  const first = service.request({ path });
  const second = service.request({ path });
  await waitFor(() => calls === 1);
  assert.equal(calls, 1);
  (release as unknown as () => void)();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.thumbnailSize, Buffer.byteLength("thumbnail"));
  assert.deepEqual(two, one);
  const cached = await service.request({ path });
  assert.equal(calls, 1);
  assert.deepEqual(cached, one);
  assert.ok((cached.thumbnailSize ?? Infinity) <= IMAGE_THUMBNAIL_MAX_BYTES);
  assert.ok(service.diagnostics().cachedBytes >= (cached.base64?.length ?? 0));
  service.dispose();
});

test("server thumbnail processing concurrency never exceeds two", async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const processor: ImageProcessor = () => new Promise((resolve) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    releases.push(() => {
      active -= 1;
      resolve({ buffer: Buffer.from("x"), mimeType: "image/webp", originalWidth: 1, originalHeight: 1, width: 1, height: 1 });
    });
  });
  const service = createImagePreviewService({ processor, concurrency: 2 });
  const requests = [0, 1, 2, 3].map((index) => service.request({ path: imageFile(`${index}.png`) }));
  await waitFor(() => maxActive === 2);
  assert.equal(maxActive, 2);
  for (let index = 0; index < requests.length; index += 1) {
    await waitFor(() => releases.length > 0);
    releases.shift()?.();
  }
  await Promise.all(requests);
  assert.equal(maxActive, 2);
  service.dispose();
});

test("oversized processor output and same-size file replacement are rejected", async () => {
  const oversizedPath = imageFile("oversized.png");
  const oversized = createImagePreviewService({ processor: fakeProcessor(Buffer.alloc(IMAGE_THUMBNAIL_MAX_BYTES + 1)) });
  assert.equal((await oversized.request({ path: oversizedPath })).ok, false);
  oversized.dispose();

  const replacedPath = imageFile("replaced.png");
  const replacing = createImagePreviewService({
    processor: async (...args) => {
      const original = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      writeFileSync(replacedPath, Buffer.alloc(original.length, 1));
      const changed = new Date(Date.now() + 2000);
      utimesSync(replacedPath, changed, changed);
      return fakeProcessor()(...args);
    },
  });
  const result = await replacing.request({ path: replacedPath });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /changed while it was being processed/);
  replacing.dispose();
});

test("unsupported input and processor failures stay explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "inline-review-image-"));
  roots.push(root);
  const unsupportedPath = join(root, "unsupported.bin");
  writeFileSync(unsupportedPath, Buffer.from("not an image"));
  let processorCalls = 0;
  const unsupported = createImagePreviewService({
    processor: async (...args) => {
      processorCalls += 1;
      return fakeProcessor()(...args);
    },
  });
  const unsupportedResult = await unsupported.request({ path: unsupportedPath });
  assert.equal(unsupportedResult.ok, false);
  assert.match(unsupportedResult.error ?? "", /Unsupported local image format/);
  assert.equal(processorCalls, 0);
  unsupported.dispose();

  const failing = createImagePreviewService({
    processor: async () => { throw new Error("processor unavailable"); },
  });
  const failedResult = await failing.request({ path: imageFile("failure.png") });
  assert.equal(failedResult.ok, false);
  assert.match(failedResult.error ?? "", /processor unavailable/);
  failing.dispose();
});

test("the production platform adapter emits a decodable bounded thumbnail", async () => {
  const path = imageFile("platform.png");
  const service = createImagePreviewService();
  const result = await service.request({ path });
  if (process.platform !== "darwin") {
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unavailable on this daemon platform/);
    service.dispose();
    return;
  }
  assert.equal(result.ok, true);
  assert.equal(result.mimeType, "image/png");
  assert.ok((result.thumbnailSize ?? Infinity) <= IMAGE_THUMBNAIL_MAX_BYTES);
  assert.ok((result.base64?.length ?? 0) > 0);
  service.dispose();
});
