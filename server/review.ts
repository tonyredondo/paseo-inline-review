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
  setActiveAgentRpc,
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
let activeAgentId: string | null = null;
const lastServed = new Map<string, { marker: string; ids: string[] }>();
const watchers = new Map<string, () => void>();

export function setActiveAgent(agentId: string): void {
  activeAgentId = agentId;
}

export async function setActiveAgentHandler(
  input: RpcInput<typeof setActiveAgentRpc>,
): Promise<{ ok: boolean }> {
  activeAgentId = input.agentId;
  return { ok: true };
}

export function bindPaseo(paseo: PaseoApi): void {
  paseoRef = paseo;
}

let agentTitleCache: { at: number; titles: Map<string, string> } | null = null;

async function agentTitles(paseo: PaseoApi): Promise<Map<string, string>> {
  if (agentTitleCache && Date.now() - agentTitleCache.at < 30_000) return agentTitleCache.titles;
  const titles = new Map<string, string>();
  try {
    const result = await paseo.agents.list();
    for (const entry of result.entries) {
      titles.set(entry.agent.id, entry.agent.title ?? "");
    }
  } catch (error) {
    console.error("inline-review: agent list failed", error);
  }
  agentTitleCache = { at: Date.now(), titles };
  return titles;
}

export async function searchDrafts(
  _input: RpcInput<typeof draftSearchRpc>,
  context: PluginHandlerContext,
): Promise<{ items: { id: string; identifier: string; title: string; subtitle?: string; url: string; text: string; resourceType: string }[] }> {
  bindPaseo(context.paseo);
  const titles = await agentTitles(context.paseo);
  const items: {
    id: string; identifier: string; title: string; subtitle?: string; url: string; text: string; resourceType: string;
  }[] = [];
  // Only the currently visible agent's draft is offered; agents with no
  // pending comments are never offered at all.
  const candidates = activeAgentId
    ? [activeAgentId]
    : Object.keys(load().agents);
  for (const agentId of candidates) {
    const comments = getAgentComments(agentId);
    const pending = comments.filter((comment) => comment.status === "pending");
    if (pending.length === 0) continue;
    const agentTitle = titles.get(agentId) || `agent ${agentId.slice(0, 6)}`;
    const draft = formatReview(comments);
    lastServed.set(agentId, { marker: "", ids: pending.map((comment) => comment.id) });
    items.push({
      id: `review-draft-${agentId}`,
      identifier: `Attach all pending comments (${pending.length} ${pending.length === 1 ? "comment" : "comments"})`,
      title: `Attach all pending comments (${pending.length} ${pending.length === 1 ? "comment" : "comments"})`,
      subtitle: `All un-sent inline review comments · ${agentTitle}`,
      url: `https://inline-review.local/draft/${encodeURIComponent(agentId)}`,
      text: draft,
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
      // Attachments may be delivered outside user_message.text, so a user
      // message arriving after the draft was served marks it sent.
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
