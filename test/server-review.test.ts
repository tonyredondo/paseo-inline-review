import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_IMAGE_VIEWER_MAX_BYTES, FILE_TRANSFER_CHUNK_BYTES, reviewCommentSchema } from "../shared/review.ts";

const tempRoots: string[] = [];
const importServer = (tag: string) => import(`../server/review.ts?${tag}`);
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "inline-review-test-"));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

test("save resolves only after comments are durably written", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("persist-success");
  const comment = {
    id: "c1",
    agentId: "a1",
    messageId: "m1",
    paragraphIndex: 0,
    itemIndex: null,
    paragraphText: "paragraph",
    text: "comment",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    revision: 1,
    status: "pending" as const,
  };
  assert.deepEqual(await server.saveComments({ agentId: "a1", comments: [comment] }), { ok: true });
  const stored = JSON.parse(readFileSync(join(root, "plugin-data/inline-review/comments.json"), "utf8"));
  assert.equal(stored.agents.a1[0].id, "c1");
});

test("save rejects when the store is unavailable", async () => {
  const root = tempRoot();
  const notDirectory = join(root, "not-a-directory");
  writeFileSync(notDirectory, "file");
  process.env.PASEO_HOME = notDirectory;
  const server = await importServer("persist-failure");
  await assert.rejects(
    server.saveComments({ agentId: "a1", comments: [] }),
    /Could not load inline-review comments/i,
  );
});

test("precise targets and general feedback survive daemon restart and device synchronization", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("target-persistence");
  const base = {
    agentId: "a1", messageId: "m1", paragraphIndex: 0, paragraphText: "source", text: "Feedback",
    createdAt: "2026-10-01T00:00:00.000Z", revision: 1, status: "pending",
  };
  const comments = [
    { ...base, id: "legacy" },
    { ...base, id: "general", paragraphIndex: -1, target: { kind: "response" } },
    { ...base, id: "cell", target: { kind: "table-cell", path: [0], row: 0, column: 1, text: "20", header: ["Name", "Price"], rowText: ["Phone", "20"] } },
    { ...base, id: "image", target: { kind: "image", path: [1], imageIndex: 1, url: "/tmp/image.png", alt: "Diagram" } },
  ].map(comment => reviewCommentSchema.parse(comment));
  await server.saveCommentDelta({ agentId: "a1", upserts: comments, deleted: [] });
  const restarted = await importServer("target-persistence-restarted");
  assert.deepEqual((await restarted.loadComments({ agentId: "a1" })).comments, comments);
  const synced = await restarted.syncComments({ agents: [{ agentId: "a1" }] });
  assert.deepEqual(synced.buckets[0].comments, comments);
  const changed = { ...comments[2], revision: 2, text: "Updated cell feedback" };
  await restarted.saveCommentDelta({ agentId: "a1", upserts: [changed], deleted: ["image"] });
  const next = await restarted.syncComments({ epoch: synced.epoch, agents: [{ agentId: "a1", revision: synced.buckets[0].revision }] });
  assert.deepEqual(next.buckets[0].comments.find((comment: { id: string }) => comment.id === "cell"), changed);
  assert.deepEqual(next.buckets[0].deleted, ["image"]);
});

test("corrupt stores fail closed instead of looking empty", async () => {
  const root = tempRoot();
  const directory = join(root, "plugin-data/inline-review");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "comments.json"), "{not-json");
  process.env.PASEO_HOME = root;
  const server = await importServer("corrupt-store");
  await assert.rejects(server.loadComments({ agentId: "a1" }), /Could not load inline-review comments/);
  assert.equal(readFileSync(join(directory, "comments.json"), "utf8"), "{not-json");
});

test("preview and download never read more than a 5 MB chunk", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("file-transfer");
  const filePath = join(root, "large.txt");
  writeFileSync(filePath, "a".repeat(FILE_TRANSFER_CHUNK_BYTES + 1024));

  const preview = await server.openLocalFile({ path: filePath, mode: "read" });
  assert.equal(preview.ok, true);
  assert.equal(preview.truncated, true);
  assert.equal(preview.content?.length, FILE_TRANSFER_CHUNK_BYTES);

  const first = await server.openLocalFile({
    path: filePath,
    mode: "download",
    offset: 0,
    length: FILE_TRANSFER_CHUNK_BYTES,
  });
  assert.equal(first.ok, true);
  assert.equal(first.done, false);
  assert.equal(typeof first.fileVersion, "string");
  assert.equal(Buffer.from(first.base64 ?? "", "base64").byteLength, FILE_TRANSFER_CHUNK_BYTES);

  const oversized = await server.openLocalFile({
    path: filePath,
    mode: "download",
    offset: 0,
    length: FILE_TRANSFER_CHUNK_BYTES + 1,
  } as Parameters<typeof server.openLocalFile>[0]);
  assert.equal(oversized.ok, false);
});

test("local image previews return a complete typed data payload", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("image-preview");
  const filePath = join(root, "pixel.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(filePath, png);

  const result = await server.openLocalFile({ path: filePath, mode: "image" });
  assert.equal(result.ok, true);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(Buffer.from(result.base64 ?? "", "base64"), png);
  const optimized = await server.openLocalFile({ path: filePath, mode: "image", optimizeImage: true });
  assert.deepEqual(Buffer.from(optimized.base64 ?? "", "base64"), png);
});

function noisyPng(width: number, height: number, alpha: boolean): Buffer {
  const stride = width * (alpha ? 4 : 3) + 1;
  const pixels = randomFillSync(Buffer.alloc(stride * height));
  for (let row = 0; row < height; row++) pixels[row * stride] = 0;
  const chunk = (type: string, content: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), content]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
    prefix.writeUInt32BE(content.length);
    suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, body, suffix]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

test("oversized viewer images are compressed, decodable, bounded and leave the source intact", { timeout: 120_000 }, async () => {
  const root = tempRoot();
  const server = await importServer("optimized-viewer");
  for (const alpha of [false, true]) {
    const original = noisyPng(4097, 1400, alpha);
    assert.ok(original.length > FILE_TRANSFER_CHUNK_BYTES);
    const input = join(root, alpha ? "transparent.png" : "photo.png");
    writeFileSync(input, original);
    const legacy = await server.openLocalFile({ path: input, mode: "image" });
    assert.equal(legacy.ok, false);
    const result = await server.openLocalFile({ path: input, mode: "image", optimizeImage: true });
    if (process.platform !== "darwin") {
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /unavailable on this daemon platform/);
      continue;
    }
    assert.equal(result.ok, true, result.error);
    const output = Buffer.from(result.base64 ?? "", "base64");
    assert.ok(output.length <= FILE_TRANSFER_CHUNK_BYTES);
    assert.equal(result.size, output.length);
    assert.equal(result.mimeType, alpha ? "image/png" : "image/jpeg");
    const derived = join(root, alpha ? "derived.png" : "derived.jpg");
    writeFileSync(derived, output);
    const info = execFileSync('/usr/bin/sips', ['--getProperty','pixelWidth','--getProperty','pixelHeight','--getProperty','hasAlpha',derived], { encoding: 'utf8', timeout: 15_000 });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(info)?.[1]);
    assert.ok(width >= 1400 && width <= 4096, info);
    assert.ok(Math.abs(width / height - 4097 / 1400) < 0.01);
    assert.equal(/hasAlpha:\s*yes/.test(info), alpha);
    assert.deepEqual(readFileSync(input), original);
    const mobile = await server.openLocalFile({ path: input, mode: "image", optimizeImage: true, imageMaxBytes: COMPACT_IMAGE_VIEWER_MAX_BYTES });
    assert.equal(mobile.ok, true, mobile.error);
    assert.ok(Buffer.from(mobile.base64 ?? "", "base64").length <= COMPACT_IMAGE_VIEWER_MAX_BYTES);
    console.log(JSON.stringify({ originalBytes: original.length, viewerBytes: output.length, width, height, alpha }));
  }
});

test("images between 3 and 5 MiB stay original on desktop and are compressed on mobile", { timeout: 120_000 }, async () => {
  const root = tempRoot(), server = await importServer("mobile-viewer-limit");
  const original = noisyPng(1400, 800, false), input = join(root, "medium.png");
  assert.ok(original.length > COMPACT_IMAGE_VIEWER_MAX_BYTES && original.length < FILE_TRANSFER_CHUNK_BYTES);
  writeFileSync(input, original);
  const desktop = await server.openLocalFile({ path: input, mode: "image", optimizeImage: true });
  assert.deepEqual(Buffer.from(desktop.base64 ?? "", "base64"), original);
  const mobile = await server.openLocalFile({ path: input, mode: "image", optimizeImage: true, imageMaxBytes: COMPACT_IMAGE_VIEWER_MAX_BYTES });
  if (process.platform === "darwin") {
    assert.equal(mobile.ok, true, mobile.error);
    assert.ok(Buffer.from(mobile.base64 ?? "", "base64").length <= COMPACT_IMAGE_VIEWER_MAX_BYTES);
    assert.equal(mobile.mimeType, "image/jpeg");
    assert.deepEqual(readFileSync(input), original);
  } else {
    assert.equal(mobile.ok, false);
    assert.match(mobile.error ?? "", /unavailable on this daemon platform/);
  }
});

test("the normal file preview recognizes images instead of reporting binary", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("file-preview-image");
  const filePath = join(root, "pixel.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(filePath, png);

  const result = await server.openLocalFile({ path: filePath, mode: "read" });
  assert.equal(result.ok, true);
  assert.equal(result.binary, undefined);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(Buffer.from(result.base64 ?? "", "base64"), png);

  const largePath = join(root, "large.png");
  const largePng = Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 1);
  png.subarray(0, 8).copy(largePng);
  writeFileSync(largePath, largePng);
  const largeResult = await server.openLocalFile({ path: largePath, mode: "read" });
  assert.equal(largeResult.ok, true);
  assert.equal(largeResult.binary, undefined);
  assert.equal(largeResult.mimeType, "image/png");
  assert.equal(largeResult.truncated, true);
  assert.equal(largeResult.base64, undefined);
});

test("download rejects a same-size file replacement between chunks", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("file-version");
  const filePath = join(root, "changing.txt");
  const size = FILE_TRANSFER_CHUNK_BYTES + 16;
  writeFileSync(filePath, "a".repeat(size));
  const first = await server.openLocalFile({
    path: filePath,
    mode: "download",
    offset: 0,
    length: FILE_TRANSFER_CHUNK_BYTES,
  });
  assert.equal(first.ok, true);
  writeFileSync(filePath, "b".repeat(size));
  const changedTime = new Date(Date.now() + 2000);
  utimesSync(filePath, changedTime, changedTime);
  const second = await server.openLocalFile({
    path: filePath,
    mode: "download",
    offset: FILE_TRANSFER_CHUNK_BYTES,
    length: FILE_TRANSFER_CHUNK_BYTES,
    fileVersion: first.fileVersion,
  });
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /changed during download/);
});

test("stale comment revisions cannot overwrite newer server state", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("comment-revision");
  const base = {
    id: "shared",
    agentId: "a1",
    messageId: "m1",
    paragraphIndex: 0,
    itemIndex: null,
    paragraphText: "paragraph",
    createdAt: "2026-09-22T00:00:00.000Z",
    status: "pending" as const,
  };
  await server.saveComments({
    agentId: "a1",
    comments: [{ ...base, text: "new", revision: 2, updatedAt: "2026-09-22T00:02:00.000Z" }],
  });
  await server.saveComments({
    agentId: "a1",
    comments: [{ ...base, text: "stale", revision: 1, updatedAt: "2026-09-22T00:01:00.000Z" }],
  });
  const loaded = await server.loadComments({ agentId: "a1" });
  assert.equal(loaded.comments[0].text, "new");
  assert.equal(loaded.comments[0].revision, 2);
});

test("comment sync revisions change only for semantic mutations", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("comment-sync-revisions");
  const comment = {
    id: "c1", agentId: "a1", messageId: "m1", paragraphIndex: 0, itemIndex: null,
    paragraphText: "p", text: "first", createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z", revision: 1, status: "pending" as const,
  };
  const initial = await server.syncComments({ agents: [{ agentId: "a1" }] });
  assert.equal(initial.buckets[0].revision, 0);
  await server.saveComments({ agentId: "a1", comments: [comment] });
  const changed = await server.syncComments({ epoch: initial.epoch, agents: [{ agentId: "a1", revision: 0 }] });
  assert.equal(changed.buckets[0].revision, 1);
  await server.saveComments({ agentId: "a1", comments: [comment] });
  const unchanged = await server.syncComments({
    epoch: initial.epoch,
    agents: [{ agentId: "a1", revision: changed.buckets[0].revision }],
  });
  assert.deepEqual(unchanged.buckets, []);
  await server.saveComments({ agentId: "a1", comments: [], deleted: ["c1"] });
  const deleted = await server.syncComments({
    epoch: initial.epoch,
    agents: [{ agentId: "a1", revision: changed.buckets[0].revision }],
  });
  assert.equal(deleted.buckets[0].revision, 2);
  assert.deepEqual(deleted.buckets[0].deleted, ["c1"]);
});

test("a daemon epoch replacement forces a complete comment refresh", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const first = await importServer("comment-sync-first-process");
  const firstSync = await first.syncComments({ agents: [{ agentId: "a1" }] });
  const restarted = await importServer("comment-sync-restarted-process");
  const afterRestart = await restarted.syncComments({
    epoch: firstSync.epoch,
    agents: [{ agentId: "a1", revision: 0 }],
  });
  assert.notEqual(afterRestart.epoch, firstSync.epoch);
  assert.equal(afterRestart.buckets.length, 1);
});

test("delta saves merge only changed comments and keep tombstones authoritative", async () => {
  const root = tempRoot();
  process.env.PASEO_HOME = root;
  const server = await importServer("comment-delta-server");
  const base = {
    agentId: "a1", messageId: "m1", paragraphIndex: 0, itemIndex: null,
    paragraphText: "p", createdAt: "2026-09-22T00:00:00.000Z", status: "pending" as const,
  };
  const first = { ...base, id: "one", text: "one", revision: 1, updatedAt: "2026-09-22T00:00:01.000Z" };
  const second = { ...base, id: "two", text: "two", revision: 1, updatedAt: "2026-09-22T00:00:01.000Z" };
  await server.saveComments({ agentId: "a1", comments: [first, second] });
  await server.saveCommentDelta({
    agentId: "a1",
    upserts: [{ ...second, text: "two edited", revision: 2, updatedAt: "2026-09-22T00:00:02.000Z" }],
    deleted: ["one"],
  });
  const loaded = await server.loadComments({ agentId: "a1" });
  assert.deepEqual(loaded.comments.map((comment: { id: string; text: string }) => [comment.id, comment.text]), [["two", "two edited"]]);
  assert.deepEqual(loaded.deleted, ["one"]);
  await server.saveCommentDelta({ agentId: "a1", upserts: [first], deleted: [] });
  assert.deepEqual((await server.loadComments({ agentId: "a1" })).comments.map((comment: { id: string }) => comment.id), ["two"]);
});

test("server file and store I/O uses asynchronous handles", () => {
  const source = readFileSync(join(process.cwd(), "server/review.ts"), "utf8");
  assert.doesNotMatch(source, /\b(?:open|read|writeFile|readFile|stat|rename|mkdir|close)Sync\b/);
  assert.match(source, /node:fs\/promises/);
});
