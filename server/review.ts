import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  isValidHttpUrl,
  loadCommentsRpc,
  openInBrowserRpc,
  reviewCommentSchema,
  saveCommentsRpc,
  type ReviewComment,
} from "../shared/review";

type StoredAgents = Record<string, ReviewComment[]>;

const dataPath = path.join(
  process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
  "plugin-data",
  "inline-review",
  "comments.json",
);

let cache: { agents: StoredAgents } | null = null;
let writeChain: Promise<void> = Promise.resolve();

function load(): { agents: StoredAgents } {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(dataPath, "utf8")) as { agents?: StoredAgents };
    cache = { agents: parsed.agents ?? {} };
  } catch {
    cache = { agents: {} };
  }
  return cache;
}

function persist(): void {
  writeChain = writeChain.then(() => {
    try {
      mkdirSync(path.dirname(dataPath), { recursive: true });
      writeFileSync(dataPath, JSON.stringify(load(), null, 2));
    } catch (error) {
      console.error("inline-review: failed to persist comments", error);
    }
  });
}

export function getAgentComments(agentId: string): ReviewComment[] {
  return load().agents[agentId] ?? [];
}

function setAgentComments(agentId: string, comments: ReviewComment[]): void {
  const validated = comments.map((comment) => reviewCommentSchema.parse(comment));
  const store = load();
  if (validated.length === 0) {
    delete store.agents[agentId];
  } else {
    store.agents[agentId] = validated;
  }
  persist();
}

export async function loadComments(
  input: RpcInput<typeof loadCommentsRpc>,
): Promise<{ comments: ReviewComment[] }> {
  return { comments: getAgentComments(input.agentId) };
}

export async function saveComments(
  input: RpcInput<typeof saveCommentsRpc>,
): Promise<{ ok: boolean }> {
  setAgentComments(input.agentId, input.comments);
  return { ok: true };
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
