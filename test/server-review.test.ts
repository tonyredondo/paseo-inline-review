import assert from "node:assert/strict";
import { after, test } from "node:test";
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
import { FILE_TRANSFER_CHUNK_BYTES } from "../shared/review.ts";

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
