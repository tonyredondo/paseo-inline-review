import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Turn-final index, server-side. The host lifecycle fires agent.turn_ended
 * with the turn's timeline; the last assistant_message with a messageId in
 * that snapshot is the turn-final message. The client asks for the ids over
 * RPC — this works on every platform (the client-side timeline.refetch()
 * hangs forever on the 0.8.0 iPad host).
 */

const dataPath = path.join(
  process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
  "plugin-data",
  "inline-review",
  "turn-final.json",
);

/** agentId -> array of turn-final assistant messageIds (most recent last). */
let index: Record<string, string[]> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function load(): Record<string, string[]> {
  if (index) return index;
  try {
    const parsed = JSON.parse(readFileSync(dataPath, "utf8")) as Record<string, string[]>;
    index = parsed;
  } catch {
    index = {};
  }
  return index;
}

function persist(): void {
  writeChain = writeChain.then(() => {
    try {
      mkdirSync(path.dirname(dataPath), { recursive: true });
      const tmp = `${dataPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(load(), null, 2));
      renameSync(tmp, dataPath);
    } catch (error) {
      console.error("inline-review: failed to persist turn-final index", error);
    }
  });
}

/** Keeps each agent's list bounded (40 turns is plenty for one screen). */
function trim(ids: string[]): string[] {
  return ids.slice(-40);
}

/** Record the turn-final assistant messageId for the turn that just ended. */
export function noteTurnEnded(agentId: string, turnId: string | null, timeline: readonly { type: string; messageId?: string }[]): void {
  if (!turnId) return;
  let finalId: string | null = null;
  for (const item of timeline) {
    if (item.type === "assistant_message" && item.messageId) finalId = item.messageId;
  }
  if (!finalId) return;
  const store = load();
  const current = new Set(store[agentId] ?? []);
  current.add(finalId);
  store[agentId] = trim([...current]);
  persist();
}

export function getTurnFinalIds(agentId: string): string[] {
  return load()[agentId] ?? [];
}


