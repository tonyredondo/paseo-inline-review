/**
 * Turn-finality index, backed by the agent timeline API. On every platform
 * (web, iPhone, iPad) the plugin can refetch the ordered timeline entries —
 * each carrying the item and its turnId — so the last assistant message of
 * every turn is known from data instead of DOM probing.
 */
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";

type TurnEntry = { kind: "user" | "assistant"; id: string | null; turnId: string | null; seq: number };

class AgentTurnIndex {
  finalIds = new Set<string>();
  version = 0;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    readonly agentId: string,
    private readonly timeline: PaseoAgentTimelineHandle,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    // Live updates: any stream/replacement message schedules a refetch —
    // the refetch page is the single source of truth (ordered, with turnId).
    this.timeline.subscribe(() => {
      this.scheduleRefresh();
    });
    void this.refresh();
  }

  private scheduleRefresh(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, 400);
  }

  async refresh(): Promise<void> {
    try {
      const payload = await this.timeline.refetch({ direction: "tail", limit: 300 });
      const list: Entry[] = [];
      for (const entry of payload.entries) {
        const t = entry.item.type;
        if (t !== "assistant_message" && t !== "user_message") continue;
        // Empty assistant messages (streaming placeholders, aborted turns)
        // must not claim turn-finality — they render as empty bordered boxes.
        if (t === "assistant_message" && (entry.item as { text?: string }).text?.trim() === "") {
          continue;
        }
        const id =
          t === "assistant_message"
            ? entry.item.messageId ?? null
            : t === "user_message"
              ? (entry.item as { messageId?: string }).messageId ?? null
              : null;
        list.push({
          kind: t === "assistant_message" ? "assistant" : "user",
          id,
          turnId: entry.turnId ?? null,
          seq: entry.seqEnd,
        });
      }
      list.sort((a, b) => a.seq - b.seq);
      const finalIds = new Set<string>();
      const lastByTurn = new Map<string, string>();
      for (const entry of list) {
        if (entry.kind === "assistant" && entry.id) {
          lastByTurn.set(entry.turnId ?? "-", entry.id);
        }
      }
      for (const id of lastByTurn.values()) finalIds.add(id);
      this.finalIds = finalIds;
      this.version += 1;
      for (const cb of this.listeners) cb();
    } catch {
      // Transient daemon hiccup: the next timeline event schedules a retry.
    }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  isFinal(messageId: string | null): boolean {
    if (!messageId) return false;
    return this.finalIds.has(messageId);
  }
}

type Entry = { kind: "user" | "assistant"; id: string | null; turnId: string | null; seq: number };

const stores = new Map<string, AgentTurnIndex>();
const listeners = new Set<() => void>();

/** Installs (once) the timeline index for an agent handle. */
export function ensureTurnIndex(agentId: string, timeline: PaseoAgentTimelineHandle): void {
  if (stores.has(agentId)) return;
  const store = new AgentTurnIndex(agentId, timeline);
  stores.set(agentId, store);
  store.start();
  store.subscribe(() => {
    for (const cb of listeners) cb();
  });
}

export function subscribeTurnIndex(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function turnIndexVersion(agentId: string): number {
  return stores.get(agentId)?.version ?? 0;
}

export function isTurnFinalMessage(agentId: string, messageId: string | null): boolean {
  return stores.get(agentId)?.isFinal(messageId) ?? false;
}
