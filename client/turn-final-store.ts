/**
 * Turn-finality index backed by the client timeline. A final card belongs to
 * the last assistant item after the last tool call of a completed turn.
 */
interface TimelineCursor {
  epoch: string;
  seq: number;
}

interface TimelinePage {
  entries: Array<{
    item: { type: string; text?: string; messageId?: string; status?: string };
    turnId?: string;
    seqEnd: number;
    collapsed?: string[];
  }>;
  agent?: { status?: string } | null;
  hasOlder?: boolean;
  startCursor?: TimelineCursor | null;
}

interface TimelineHandle {
  subscribe(handler: (message: unknown) => void): unknown;
  refetch(options?: {
    direction?: string;
    limit?: number;
    cursor?: TimelineCursor;
  }): Promise<TimelinePage>;
}

type Entry = {
  kind: "user" | "assistant" | "tool";
  id: string | null;
  turnId: string | null;
  seq: number;
  text: string | null;
};

type FinalSelection = {
  entries: Entry[];
  awaitingTurnEnd: boolean;
};

function sameSet(current: Set<string>, next: Set<string>): boolean {
  if (current.size !== next.size) return false;
  for (const item of next) if (!current.has(item)) return false;
  return true;
}

async function refetchWithTimeout(
  timeline: TimelineHandle,
  options: Parameters<TimelineHandle["refetch"]>[0],
  timeoutMs: number,
): Promise<TimelinePage | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      timeline.refetch(options),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface AgentTurnIndex {
  readonly version: number;
  start(): void;
  stop(): void;
  subscribe(cb: () => void): () => void;
  isFinal(messageId: string | null): boolean;
  isFinalText(text: string | null): boolean;
}

function createAgentTurnIndex(timeline: TimelineHandle): AgentTurnIndex {
  let finalIds = new Set<string>();
  let finalTexts = new Set<string>();
  let olderEntries: Entry[] = [];
  let olderComplete = false;
  let backfillStarted = false;
  let version = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timelineUnsubscribe: (() => void) | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  let started = false;
  let stopped = false;
  const listeners = new Set<() => void>();

  function parseEntries(page: TimelinePage): Entry[] {
    const entries: Entry[] = [];
    for (const entry of page.entries) {
      const type = entry.item.type;
      if (type !== "assistant_message" && type !== "user_message" && type !== "tool_call") continue;
      if (type === "assistant_message" && entry.item.text?.trim() === "") continue;
      entries.push({
        kind: type === "assistant_message"
          ? "assistant"
          : type === "user_message"
            ? "user"
            : "tool",
        id: entry.item.messageId ?? null,
        turnId: entry.turnId ?? null,
        seq: entry.seqEnd,
        text: entry.item.text ?? null,
      });
    }
    return entries;
  }

  function selectFinalEntries(entries: Entry[], agentStatus: string | undefined): FinalSelection {
    const selected: Entry[] = [];
    const turns = new Map<string, {
      firstSeq: number;
      lastAssistant: Entry | null;
      lastToolSeq: number;
    }>();
    for (const entry of entries) {
      if (!entry.turnId) continue;
      const turn = turns.get(entry.turnId) ?? {
        firstSeq: entry.seq,
        lastAssistant: null,
        lastToolSeq: Number.NEGATIVE_INFINITY,
      };
      turn.firstSeq = Math.min(turn.firstSeq, entry.seq);
      if (entry.kind === "assistant") turn.lastAssistant = entry;
      if (entry.kind === "tool") turn.lastToolSeq = Math.max(turn.lastToolSeq, entry.seq);
      turns.set(entry.turnId, turn);
    }

    const orderedTurns = [...turns.values()].sort((a, b) => a.firstSeq - b.firstSeq);
    const active = agentStatus === "running" || agentStatus === "initializing";
    const latestTurnClosed = agentStatus !== undefined && !active;
    let awaitingTurnEnd = false;
    for (let index = 0; index < orderedTurns.length; index += 1) {
      const turn = orderedTurns[index];
      const assistantEndsTurn = turn.lastAssistant !== null && turn.lastAssistant.seq > turn.lastToolSeq;
      if (!assistantEndsTurn) continue;
      const isLatestTurn = index === orderedTurns.length - 1;
      if (!isLatestTurn || latestTurnClosed) {
        selected.push(turn.lastAssistant!);
      } else {
        // The final text often arrives just before the agent snapshot becomes
        // idle, with no later timeline event. Poll only during this short gap.
        awaitingTurnEnd = true;
      }
    }

    // Older providers may omit turnId. Retain the user-boundary fallback, but
    // still require that no tool call follows the candidate assistant.
    let anonymousAssistant: Entry | null = null;
    let anonymousToolSeq = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      if (entry.turnId) continue;
      if (entry.kind === "assistant") {
        anonymousAssistant = entry;
      } else if (entry.kind === "tool") {
        anonymousToolSeq = Math.max(anonymousToolSeq, entry.seq);
      } else {
        if (anonymousAssistant && anonymousAssistant.seq > anonymousToolSeq) {
          selected.push(anonymousAssistant);
        }
        anonymousAssistant = null;
        anonymousToolSeq = Number.NEGATIVE_INFINITY;
      }
    }
    if (anonymousAssistant && anonymousAssistant.seq > anonymousToolSeq) {
      if (latestTurnClosed) selected.push(anonymousAssistant);
      else awaitingTurnEnd = true;
    }
    return { entries: selected, awaitingTurnEnd };
  }

  async function backfillOlder(): Promise<void> {
    try {
      let cursor: TimelineCursor | null = null;
      let pages = 0;
      const collected = [...olderEntries];
      while (!stopped && pages < 12) {
        const page = await refetchWithTimeout(
          timeline,
          { direction: "before", cursor: cursor ?? undefined, limit: 400 },
          8000,
        );
        if (!page) return;
        cursor = page.startCursor ?? null;
        collected.push(...parseEntries(page));
        pages += 1;
        if (page.hasOlder === false || cursor === null) break;
      }
      if (stopped) return;
      collected.sort((a, b) => a.seq - b.seq);
      olderEntries = collected.filter(
        (entry, index) => index === 0 || entry.seq !== collected[index - 1].seq,
      );
      olderComplete = true;
      await refresh();
    } catch {
      // A later live update retries after backfillStarted is released below.
    } finally {
      if (!olderComplete) backfillStarted = false;
    }
  }

  function scheduleRefresh(delayMs = 400): void {
    if (stopped || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
  }

  async function refreshOnce(): Promise<void> {
    if (stopped) return;
    try {
      let payload: TimelinePage | null = null;
      const attempts = [
        { direction: "tail", limit: 300 },
        undefined,
        { limit: 300 },
      ] as const;
      for (const attempt of attempts) {
        payload = await refetchWithTimeout(timeline, attempt, 4000);
        if (payload || stopped) break;
      }
      if (!payload || stopped) return;

      if (payload.hasOlder === false) {
        olderEntries = [];
        olderComplete = true;
      } else if (!olderComplete && !backfillStarted) {
        backfillStarted = true;
        void backfillOlder();
      }

      const list = [...olderEntries, ...parseEntries(payload)].sort((a, b) => a.seq - b.seq);
      const deduped = list.filter(
        (entry, index) => index === 0 || entry.seq !== list[index - 1].seq,
      );
      // A live source item can reuse an id across streamed replacements. A
      // unique id in the fetched timeline is safe; exact text is the fallback.
      const idCounts = new Map<string, number>();
      for (const entry of deduped) {
        if (entry.kind === "assistant" && entry.id) {
          idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
        }
      }

      const nextIds = new Set<string>();
      const nextTexts = new Set<string>();
      const addFinal = (entry: Entry | null): void => {
        if (!entry) return;
        if (entry.text) nextTexts.add(entry.text);
        if (entry.id && idCounts.get(entry.id) === 1) {
          nextIds.add(entry.id);
        }
      };
      const selection = selectFinalEntries(deduped, payload.agent?.status);
      for (const entry of selection.entries) addFinal(entry);
      if (selection.awaitingTurnEnd) scheduleRefresh();
      if (sameSet(finalIds, nextIds) && sameSet(finalTexts, nextTexts)) return;
      finalIds = nextIds;
      finalTexts = nextTexts;
      version += 1;
      for (const listener of listeners) listener();
    } catch {
      // Timeline events and the polling fallback provide the next retry.
    }
  }

  /** Serializes refetches and guarantees one trailing refresh after a race. */
  function refresh(): Promise<void> {
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }
    const run = async (): Promise<void> => {
      do {
        refreshQueued = false;
        await refreshOnce();
      } while (refreshQueued && !stopped);
    };
    let operation: Promise<void>;
    operation = run().finally(() => {
      if (refreshInFlight === operation) refreshInFlight = null;
    });
    refreshInFlight = operation;
    return operation;
  }

  function start(): void {
    if (started) return;
    started = true;
    stopped = false;
    try {
      const cleanup = timeline.subscribe(() => scheduleRefresh());
      if (typeof cleanup === "function") timelineUnsubscribe = cleanup as () => void;
    } catch {
      pollTimer = setInterval(() => void refresh(), 5000);
    }
    void refresh();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (pollTimer) clearInterval(pollTimer);
    refreshTimer = null;
    pollTimer = null;
    timelineUnsubscribe?.();
    timelineUnsubscribe = null;
    listeners.clear();
  }

  return {
    get version(): number {
      return version;
    },
    start,
    stop,
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isFinal(messageId: string | null): boolean {
      return messageId !== null && finalIds.has(messageId);
    },
    isFinalText(text: string | null): boolean {
      return text !== null && finalTexts.has(text);
    },
  };
}

type StoredIndex = {
  index: AgentTurnIndex;
  references: number;
  unsubscribe: () => void;
};

const stores = new Map<string, StoredIndex>();
const listeners = new Map<string, Set<() => void>>();

export type TurnFinalCardPosition = "none" | "single" | "start" | "middle" | "end";

type TurnFinalFragment = {
  sourceKey: string;
  messageId: string | null;
  text: string;
  timestamp: number;
  order: number;
  visible: boolean;
  token: symbol;
};

const finalFragments = new Map<string, Map<string, TurnFinalFragment>>();
const finalFragmentListeners = new Map<string, Set<() => void>>();
const finalFragmentVersions = new Map<string, number>();
let nextFinalFragmentOrder = 1;

function hasRenderableText(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    return !/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(trimmed);
  });
}

function notifyFinalFragments(agentId: string): void {
  finalFragmentVersions.set(agentId, (finalFragmentVersions.get(agentId) ?? 0) + 1);
  for (const listener of finalFragmentListeners.get(agentId) ?? []) listener();
}

/** Tracks the still-separate live rows which Paseo later collapses in history. */
export function retainTurnFinalFragment(input: {
  agentId: string;
  sourceKey: string;
  messageId: string | null;
  text: string;
  timestamp: number;
}): () => void {
  const fragments = finalFragments.get(input.agentId) ?? new Map<string, TurnFinalFragment>();
  const token = Symbol(input.sourceKey);
  const existing = fragments.get(input.sourceKey);
  fragments.set(input.sourceKey, {
    sourceKey: input.sourceKey,
    messageId: input.messageId,
    text: input.text,
    timestamp: input.timestamp,
    order: existing?.order ?? nextFinalFragmentOrder++,
    visible: hasRenderableText(input.text),
    token,
  });
  finalFragments.set(input.agentId, fragments);
  notifyFinalFragments(input.agentId);
  return () => {
    const current = finalFragments.get(input.agentId)?.get(input.sourceKey);
    if (!current || current.token !== token) return;
    fragments.delete(input.sourceKey);
    if (fragments.size === 0) finalFragments.delete(input.agentId);
    notifyFinalFragments(input.agentId);
  };
}

export function subscribeTurnFinalFragments(agentId: string, listener: () => void): () => void {
  const agentListeners = finalFragmentListeners.get(agentId) ?? new Set<() => void>();
  agentListeners.add(listener);
  finalFragmentListeners.set(agentId, agentListeners);
  return () => {
    agentListeners.delete(listener);
    if (agentListeners.size === 0) finalFragmentListeners.delete(agentId);
  };
}

export function turnFinalFragmentVersion(agentId: string): number {
  return finalFragmentVersions.get(agentId) ?? 0;
}

/**
 * Returns one visual slice position for a live merged message. No row is
 * hidden: adjacent slices supply one continuous card around their own text.
 */
export function getTurnFinalCardPosition(
  agentId: string,
  sourceKey: string,
): TurnFinalCardPosition {
  const fragment = finalFragments.get(agentId)?.get(sourceKey);
  const index = stores.get(agentId)?.index;
  if (!fragment || !fragment.visible || !index) return "none";
  if (index.isFinalText(fragment.text)) return "single";
  if (!index.isFinal(fragment.messageId)) return "none";

  const siblings = [...(finalFragments.get(agentId)?.values() ?? [])]
    .filter((candidate) => candidate.visible && candidate.messageId === fragment.messageId)
    .sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  const consolidated = siblings.find((candidate) => index.isFinalText(candidate.text));
  if (consolidated) return consolidated.sourceKey === sourceKey ? "single" : "none";
  const position = siblings.findIndex((candidate) => candidate.sourceKey === sourceKey);
  if (position < 0) return "none";
  if (siblings.length === 1) return "single";
  if (position === 0) return "start";
  if (position === siblings.length - 1) return "end";
  return "middle";
}

/** Retains one shared index per agent and tears it down after the last row unmounts. */
export function retainTurnIndex(agentId: string, timeline: TimelineHandle): () => void {
  let stored = stores.get(agentId);
  if (!stored) {
    try {
      const index = createAgentTurnIndex(timeline);
      const unsubscribe = index.subscribe(() => {
        for (const listener of listeners.get(agentId) ?? []) listener();
      });
      stored = { index, references: 0, unsubscribe };
      stores.set(agentId, stored);
      index.start();
    } catch {
      return () => {};
    }
  }
  stored.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = stores.get(agentId);
    if (!current) return;
    current.references -= 1;
    if (current.references > 0) return;
    current.unsubscribe();
    current.index.stop();
    stores.delete(agentId);
  };
}

export function subscribeTurnIndex(agentId: string, cb: () => void): () => void {
  const agentListeners = listeners.get(agentId) ?? new Set<() => void>();
  agentListeners.add(cb);
  listeners.set(agentId, agentListeners);
  return () => {
    agentListeners.delete(cb);
    if (agentListeners.size === 0) listeners.delete(agentId);
  };
}

export function turnIndexVersion(agentId: string): number {
  return stores.get(agentId)?.index.version ?? 0;
}

export function isTurnFinalMessage(agentId: string, messageId: string | null): boolean {
  return stores.get(agentId)?.index.isFinal(messageId) ?? false;
}

export function isTurnFinalText(agentId: string, text: string | null): boolean {
  return stores.get(agentId)?.index.isFinalText(text) ?? false;
}
