/**
 * Turn-finality index, backed by the agent timeline API. On every platform
 * (web, iPhone, iPad) the plugin can refetch the ordered timeline entries —
 * each carrying its turnId — so the last assistant message of every turn is
 * known from data instead of DOM probing.
 *
 * Implemented as a closure factory, NOT a class: class lowering (fields,
 * parameter properties, static methods) breaks the native Hermes plugin
 * bundle with "Cannot read property 'prototype' of undefined".
 */
/** Minimal structural type — avoids importing @getpaseo/client in the client bundle. */
interface TimelineHandle {
  subscribe(handler: (message: unknown) => void): unknown;
  refetch(options?: { direction?: string; limit?: number }): Promise<{
    entries: Array<{
      item: { type: string; text?: string; messageId?: string };
      turnId?: string;
      seqEnd: number;
    }>;
  }>;
}

type Entry = { kind: "user" | "assistant"; id: string | null; turnId: string | null; seq: number };

interface AgentTurnIndex {
  readonly version: number;
  start(): void;
  refresh(): Promise<void>;
  subscribe(cb: () => void): () => void;
  isFinal(messageId: string | null): boolean;
  replaceFinals(ids: string[]): void;
}

function createAgentTurnIndex(agentId: string, timeline: TimelineHandle): AgentTurnIndex {
  let finalIds = new Set<string>();
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  const listeners = new Set<() => void>();

  function scheduleRefresh(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, 400);
  }

  async function refresh(): Promise<void> {
    noteDiag(agentId, "refresh-enter");
    try {
      // Native note: the 0.8.0 host on iPad can leave refetch() pending
      // forever; retry with different shapes, each with a 4s timeout.
      let payload: Awaited<ReturnType<TimelineHandle["refetch"]>> | null = null;
      const attempts = [
        { direction: "tail", limit: 300 },
        undefined,
        { limit: 300 },
      ] as const;
      for (const attempt of attempts) {
        const raced = await Promise.race([
          timeline.refetch(attempt).then((value) => ({ ok: true as const, value })),
          new Promise<{ ok: false }>((resolve) =>
            setTimeout(() => resolve({ ok: false }), 4000),
          ),
        ]);
        if (raced.ok) {
          payload = raced.value;
          break;
        }
        if (attempt === undefined) {
          noteDiag(agentId, "RF:all-timeout");
          return;
        }
      }
      if (!payload) return;
      noteDiag(agentId, `ok:${payload.entries.length}e:${payload.entries.filter((e) => e.turnId).length}tid`);
      const list: Entry[] = [];
      for (const entry of payload.entries) {
        const t = entry.item.type;
        if (t !== "assistant_message" && t !== "user_message") continue;
        // Empty assistant messages (streaming placeholders, aborted turns)
        // must not claim turn-finality — they render as empty bordered boxes.
        if (t === "assistant_message" && entry.item.text?.trim() === "") continue;
        const id = entry.item.messageId ?? null;
        list.push({
          kind: t === "assistant_message" ? "assistant" : "user",
          id,
          turnId: entry.turnId ?? null,
          seq: entry.seqEnd,
        });
      }
      list.sort((a, b) => a.seq - b.seq);
      const next = new Set<string>();
      const lastByTurn = new Map<string, string>();
      for (const entry of list) {
        if (entry.kind === "assistant" && entry.id) {
          lastByTurn.set(entry.turnId ?? "-", entry.id);
        }
      }
      for (const id of lastByTurn.values()) next.add(id);
      finalIds = next;
      version += 1;
      for (const cb of listeners) cb();
    } catch (error) {
      noteDiag(agentId, `refetch-fail:${String(error).slice(0, 60)}`);
      // Transient daemon hiccup: the next timeline event schedules a retry.
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    // Live updates: any stream/replacement message schedules a refetch —
    // the refetch page is the single source of truth (ordered, with turnId).
    try {
      timeline.subscribe(() => {
        scheduleRefresh();
      });
    } catch (error) {
      noteDiag(agentId, `no-sub:${String(error).slice(0, 30)}`);
      // Without subscribe there are no live events; poll instead.
      pollTimer = setInterval(() => void refresh(), 5000);
    }
    void refresh();
  }

  return {
    get version(): number {
      return version;
    },
    start,
    refresh,
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    isFinal(messageId: string | null): boolean {
      if (!messageId) return false;
      return finalIds.has(messageId);
    },
    replaceFinals(ids: string[]): void {
      finalIds = new Set(ids);
      version += 1;
      for (const cb of listeners) cb();
    },
  };
}

const stores = new Map<string, AgentTurnIndex>();
const listeners = new Set<() => void>();
const diags = new Map<string, string>();

export function noteDiag(agentId: string, message: string): void {
  diags.set(agentId, message);
  for (const cb of listeners) cb();
}

/** Installs (once) the timeline index for an agent handle. */
export function ensureTurnIndex(agentId: string, timeline: TimelineHandle): void {
  if (stores.has(agentId)) return;
  try {
    const store = createAgentTurnIndex(agentId, timeline);
    stores.set(agentId, store);
    store.start();
    store.subscribe(() => {
      for (const cb of listeners) cb();
    });
  } catch (error) {
    noteDiag(agentId, `INSTALL:${String(error).slice(0, 40)}`);
    stores.delete(agentId);
  }
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

/** Server-fed final ids. Replaces the index contents (all platforms). */
export function feedTurnFinals(agentId: string, ids: string[]): void {
  let store = stores.get(agentId);
  if (!store) {
    store = createAgentTurnIndex(agentId, {
      subscribe: () => () => {},
      refetch: async () => ({ entries: [] }),
    });
    stores.set(agentId, store);
    store.subscribe(() => {
      for (const cb of listeners) cb();
    });
    store.start();
  }
  store.replaceFinals(ids);
}
