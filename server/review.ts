import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  isValidHttpUrl,
  loadCommentsRpc,
  openInBrowserRpc,
  openLocalFileRpc,
  reviewCommentSchema,
  saveCommentsRpc,
  type ReviewComment,
} from "../shared/review";

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
let writeChain: Promise<void> = Promise.resolve();

function load(): { agents: StoredAgents; deleted: Tombstones } {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(dataPath, "utf8")) as {
      agents?: StoredAgents;
      deleted?: Tombstones;
    };
    cache = { agents: parsed.agents ?? {}, deleted: parsed.deleted ?? {} };
  } catch {
    cache = { agents: {}, deleted: {} };
  }
  return cache;
}

function persist(): void {
  writeChain = writeChain.then(() => {
    try {
      mkdirSync(path.dirname(dataPath), { recursive: true });
      // Atomic replace: a crash mid-write must not truncate the store. The
      // loader treats a corrupt file as empty, which would lose every comment.
      const tmp = `${dataPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(load(), null, 2));
      renameSync(tmp, dataPath);
    } catch (error) {
      console.error("inline-review: failed to persist comments", error);
    }
  });
}

export function getAgentComments(agentId: string): ReviewComment[] {
  return load().agents[agentId] ?? [];
}

/** Keeps tombstones bounded: deletions are repair metadata, not history. */
const MAX_TOMBSTONES_PER_AGENT = 200;

function pruneTombstones(ids: string[]): string[] {
  return ids.length <= MAX_TOMBSTONES_PER_AGENT ? ids : ids.slice(-MAX_TOMBSTONES_PER_AGENT);
}

function setAgentComments(
  agentId: string,
  comments: ReviewComment[],
  deleted: string[] = [],
): void {
  const validated = comments.map((comment) => reviewCommentSchema.parse(comment));
  const store = load();
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
  for (const comment of validated) merged.set(comment.id, comment);
  const alive = [...merged.values()].filter((comment) => !tombstones.has(comment.id));
  if (alive.length === 0) {
    delete store.agents[agentId];
  } else {
    store.agents[agentId] = alive.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  persist();
}

export async function loadComments(
  input: RpcInput<typeof loadCommentsRpc>,
): Promise<{ comments: ReviewComment[]; deleted: string[] }> {
  const store = load();
  return { comments: getAgentComments(input.agentId), deleted: store.deleted[input.agentId] ?? [] };
}

export async function saveComments(
  input: RpcInput<typeof saveCommentsRpc>,
): Promise<{ ok: boolean }> {
  setAgentComments(input.agentId, input.comments, input.deleted ?? []);
  return { ok: true };
}

const MAX_READ_BYTES = 5 * 1024 * 1024;

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
}> {
  const absolutePath = expandHome(input.path);
  if (!absolutePath) {
    return { ok: false, error: "path could not be resolved to an absolute location" };
  }
  if (input.mode === "read") {
    return readLocalFile(absolutePath);
  }
  if (input.mode === "download") {
    return downloadLocalFile(absolutePath, input.offset ?? 0, input.length ?? Number.MAX_SAFE_INTEGER);
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
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  return null;
}

function readLocalFile(absolutePath: string): {
  ok: boolean;
  error?: string;
  content?: string;
  truncated?: boolean;
  size?: number;
  binary?: boolean;
} {
  try {
    const buffer = readFileSync(absolutePath);
    const size = buffer.byteLength;
    if (isProbablyBinary(buffer.subarray(0, Math.min(1024, buffer.length)))) {
      // Binary: no text content. The caller offers a download instead.
      return { ok: true, binary: true, size };
    }
    const slice = buffer.subarray(0, MAX_READ_BYTES);
    const truncated = size > MAX_READ_BYTES;
    return {
      ok: true,
      content: slice.toString("utf8"),
      truncated,
      size,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Download hard cap (client chunks its own reads; this is a safety rail
 * against absurd sizes, not the transfer mechanism).
 */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/**
 * Reads one chunk of the file and returns it base64-encoded. The client
 * drives the loop (offset/length), so no single RPC carries the whole
 * payload. Chunk sizes must stay multiples of 3 bytes on the client so
 * independently-encoded base64 chunks concatenate correctly.
 */
function downloadLocalFile(
  absolutePath: string,
  offset: number,
  length: number,
): {
  ok: boolean;
  error?: string;
  base64?: string;
  done?: boolean;
  truncated?: boolean;
  size?: number;
} {
  try {
    const size = statSync(absolutePath).size;
    if (size > MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: `File is larger than the ${Math.round(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB download cap` };
    }
    const start = Math.min(offset, size);
    const end = Math.min(start + length, size);
    if (start >= end) {
      return { ok: true, base64: "", done: true, size };
    }
    const byteCount = end - start;
    const buffer = Buffer.alloc(byteCount);
    const fd = openSync(absolutePath, "r");
    try {
      readSync(fd, buffer, 0, byteCount, start);
    } finally {
      closeSync(fd);
    }
    return {
      ok: true,
      base64: buffer.toString("base64"),
      done: end >= size,
      size,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = Math.min(1024, buffer.length);
  for (let index = 0; index < sample; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export async function openInBrowser(
  { url }: RpcInput<typeof openInBrowserRpc>,
): Promise<{ ok: boolean }> {
  if (!isValidHttpUrl(url)) return { ok: false };
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    execFile(command, args, (error) => {
      resolve({ ok: !error });
    });
  });
}

