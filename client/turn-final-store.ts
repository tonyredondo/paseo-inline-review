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
  pause(): void;
  resume(): void;
  stop(): void;
  setAgentStatus(status: string | undefined): void;
  subscribe(cb: () => void): () => void;
  isFinal(messageId: string | null): boolean;
  isFinalText(text: string | null): boolean;
  ensureKnown(messageId: string | null, text: string | null): void;
}

function createAgentTurnIndex(timeline: TimelineHandle): AgentTurnIndex {
  let finalIds = new Set<string>();
  let finalTexts = new Set<string>();
  const olderEntries = new Map<number, Entry>();
  const tailEntries = new Map<number, Entry>();
  let orderedEntries: Entry[] | null = null;
  let knownAssistantIds = new Set<string>();
  let knownAssistantTexts = new Set<string>();
  let olderComplete = false;
  let olderCursor: TimelineCursor | null = null;
  let timelineEpoch: string | null = null;
  let timelineAgentStatus: string | undefined;
  let snapshotAgentStatus: string | undefined;
  let backfillInFlight: Promise<void> | null = null;
  const requestedMessages = new Map<string, { id: string | null; text: string | null }>();
  let version = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timelineUnsubscribe: (() => void) | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  let started = false;
  let active = false;
  let refreshWhilePaused = false;
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

  function selectFinalEntries(entries: Entry[], agentStatus: string | undefined): Entry[] {
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
    for (let index = 0; index < orderedTurns.length; index += 1) {
      const turn = orderedTurns[index];
      const assistantEndsTurn = turn.lastAssistant !== null && turn.lastAssistant.seq > turn.lastToolSeq;
      if (!assistantEndsTurn) continue;
      const isLatestTurn = index === orderedTurns.length - 1;
      if (!isLatestTurn || latestTurnClosed) {
        selected.push(turn.lastAssistant!);
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
    }
    return selected;
  }

  function invalidateEntries(): void {
    orderedEntries = null;
    knownAssistantIds = new Set();
    knownAssistantTexts = new Set();
    const indexAssistant = (entry: Entry): void => {
      if (entry.kind !== "assistant") return;
      if (entry.id !== null) knownAssistantIds.add(entry.id);
      if (entry.text !== null) knownAssistantTexts.add(entry.text);
    };
    for (const entry of olderEntries.values()) indexAssistant(entry);
    for (const entry of tailEntries.values()) indexAssistant(entry);
  }

  function allEntries(): Entry[] {
    if (orderedEntries) return orderedEntries;
    const merged = new Map(olderEntries);
    for (const [seq, entry] of tailEntries) merged.set(seq, entry);
    orderedEntries = [...merged.values()].sort((a, b) => a.seq - b.seq);
    return orderedEntries;
  }

  function isKnown(request: { id: string | null; text: string | null }): boolean {
    return (
      (request.id !== null && knownAssistantIds.has(request.id)) ||
      (request.text !== null && knownAssistantTexts.has(request.text))
    );
  }

  function effectiveAgentStatus(): string | undefined {
    return snapshotAgentStatus ?? timelineAgentStatus;
  }

  function publishFinals(): void {
    const deduped = allEntries();
    const idCounts = new Map<string, number>();
    for (const entry of deduped) {
      if (entry.kind === "assistant" && entry.id) {
        idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
      }
    }

    const nextIds = new Set<string>();
    const nextTexts = new Set<string>();
    const selection = selectFinalEntries(deduped, effectiveAgentStatus());
    for (const entry of selection) {
      if (entry.text) nextTexts.add(entry.text);
      if (entry.id && idCounts.get(entry.id) === 1) nextIds.add(entry.id);
    }
    if (sameSet(finalIds, nextIds) && sameSet(finalTexts, nextTexts)) return;
    finalIds = nextIds;
    finalTexts = nextTexts;
    version += 1;
    for (const listener of listeners) listener();
  }

  function removeSatisfiedRequests(): void {
    for (const [key, request] of requestedMessages) {
      if (isKnown(request)) requestedMessages.delete(key);
    }
  }

  function startBackfill(): void {
    if (
      stopped || olderComplete || backfillInFlight || requestedMessages.size === 0 || !olderCursor
    ) return;
    const run = async (): Promise<void> => {
      let pages = 0;
      try {
        while (!stopped && !olderComplete && requestedMessages.size > 0 && pages < 12) {
          const cursor = olderCursor;
          if (!cursor) {
            olderComplete = true;
            break;
          }
          const page = await refetchWithTimeout(
            timeline,
            { direction: "before", cursor, limit: 400 },
            8000,
          );
          if (!page || stopped) return;
          if (page.startCursor?.epoch && timelineEpoch && page.startCursor.epoch !== timelineEpoch) {
            olderEntries.clear();
            invalidateEntries();
            olderComplete = false;
            olderCursor = null;
            scheduleRefresh(0);
            return;
          }
          for (const entry of parseEntries(page)) {
            if (!tailEntries.has(entry.seq)) olderEntries.set(entry.seq, entry);
          }
          invalidateEntries();
          olderCursor = page.startCursor ?? null;
          olderComplete = page.hasOlder === false || olderCursor === null;
          pages += 1;
          removeSatisfiedRequests();
          publishFinals();
        }
      } catch {
        // The mounted candidate remains queued and a later timeline update or
        // ensureKnown call retries without creating concurrent page walks.
      }
    };
    let operation: Promise<void>;
    operation = run().finally(() => {
      if (backfillInFlight === operation) backfillInFlight = null;
    });
    backfillInFlight = operation;
  }

  function scheduleRefresh(delayMs = 400): void {
    if (stopped || !active || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
  }

  async function refreshOnce(): Promise<void> {
    if (stopped || !active) return;
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

      const nextEpoch = payload.startCursor?.epoch ?? null;
      if (timelineEpoch && nextEpoch && nextEpoch !== timelineEpoch) {
        olderEntries.clear();
        finalIds = new Set();
        finalTexts = new Set();
      }
      if (nextEpoch) timelineEpoch = nextEpoch;
      tailEntries.clear();
      for (const entry of parseEntries(payload)) tailEntries.set(entry.seq, entry);
      invalidateEntries();
      timelineAgentStatus = payload.agent?.status;
      olderCursor = payload.startCursor ?? null;
      if (payload.hasOlder === false || olderCursor === null) {
        olderEntries.clear();
        invalidateEntries();
        olderComplete = true;
      } else {
        olderComplete = false;
      }
      removeSatisfiedRequests();
      publishFinals();
      startBackfill();
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
    active = true;
    stopped = false;
    try {
      const cleanup = timeline.subscribe(() => {
        if (!active) {
          refreshWhilePaused = true;
          return;
        }
        scheduleRefresh();
      });
      if (typeof cleanup === "function") timelineUnsubscribe = cleanup as () => void;
    } catch {
      pollTimer = setInterval(() => void refresh(), 5000);
    }
    void refresh();
  }

  function pause(): void {
    if (stopped || !active) return;
    active = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function resume(): void {
    if (stopped || active) return;
    active = true;
    if (!timelineUnsubscribe && !pollTimer) {
      pollTimer = setInterval(() => void refresh(), 5000);
    }
    if (refreshWhilePaused) {
      refreshWhilePaused = false;
      scheduleRefresh(0);
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    active = false;
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
    pause,
    resume,
    stop,
    setAgentStatus(status: string | undefined): void {
      if (snapshotAgentStatus === status) return;
      snapshotAgentStatus = status;
      publishFinals();
    },
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
    ensureKnown(messageId: string | null, text: string | null): void {
      if (stopped || (messageId === null && text === null)) return;
      const request = { id: messageId, text };
      if (isKnown(request)) return;
      requestedMessages.set(`${messageId ?? ""}\u0000${text ?? ""}`, request);
      startBackfill();
    },
  };
}

type StoredIndex = {
  index: AgentTurnIndex;
  references: number;
  unsubscribe: () => void;
  disposalTimer: ReturnType<typeof setTimeout> | null;
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
const finalFragmentPositionCache = new Map<string, {
  fragmentVersion: number;
  indexVersion: number;
  positions: Map<string, TurnFinalCardPosition>;
}>();
const finalFragmentPositionBuilds = new Map<string, number>();
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
  finalFragmentPositionCache.delete(agentId);
  for (const listener of finalFragmentListeners.get(agentId) ?? []) listener();
}

export type TurnFinalFragmentInput = {
  agentId: string;
  sourceKey: string;
  messageId: string | null;
  text: string;
  timestamp: number;
};

/**
 * Tracks one mounted row and updates it in place. Ordinary streaming text does
 * not change card topology, so it must not notify every sibling row.
 */
export function mountTurnFinalFragment(input: TurnFinalFragmentInput): {
  update(next: Omit<TurnFinalFragmentInput, "agentId" | "sourceKey">): void;
  release(): void;
} {
  const fragments = finalFragments.get(input.agentId) ?? new Map<string, TurnFinalFragment>();
  const token = Symbol(input.sourceKey);
  finalFragments.set(input.agentId, fragments);

  function update(next: Omit<TurnFinalFragmentInput, "agentId" | "sourceKey">): void {
    const existing = fragments.get(input.sourceKey);
    if (existing && existing.token !== token) return;
    const index = stores.get(input.agentId)?.index;
    const visible = hasRenderableText(next.text);
    const oldFinalText = existing ? (index?.isFinalText(existing.text) ?? false) : false;
    const nextFinalText = index?.isFinalText(next.text) ?? false;
    const topologyChanged = !existing ||
      existing.messageId !== next.messageId ||
      existing.timestamp !== next.timestamp ||
      existing.visible !== visible ||
      oldFinalText !== nextFinalText;
    fragments.set(input.sourceKey, {
      sourceKey: input.sourceKey,
      messageId: next.messageId,
      text: next.text,
      timestamp: next.timestamp,
      order: existing?.order ?? nextFinalFragmentOrder++,
      visible,
      token,
    });
    index?.ensureKnown(next.messageId, next.text);
    if (topologyChanged) notifyFinalFragments(input.agentId);
  }

  update(input);
  return {
    update,
    release(): void {
      const current = finalFragments.get(input.agentId)?.get(input.sourceKey);
      if (!current || current.token !== token) return;
      fragments.delete(input.sourceKey);
      if (fragments.size === 0) finalFragments.delete(input.agentId);
      notifyFinalFragments(input.agentId);
    },
  };
}

/** Compatibility helper for tests and one-shot consumers. */
export function retainTurnFinalFragment(input: TurnFinalFragmentInput): () => void {
  const mounted = mountTurnFinalFragment(input);
  return () => mounted.release();
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
  const fragments = finalFragments.get(agentId);
  const index = stores.get(agentId)?.index;
  if (!fragments || !index) return "none";
  const fragmentVersion = finalFragmentVersions.get(agentId) ?? 0;
  const cached = finalFragmentPositionCache.get(agentId);
  if (cached && cached.fragmentVersion === fragmentVersion && cached.indexVersion === index.version) {
    return cached.positions.get(sourceKey) ?? "none";
  }

  const positions = new Map<string, TurnFinalCardPosition>();
  const groups = new Map<string, TurnFinalFragment[]>();
  for (const fragment of fragments.values()) {
    if (!fragment.visible) continue;
    if (fragment.messageId !== null && index.isFinal(fragment.messageId)) {
      const siblings = groups.get(fragment.messageId) ?? [];
      siblings.push(fragment);
      groups.set(fragment.messageId, siblings);
    } else if (index.isFinalText(fragment.text)) {
      positions.set(fragment.sourceKey, "single");
    }
  }
  for (const siblings of groups.values()) {
    const consolidated = siblings.find((candidate) => index.isFinalText(candidate.text));
    if (consolidated) {
      positions.set(consolidated.sourceKey, "single");
      continue;
    }
    siblings.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
    siblings.forEach((fragment, position) => {
      positions.set(
        fragment.sourceKey,
        siblings.length === 1
          ? "single"
          : position === 0
            ? "start"
            : position === siblings.length - 1
              ? "end"
              : "middle",
      );
    });
  }
  finalFragmentPositionBuilds.set(agentId, (finalFragmentPositionBuilds.get(agentId) ?? 0) + 1);
  finalFragmentPositionCache.set(agentId, { fragmentVersion, indexVersion: index.version, positions });
  return positions.get(sourceKey) ?? "none";
}

const TURN_INDEX_GRACE_MS = 120_000;

function disposeStoredIndex(agentId: string, stored: StoredIndex): void {
  if (stores.get(agentId) !== stored) return;
  if (stored.disposalTimer) clearTimeout(stored.disposalTimer);
  stored.disposalTimer = null;
  stored.unsubscribe();
  stored.index.stop();
  stores.delete(agentId);
}

/** Retains one shared index per agent and keeps it warm across virtualized remounts. */
export function retainTurnIndex(
  agentId: string,
  timeline: TimelineHandle,
  graceMs = TURN_INDEX_GRACE_MS,
): () => void {
  let stored = stores.get(agentId);
  if (!stored) {
    try {
      const index = createAgentTurnIndex(timeline);
      const unsubscribe = index.subscribe(() => {
        for (const listener of listeners.get(agentId) ?? []) listener();
      });
      stored = { index, references: 0, unsubscribe, disposalTimer: null };
      stores.set(agentId, stored);
      index.start();
      for (const fragment of finalFragments.get(agentId)?.values() ?? []) {
        index.ensureKnown(fragment.messageId, fragment.text);
      }
    } catch {
      return () => {};
    }
  }
  if (stored.disposalTimer) clearTimeout(stored.disposalTimer);
  stored.disposalTimer = null;
  if (stored.references === 0) stored.index.resume();
  stored.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = stores.get(agentId);
    if (!current) return;
    current.references -= 1;
    if (current.references > 0) return;
    current.index.pause();
    if (graceMs <= 0) {
      disposeStoredIndex(agentId, current);
      return;
    }
    current.disposalTimer = setTimeout(() => {
      if (current.references === 0) disposeStoredIndex(agentId, current);
    }, graceMs);
    (current.disposalTimer as unknown as { unref?: () => void }).unref?.();
  };
}

/** Immediate plugin lifecycle boundary; no grace period survives a reload. */
export function disposeTurnIndexes(): void {
  for (const [agentId, stored] of stores) disposeStoredIndex(agentId, stored);
  stores.clear();
  listeners.clear();
  finalFragments.clear();
  finalFragmentListeners.clear();
  finalFragmentVersions.clear();
  finalFragmentPositionCache.clear();
  finalFragmentPositionBuilds.clear();
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

/** Applies the host agent snapshot without waiting for another timeline RPC. */
export function updateTurnAgentStatus(agentId: string, status: string | undefined): void {
  stores.get(agentId)?.index.setAgentStatus(status);
}

export function turnFinalFragmentDiagnostics(agentId: string): { positionBuilds: number } {
  return { positionBuilds: finalFragmentPositionBuilds.get(agentId) ?? 0 };
}
