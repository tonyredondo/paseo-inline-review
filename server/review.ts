import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  draftSearchRpc,
  formatReview,
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
  if (getAgentComments(input.agentId).some((comment) => comment.status === "pending")) {
    ensureWatch(input.agentId);
  }
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

// --- Draft serving + sent detection ----------------------------------------

let paseoRef: PaseoApi | null = null;
const lastServed = new Map<string, { marker: string; ids: string[] }>();
const watchers = new Map<string, () => void>();

export function bindPaseo(paseo: PaseoApi): void {
  paseoRef = paseo;
}

export async function searchDrafts(
  _input: RpcInput<typeof draftSearchRpc>,
  context: PluginHandlerContext,
): Promise<{ items: { id: string; identifier: string; title: string; subtitle?: string; url: string; text: string; resourceType: string }[] }> {
  bindPaseo(context.paseo);
  const items: {
    id: string; identifier: string; title: string; subtitle?: string; url: string; text: string; resourceType: string;
  }[] = [];
  for (const [agentId, comments] of Object.entries(load().agents)) {
    const pending = comments.filter((comment) => comment.status === "pending");
    if (pending.length === 0) continue;
    const draft = formatReview(comments);
    const marker = `[inline-review draft ${agentId.slice(0, 8)}-${Date.now().toString(36)}]`;
    lastServed.set(agentId, { marker, ids: pending.map((comment) => comment.id) });
    items.push({
      id: `review-draft-${agentId}`,
      identifier: `review:${agentId}`,
      title: `Review draft (${pending.length} pending)`,
      subtitle: "Inline review comments",
      url: `https://inline-review.local/draft/${encodeURIComponent(agentId)}`,
      text: `${draft}\n\n${marker}`,
      resourceType: "review",
    });
    ensureWatch(agentId);
  }
  return { items };
}

function ensureWatch(agentId: string): void {
  if (!paseoRef || watchers.has(agentId)) return;
  try {
    const unsubscribe = paseoRef.agents.ref(agentId).timeline.subscribe((event) => {
      if (event.event.type !== "timeline") return;
      const item = event.event.item;
      if (item.type !== "user_message") return;
      const served = lastServed.get(agentId);
      if (!served) return;
      if (!item.text.includes(served.marker)) return;
      const updated = getAgentComments(agentId).map((comment) =>
        served.ids.includes(comment.id) ? { ...comment, status: "sent" as const } : comment,
      );
      setAgentComments(agentId, updated);
      lastServed.delete(agentId);
      console.log(`inline-review: marked ${served.ids.length} comment(s) sent for ${agentId}`);
    });
    watchers.set(agentId, unsubscribe);
  } catch (error) {
    console.error("inline-review: timeline watch failed", error);
  }
}
