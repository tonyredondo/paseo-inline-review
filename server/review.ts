import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  FILE_TRANSFER_CHUNK_BYTES,
  compareReviewCommentVersions,
  loadCommentsRpc,
  localImagePreviewRpc,
  MAX_DOWNLOAD_BYTES,
  openLocalFileRpc,
  reviewCommentSchema,
  saveCommentsRpc,
  saveCommentDeltaRpc,
  syncCommentsRpc,
  type ReviewComment,
} from "../shared/review.ts";
import { imagePreviewService } from "./image-preview.ts";

type StoredAgents = Record<string, ReviewComment[]>;
/** Per-agent deleted-comment ids: deletions must beat stale copies on other devices. */
type Tombstones = Record<string, string[]>;

const dataPath = path.join(
  process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
  "plugin-data",
  "inline-review",
  "comments.json",
);

let cache: { agents: StoredAgents; deleted: Tombstones } | null = null;
let loadPromise: Promise<{ agents: StoredAgents; deleted: Tombstones }> | null = null;
let writeChain: Promise<void> = Promise.resolve();
const syncEpoch = randomUUID();
const agentRevisions = new Map<string, number>();

async function load(): Promise<{ agents: StoredAgents; deleted: Tombstones }> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const parsed = JSON.parse(await readFile(dataPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("comment store root must be an object");
    }
    const record = parsed as { agents?: unknown; deleted?: unknown };
    const agents: StoredAgents = {};
    const deleted: Tombstones = {};
    if (record.agents !== undefined) {
      if (!record.agents || typeof record.agents !== "object" || Array.isArray(record.agents)) {
        throw new Error("comment store agents must be an object");
      }
      for (const [agentId, value] of Object.entries(record.agents)) {
        if (!Array.isArray(value)) throw new Error(`comments for ${agentId} must be an array`);
        agents[agentId] = value.map((comment) => reviewCommentSchema.parse(comment));
      }
    }
    if (record.deleted !== undefined) {
      if (!record.deleted || typeof record.deleted !== "object" || Array.isArray(record.deleted)) {
        throw new Error("comment store tombstones must be an object");
      }
      for (const [agentId, value] of Object.entries(record.deleted)) {
        if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
          throw new Error(`tombstones for ${agentId} must be a string array`);
        }
        deleted[agentId] = value;
      }
    }
      cache = { agents, deleted };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cache = { agents: {}, deleted: {} };
      } else {
        throw new Error(`Could not load inline-review comments from ${dataPath}`, { cause: error });
      }
    }
    return cache;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function persist(): Promise<void> {
  const operation = writeChain.catch(() => {}).then(async () => {
    await mkdir(path.dirname(dataPath), { recursive: true });
    // Atomic replace: a crash mid-write must not truncate the store.
    const tmp = `${dataPath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(await load(), null, 2));
      await rename(tmp, dataPath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  });
  writeChain = operation;
  return operation;
}

export async function getAgentComments(agentId: string): Promise<ReviewComment[]> {
  return (await load()).agents[agentId] ?? [];
}

/** Keeps tombstones bounded: deletions are repair metadata, not history. */
const MAX_TOMBSTONES_PER_AGENT = 200;

function pruneTombstones(ids: string[]): string[] {
  return ids.length <= MAX_TOMBSTONES_PER_AGENT ? ids : ids.slice(-MAX_TOMBSTONES_PER_AGENT);
}

async function setAgentComments(
  agentId: string,
  comments: ReviewComment[],
  deleted: string[] = [],
): Promise<boolean> {
  const validated = comments.map((comment) => reviewCommentSchema.parse(comment));
  const store = await load();
  const before = JSON.stringify({
    comments: store.agents[agentId] ?? [],
    deleted: store.deleted[agentId] ?? [],
  });
  // A stale device re-sending a deleted comment must not resurrect it: the
  // tombstone wins over any comment body.
  const tombstones = new Set(store.deleted[agentId] ?? []);
  for (const id of deleted) tombstones.add(id);
  store.deleted[agentId] = pruneTombstones([...tombstones]);
  // Merge instead of replace: a stale device that failed to hydrate would
  // otherwise push an empty list and wipe comments another device still has.
  // Deletions are always explicit through tombstones, never implicit by
  // omitting a comment from the incoming list.
  const merged = new Map((store.agents[agentId] ?? []).map((comment) => [comment.id, comment]));
  for (const comment of validated) {
    const existing = merged.get(comment.id);
    if (!existing || compareReviewCommentVersions(comment, existing) >= 0) {
      merged.set(comment.id, comment);
    }
  }
  const alive = [...merged.values()].filter((comment) => !tombstones.has(comment.id));
  if (alive.length === 0) {
    delete store.agents[agentId];
  } else {
    store.agents[agentId] = alive.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const after = JSON.stringify({
    comments: store.agents[agentId] ?? [],
    deleted: store.deleted[agentId] ?? [],
  });
  if (before === after) return false;
  agentRevisions.set(agentId, (agentRevisions.get(agentId) ?? 0) + 1);
  await persist();
  return true;
}

export async function loadComments(
  input: RpcInput<typeof loadCommentsRpc>,
): Promise<{ comments: ReviewComment[]; deleted: string[] }> {
  const store = await load();
  return { comments: store.agents[input.agentId] ?? [], deleted: store.deleted[input.agentId] ?? [] };
}

export async function saveComments(
  input: RpcInput<typeof saveCommentsRpc>,
): Promise<{ ok: boolean }> {
  await setAgentComments(input.agentId, input.comments, input.deleted ?? []);
  return { ok: true };
}

export async function saveCommentDelta(
  input: RpcInput<typeof saveCommentDeltaRpc>,
): Promise<{ ok: boolean }> {
  await setAgentComments(input.agentId, input.upserts, input.deleted);
  return { ok: true };
}

function agentRevision(agentId: string, store: { agents: StoredAgents; deleted: Tombstones }): number {
  const existing = agentRevisions.get(agentId);
  if (existing !== undefined) return existing;
  const initial = (store.agents[agentId]?.length ?? 0) > 0 || (store.deleted[agentId]?.length ?? 0) > 0 ? 1 : 0;
  agentRevisions.set(agentId, initial);
  return initial;
}

/** Returns only buckets whose opaque server revision differs from the client. */
export async function syncComments(
  input: RpcInput<typeof syncCommentsRpc>,
): Promise<{
  epoch: string;
  buckets: Array<{ agentId: string; revision: number; comments: ReviewComment[]; deleted: string[] }>;
}> {
  const store = await load();
  const epochChanged = input.epoch !== syncEpoch;
  const buckets = input.agents.flatMap(({ agentId, revision: knownRevision }) => {
    const revision = agentRevision(agentId, store);
    if (!epochChanged && knownRevision === revision) return [];
    return [{
      agentId,
      revision,
      comments: store.agents[agentId] ?? [],
      deleted: store.deleted[agentId] ?? [],
    }];
  });
  return { epoch: syncEpoch, buckets };
}

export async function localImagePreview(
  input: RpcInput<typeof localImagePreviewRpc>,
) {
  const absolutePath = expandHome(input.path);
  if (!absolutePath) return { ok: false, error: "path could not be resolved to an absolute location" };
  return imagePreviewService.request({ ...input, path: absolutePath });
}

const MAX_READ_BYTES = FILE_TRANSFER_CHUNK_BYTES;

/**
 * Opens a local file on the daemon machine (macOS `open`, xdg-open elsewhere)
 * or returns its text content so remote clients can view it through the RPC.
 */
export async function openLocalFile(
  input: RpcInput<typeof openLocalFileRpc>,
): Promise<{
  ok: boolean;
  error?: string;
  content?: string;
  truncated?: boolean;
  size?: number;
  binary?: boolean;
  base64?: string;
  mimeType?: string;
  done?: boolean;
  fileVersion?: string;
}> {
  const absolutePath = expandHome(input.path);
  if (!absolutePath) {
    return { ok: false, error: "path could not be resolved to an absolute location" };
  }
  if (input.mode === "read") {
    return readLocalFile(absolutePath);
  }
  if (input.mode === "image") {
    return readLocalImage(absolutePath);
  }
  if (input.mode === "download") {
    return downloadLocalFile(
      absolutePath,
      input.offset ?? 0,
      input.length ?? FILE_TRANSFER_CHUNK_BYTES,
      input.fileVersion,
    );
  }
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", absolutePath] : [absolutePath];
  return new Promise((resolve) => {
    execFile(command, args, (error) => {
      if (error) return resolve({ ok: false, error: error.message });
      // Desktop users usually want the editor at the right line; the file
      // opener decides. Text content is still available through read mode.
      resolve({ ok: true });
    });
  });
}

function expandHome(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (trimmed.startsWith("~/") || trimmed === "~") {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  if (trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  return null;
}

function imageMimeType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString("ascii") === "PNG" &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return null;
}

function fileVersion(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

/** Returns one complete, validated image. Partial image payloads cannot decode. */
async function readLocalImage(absolutePath: string): Promise<{
  ok: boolean;
  error?: string;
  size?: number;
  base64?: string;
  mimeType?: string;
}> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absolutePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, error: "Path is not a regular file" };
    if (stats.size > MAX_READ_BYTES) {
      return { ok: false, error: "Image is larger than the 5 MB inline preview limit", size: stats.size };
    }
    const buffer = Buffer.alloc(stats.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const finalStats = await handle.stat();
    const initialVersion = fileVersion(stats);
    const finalVersion = fileVersion(finalStats);
    if (initialVersion !== finalVersion || bytesRead !== stats.size) {
      return { ok: false, error: "The image changed while it was being read" };
    }
    const content = buffer.subarray(0, bytesRead);
    const mimeType = imageMimeType(content);
    if (!mimeType) return { ok: false, error: "Unsupported local image format" };
    return { ok: true, size: stats.size, base64: content.toString("base64"), mimeType };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readLocalFile(absolutePath: string): Promise<{
  ok: boolean;
  error?: string;
  content?: string;
  truncated?: boolean;
  size?: number;
  binary?: boolean;
  base64?: string;
  mimeType?: string;
}> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absolutePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, error: "Path is not a regular file" };
    const size = stats.size;
    const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (fileVersion(await handle.stat()) !== fileVersion(stats)) {
      return { ok: false, error: "The file changed while it was being read" };
    }
    const content = buffer.subarray(0, bytesRead);
    const mimeType = imageMimeType(content);
    if (mimeType) {
      // An image must be complete before React Native can decode it. Preserve
      // its type when it exceeds the preview cap so clients can explain the
      // limit without misclassifying it as an arbitrary binary download.
      if (size > MAX_READ_BYTES) {
        return { ok: true, mimeType, truncated: true, size };
      }
      return {
        ok: true,
        base64: content.toString("base64"),
        mimeType,
        size,
      };
    }
    if (isProbablyBinary(content.subarray(0, Math.min(1024, content.length)))) {
      // Binary: no text content. The caller offers a download instead.
      return { ok: true, binary: true, size };
    }
    const truncated = size > MAX_READ_BYTES;
    return {
      ok: true,
      content: content.toString("utf8"),
      truncated,
      size,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Download hard cap (client chunks its own reads; this is a safety rail
 * against absurd sizes, not the transfer mechanism).
 */
/** Reads and returns one independently decoded file chunk. */
async function downloadLocalFile(
  absolutePath: string,
  offset: number,
  length: number,
  expectedVersion?: string,
): Promise<{
  ok: boolean;
  error?: string;
  base64?: string;
  done?: boolean;
  truncated?: boolean;
  size?: number;
  fileVersion?: string;
}> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    if (length > FILE_TRANSFER_CHUNK_BYTES) {
      return { ok: false, error: "Requested file chunk exceeds the 5 MB limit" };
    }
    handle = await open(absolutePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, error: "Path is not a regular file" };
    const size = stats.size;
    const currentVersion = fileVersion(stats);
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      return { ok: false, error: "The file changed during download" };
    }
    if (size > MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: `File is larger than the ${Math.round(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB download cap` };
    }
    const start = Math.min(offset, size);
    const end = Math.min(start + length, size);
    if (start >= end) {
      return { ok: true, base64: "", done: true, size, fileVersion: currentVersion };
    }
    const byteCount = end - start;
    const buffer = Buffer.alloc(byteCount);
    let bytesRead = 0;
    while (bytesRead < byteCount) {
      const result = await handle.read(buffer, bytesRead, byteCount - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const finalVersion = fileVersion(await handle.stat());
    if (finalVersion !== currentVersion) {
      return { ok: false, error: "The file changed during download" };
    }
    return {
      ok: true,
      base64: buffer.subarray(0, bytesRead).toString("base64"),
      done: start + bytesRead >= size || bytesRead < byteCount,
      size,
      fileVersion: currentVersion,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = Math.min(1024, buffer.length);
  for (let index = 0; index < sample; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
