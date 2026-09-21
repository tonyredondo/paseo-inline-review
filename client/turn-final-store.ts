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
interface TimelineCursor {
  epoch: string;
  seq: number;
}
interface TimelineHandle {
  subscribe(handler: (message: unknown) => void): unknown;
  refetch(options?: {
    direction?: string;
    limit?: number;
    cursor?: TimelineCursor;
  }): Promise<{
    entries: Array<{
      item: { type: string; text?: string; messageId?: string };
      turnId?: string;
      seqEnd: number;
    }>;
    epoch?: string;
    hasOlder?: boolean;
    startCursor?: TimelineCursor | null;
    endCursor?: TimelineCursor | null;
  }>;
}

type Entry = { kind: "user" | "assistant"; id: string | null; turnId: string | null; seq: number; text: string | null };

type TimelinePage = Awaited<ReturnType<TimelineHandle["refetch"]>>;
type PageRace = { ok: true; value: TimelinePage } | { ok: false };

interface AgentTurnIndex {
  readonly version: number;
  start(): void;
  refresh(): Promise<void>;
  subscribe(cb: () => void): () => void;
  isFinal(messageId: string | null): boolean;
  isFinalText(text: string | null): boolean;
  replaceFinals(ids: string[]): void;
}

function createAgentTurnIndex(agentId: string, timeline: TimelineHandle): AgentTurnIndex {
  let finalIds = new Set<string>();
  let finalTexts = new Set<string>();
  let olderEntries: Entry[] = [];
  let olderComplete = false;
  let backfillStarted = false;
  let version = 0;

  /** Fetches history pages once, after the first tail refresh settles. */
  function backfillOlder(): void {
    void (async () => {
      try {
        let cursor: TimelineCursor | null = null;
        let pages = 0;
        const collected: Entry[] = [...olderEntries];
        while (pages < 12) {
          const racedPage: PageRace = await Promise.race([
            timeline.refetch({ direction: "before", cursor: cursor ?? undefined, limit: 400 }).then(
              (value): PageRace => ({ ok: true, value }),
            ),
            new Promise<PageRace>((resolve) => setTimeout(() => resolve({ ok: false }), 8000)),
          ]);
          if (!racedPage.ok) {
            noteDiag(agentId, "backfill-timeout");
            return;
          }
          const page: TimelinePage = racedPage.value;
          cursor = page.startCursor ?? null;
          for (const entry of page.entries) {
            const t = entry.item.type;
            if (t !== "assistant_message" && t !== "user_message") continue;
            collected.push({
              kind: t === "assistant_message" ? "assistant" : "user",
              id: entry.item.messageId ?? null,
              turnId: entry.turnId ?? null,
              seq: entry.seqEnd,
              text: entry.item.text ?? null,
            });
          }
          pages += 1;
          if (page.hasOlder === false || cursor === null) break;
        }
        collected.sort((a, b) => a.seq - b.seq);
        const dedup: Entry[] = [];
        for (let i = 0; i < collected.length; i += 1) {
          if (i > 0 && collected[i].seq === collected[i - 1].seq) continue;
          dedup.push(collected[i]);
        }
        olderEntries = dedup;
        olderComplete = true;
        noteDiag(agentId, `backfill:${dedup.length}e`);
        void refresh();
      } catch (error) {
        noteDiag(agentId, `backfill-fail:${String(error).slice(0, 40)}`);
      }
    })();
  }

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
// Backfill: the tail page only covers the last N entries; older turns
      // (revealed when the user scrolls up) need their boundaries too. The
      // backfill runs at most ONCE per store (latched) so streaming refreshes
      // stay cheap; the tail page itself is re-fetched every refresh.
      const tail = payload.entries;
      if (payload.hasOlder === false) {
        olderEntries = [];
        olderComplete = true;
      } else if (!olderComplete && !backfillStarted) {
        backfillStarted = true;
        void backfillOlder();
      }
      const list: Entry[] = [...olderEntries];
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
          text: entry.item.text ?? null,
        });
      }
      list.sort((a, b) => a.seq - b.seq);
      // Dedupe by seq (cached older entries may overlap the tail page).
      let dedupList: Entry[] = [];
      for (let i = 0; i < list.length; i += 1) {
        if (i > 0 && list[i].seq === list[i - 1].seq) continue;
        dedupList.push(list[i]);
      }
      // Turn-final = the last assistant message BEFORE each user message
      // (skipping neutral/empty items). Host turnIds are per internal agent
      // turn — a single user turn can contain many of them (tool runs),
      // so grouping by turnId styles every segment as its own card.
      const next = new Set<string>();
      const nextTexts = new Set<string>();
      let lastAssistantId: string | null = null;
      let lastAssistantText: string | null = null;
      for (const entry of dedupList) {
        if (entry.kind === "assistant") {
          if (entry.id) lastAssistantId = entry.id;
          if (entry.text) lastAssistantText = entry.text;
        } else if (entry.kind === "user" && (lastAssistantId || lastAssistantText)) {
          if (lastAssistantId) next.add(lastAssistantId);
          if (lastAssistantText) nextTexts.add(lastAssistantText);
          lastAssistantId = null;
          lastAssistantText = null;
        }
      }
      if (lastAssistantId) next.add(lastAssistantId);
      if (lastAssistantText) nextTexts.add(lastAssistantText);
      finalIds = next;
      finalTexts = nextTexts;
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
    isFinalText(text: string | null): boolean {
      if (!text) return false;
      return finalTexts.has(text);
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

/** Text-based match: the host re-uses one messageId across every streamed
 * segment of a turn (codex), so message ids alone cannot mark ONE segment. */
export function isTurnFinalText(agentId: string, text: string | null): boolean {
  return stores.get(agentId)?.isFinalText(text) ?? false;
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
