/**
 * Turn-finality index backed by the client timeline. A final card belongs to
 * the last assistant item after the last tool call of a completed turn.
 */
interface TimelineCursor {
  epoch: string;
  seq: number;
}

type TimelineItem = { type: string; text?: string; messageId?: string; status?: string };

interface TimelinePage {
  entries: Array<{
    item: TimelineItem;
    turnId?: string;
    seqStart?: number;
    seqEnd: number;
    collapsed?: string[];
  }>;
  agent?: { status?: string } | null;
  hasOlder?: boolean;
  startCursor?: TimelineCursor | null;
}

type TimelineSubscriptionEvent = {
  agentId?: string;
  epoch?: string;
  seq?: number;
  event?: {
    type?: string;
    item?: TimelineItem;
    turnId?: string;
    epoch?: string;
  };
};

interface TimelineHandle {
  subscribe(handler: (message: unknown) => void): unknown;
  refetch(options?: {
    direction?: string;
    limit?: number;
    cursor?: TimelineCursor;
  }): Promise<TimelinePage>;
}

const INITIAL_TAIL_ENTRIES = 100;
const HISTORICAL_PAGE_ENTRIES = 200;
const INCREMENTAL_PUBLISH_MS = 50;

type Entry = {
  kind: "user" | "assistant" | "tool";
  id: string | null;
  idSafe: boolean;
  turnId: string | null;
  seqStart: number;
  seq: number;
  text: string | null;
};

function sameSet(current: Set<string>, next: Set<string>): boolean {
  if (current.size !== next.size) return false;
  for (const item of next) if (!current.has(item)) return false;
  return true;
}

function sameMap(current: Map<string, string>, next: Map<string, string>): boolean {
  if (current.size !== next.size) return false;
  for (const [key, value] of next) if (current.get(key) !== value) return false;
  return true;
}

const ASSISTANT_EDGE_SEPARATOR = /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const MEMORY_CITATION_START = "<oai-mem-citation>";
const MEMORY_CITATION_END = "</oai-mem-citation>";

/** Mirrors Paseo hiding from the first memory marker through a valid trailing close. */
function stripTrailingHiddenAssistantMetadata(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const closing = normalized.lastIndexOf(MEMORY_CITATION_END);
  if (closing < 0 || normalized.slice(closing + MEMORY_CITATION_END.length).trim().length > 0) {
    return text;
  }
  const opening = normalized.indexOf(MEMORY_CITATION_START);
  if (opening < 0 || opening > closing) return text;

  const visibleLines = normalized.slice(0, opening).split("\n");
  while (visibleLines.length > 0 && visibleLines[visibleLines.length - 1].trim().length === 0) {
    visibleLines.pop();
  }
  return visibleLines.join("\n");
}

/**
 * Older/native clients can expose the visible assistant row without the
 * formatting-only rule that remains in the daemon's merged timeline text.
 * Ignore only blank lines and horizontal rules at the two edges; internal
 * Markdown and whitespace stay significant.
 */
function canonicalAssistantText(text: string): string {
  const lines = stripTrailingHiddenAssistantMetadata(text).replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  const discardEdge = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed.length === 0 || ASSISTANT_EDGE_SEPARATOR.test(trimmed);
  };
  while (start < end && discardEdge(lines[start])) start += 1;
  while (end > start && discardEdge(lines[end - 1])) end -= 1;
  return lines.slice(start, end).join("\n");
}

type RefetchOutcome =
  | { kind: "fulfilled"; page: TimelinePage }
  | { kind: "rejected"; error: unknown }
  | { kind: "timed-out"; pending: Promise<void> };

async function refetchWithTimeout(
  timeline: TimelineHandle,
  options: Parameters<TimelineHandle["refetch"]>[0],
  timeoutMs: number,
): Promise<RefetchOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = timeline.refetch(options);
  const settled: Promise<RefetchOutcome> = request.then(
    (page): RefetchOutcome => ({ kind: "fulfilled", page }),
    (error): RefetchOutcome => ({ kind: "rejected", error }),
  );
  try {
    return await Promise.race([
      settled,
      new Promise<RefetchOutcome>((resolve) => {
        timer = setTimeout(() => resolve({
          kind: "timed-out",
          // Keep ownership of the uncancellable SDK request. Callers must not
          // issue a replacement RPC until this one has actually settled.
          pending: settled.then(() => {}),
        }), timeoutMs);
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
  finalText(messageId: string | null, text: string | null): string | null;
  trackLiveCandidate(sourceKey: string, messageId: string | null, text: string | null): void;
  ensureKnown(sourceKey: string, messageId: string | null, text: string | null): void;
  forgetKnown(sourceKey: string): void;
  diagnostics(): { tailEntries: number; liveEntries: number };
}

function createAgentTurnIndex(timeline: TimelineHandle): AgentTurnIndex {
  let finalIds = new Set<string>();
  let finalTexts = new Set<string>();
  let finalTextById = new Map<string, string>();
  let finalTextByCanonicalText = new Map<string, string>();
  const olderEntries = new Map<number, Entry>();
  const tailEntries = new Map<number, Entry>();
  const liveEntries = new Map<number, Entry | null>();
  let orderedEntries: Entry[] | null = null;
  let knownAssistantIds = new Set<string>();
  let knownAssistantTexts = new Set<string>();
  let olderComplete = false;
  let olderCursor: TimelineCursor | null = null;
  let timelineEpoch: string | null = null;
  let timelineAgentStatus: string | undefined;
  let snapshotAgentStatus: string | undefined;
  let eventAgentStatus: string | undefined;
  let backfillInFlight: Promise<void> | null = null;
  let backfillBlockedByRpc: Promise<void> | null = null;
  const liveCandidates = new Map<string, { id: string | null; text: string | null }>();
  const requestedMessages = new Map<string, { id: string | null; text: string | null }>();
  let version = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let incrementalTimer: ReturnType<typeof setTimeout> | null = null;
  let incrementalDirty = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timelineUnsubscribe: (() => void) | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let liveReconciliationInFlight: Promise<void> | null = null;
  let refreshBlockedByRpc: Promise<void> | null = null;
  let refreshQueued = false;
  let started = false;
  let active = false;
  let refreshWhilePaused = false;
  let stopped = false;
  const listeners = new Set<() => void>();

  let lastObservedSeq: number | null = null;

  function parseEntry(
    item: TimelineItem,
    turnId: string | undefined,
    seq: number,
    existing?: Entry,
    allowEmptyAssistant = false,
  ): Entry | null {
    const type = item.type;
    if (type !== "assistant_message" && type !== "user_message" && type !== "tool_call") return null;
    if (!allowEmptyAssistant && type === "assistant_message" && item.text?.trim() === "") return null;
    const entry = existing ?? {
      kind: "tool",
      id: null,
      idSafe: true,
      turnId: null,
      seqStart: seq,
      seq,
      text: null,
    };
    const nextId = item.messageId ?? null;
    if (existing && existing.id !== nextId) entry.idSafe = true;
    entry.kind = type === "assistant_message"
      ? "assistant"
      : type === "user_message"
        ? "user"
        : "tool";
    entry.id = nextId;
    entry.turnId = turnId ?? null;
    entry.seq = seq;
    entry.text = item.text ?? null;
    return entry;
  }

  function mergeAssistantEntries(
    previous: Entry | undefined,
    next: Entry | null,
  ): Entry | null {
    if (
      !previous || !next || previous.kind !== "assistant" || next.kind !== "assistant" ||
      previous.seq + 1 !== next.seqStart || previous.turnId !== next.turnId
    ) return null;
    if (previous.id !== null && next.id !== null && previous.id !== next.id) return null;
    const previousText = previous.text ?? "";
    const fragment = next.text ?? "";
    return {
      kind: "assistant",
      id: next.id ?? previous.id,
      // Several raw rows may reuse one provider ID. The concatenated text is
      // exact, but that ID is not safe for selecting every rendered sibling.
      idSafe: false,
      turnId: previous.turnId,
      seqStart: previous.seqStart,
      seq: next.seq,
      // Newer hosts stream deltas. Older/compatibility paths may repeat the
      // accumulated text, which must replace rather than duplicate the prefix.
      text: fragment.startsWith(previousText) ? fragment : previousText + fragment,
    };
  }

  function parseEntries(page: TimelinePage): Entry[] {
    const entries: Entry[] = [];
    for (const entry of page.entries) {
      const parsed = parseEntry(entry.item, entry.turnId, entry.seqEnd);
      if (parsed) parsed.seqStart = entry.seqStart ?? entry.seqEnd;
      if (parsed) entries.push(parsed);
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
      if (entry.kind === "user") {
        if (anonymousAssistant && anonymousAssistant.seq > anonymousToolSeq) {
          selected.push(anonymousAssistant);
        }
        anonymousAssistant = null;
        anonymousToolSeq = Number.NEGATIVE_INFINITY;
        continue;
      }
      if (entry.turnId) continue;
      if (entry.kind === "assistant") {
        anonymousAssistant = entry;
      } else {
        anonymousToolSeq = Math.max(anonymousToolSeq, entry.seq);
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
    return eventAgentStatus ?? snapshotAgentStatus ?? timelineAgentStatus;
  }

  function isSelectedFinal(request: { id: string | null; text: string | null }): boolean {
    return (
      (request.id !== null && finalIds.has(request.id)) ||
      (request.text !== null && (
        finalTexts.has(request.text) ||
        finalTextByCanonicalText.has(canonicalAssistantText(request.text))
      ))
    );
  }

  function publishFinals(): void {
    const deduped = allEntries();
    const idCounts = new Map<string, number>();
    for (const entry of deduped) {
      if (entry.kind === "assistant" && entry.id && entry.idSafe) {
        idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
      }
    }

    const nextIds = new Set<string>();
    const nextTexts = new Set<string>();
    const nextTextById = new Map<string, string>();
    const nextTextByCanonicalText = new Map<string, string>();
    const selection = selectFinalEntries(deduped, effectiveAgentStatus());
    for (const entry of selection) {
      if (entry.text) {
        nextTexts.add(entry.text);
        const canonical = canonicalAssistantText(entry.text);
        if (canonical.length > 0) {
          nextTextByCanonicalText.set(canonical, stripTrailingHiddenAssistantMetadata(entry.text));
        }
      }
      if (entry.id && entry.idSafe && entry.text && idCounts.get(entry.id) === 1) {
        nextIds.add(entry.id);
        nextTextById.set(entry.id, stripTrailingHiddenAssistantMetadata(entry.text));
      }
    }
    const changed = !(
      sameSet(finalIds, nextIds) &&
      sameSet(finalTexts, nextTexts) &&
      sameMap(finalTextById, nextTextById) &&
      sameMap(finalTextByCanonicalText, nextTextByCanonicalText)
    );
    if (!changed) return;
    finalIds = nextIds;
    finalTexts = nextTexts;
    finalTextById = nextTextById;
    finalTextByCanonicalText = nextTextByCanonicalText;
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
      stopped || olderComplete || backfillInFlight || backfillBlockedByRpc ||
      requestedMessages.size === 0 || !olderCursor
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
          const outcome = await refetchWithTimeout(
            timeline,
            { direction: "before", cursor, limit: HISTORICAL_PAGE_ENTRIES },
            8000,
          );
          if (outcome.kind === "timed-out") {
            let blocker: Promise<void>;
            blocker = outcome.pending.finally(() => {
              if (backfillBlockedByRpc !== blocker) return;
              backfillBlockedByRpc = null;
              if (!stopped) startBackfill();
            });
            backfillBlockedByRpc = blocker;
            return;
          }
          if (outcome.kind === "rejected") throw outcome.error;
          const page = outcome.page;
          if (stopped) return;
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
    if (refreshBlockedByRpc) {
      refreshQueued = true;
      return;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
  }

  async function refreshOnce(): Promise<void> {
    if (stopped || !active || refreshBlockedByRpc) return;
    try {
      let payload: TimelinePage | null = null;
      const attempts = [
        { direction: "tail", limit: INITIAL_TAIL_ENTRIES },
        undefined,
        { limit: INITIAL_TAIL_ENTRIES },
      ] as const;
      for (const attempt of attempts) {
        const outcome = await refetchWithTimeout(timeline, attempt, 4000);
        if (outcome.kind === "timed-out") {
          let blocker: Promise<void>;
          blocker = outcome.pending.finally(() => {
            if (refreshBlockedByRpc !== blocker) return;
            refreshBlockedByRpc = null;
            if (stopped) return;
            if (!active) refreshWhilePaused = true;
            else scheduleRefresh(0);
          });
          refreshBlockedByRpc = blocker;
          return;
        }
        if (outcome.kind === "rejected") continue;
        payload = outcome.page;
        break;
      }
      if (!payload || stopped) return;

      const nextEpoch = payload.startCursor?.epoch ?? null;
      if (timelineEpoch && nextEpoch && nextEpoch !== timelineEpoch) {
        olderEntries.clear();
        liveEntries.clear();
        finalIds = new Set();
        finalTexts = new Set();
        finalTextById = new Map();
        finalTextByCanonicalText = new Map();
      }
      if (nextEpoch) timelineEpoch = nextEpoch;
      timelineAgentStatus = payload.agent?.status;
      olderCursor = payload.startCursor ?? null;
      if (payload.hasOlder === false || olderCursor === null) {
        olderEntries.clear();
        olderComplete = true;
      } else {
        olderComplete = false;
      }
      discardIncrementalPublication();
      tailEntries.clear();
      for (const entry of parseEntries(payload)) tailEntries.set(entry.seq, entry);
      const payloadStatus = payload.agent?.status;
      const payloadClosed = payloadStatus !== undefined &&
        payloadStatus !== "running" && payloadStatus !== "initializing";
      const coveredByPayload = (seq: number): boolean => payload.entries.some(
        (entry) => (entry.seqStart ?? entry.seqEnd) <= seq && seq <= entry.seqEnd,
      );
      const overlay = [...liveEntries].sort(([left], [right]) => left - right);
      for (const [seq, entry] of overlay) {
        // Once Paseo publishes a closed canonical snapshot, its accumulated
        // row supersedes partial live fragments from the same sequence range.
        // Keep later events, and keep live overlays while the turn is running.
        if (payloadClosed && coveredByPayload(seq)) {
          liveEntries.delete(seq);
          continue;
        }
        if (!entry) {
          tailEntries.delete(seq);
          continue;
        }
        const previous = tailEntries.get(entry.seqStart - 1);
        const merged = mergeAssistantEntries(previous, entry);
        if (merged && previous) tailEntries.delete(previous.seq);
        tailEntries.set(seq, merged ?? entry);
      }
      trimIncrementalTail();
      lastObservedSeq = payload.entries.reduce(
        (maximum, entry) => Math.max(maximum, entry.seqEnd),
        Number.NEGATIVE_INFINITY,
      );
      for (const seq of liveEntries.keys()) lastObservedSeq = Math.max(lastObservedSeq, seq);
      if (!Number.isFinite(lastObservedSeq)) lastObservedSeq = null;
      invalidateEntries();
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

  function reconcileUnknownLiveCandidates(): void {
    const status = effectiveAgentStatus();
    if (
      stopped || !active || status === undefined || status === "running" || status === "initializing" ||
      liveReconciliationInFlight || ![...liveCandidates.values()].some((candidate) => !isSelectedFinal(candidate))
    ) return;
    let operation: Promise<void>;
    operation = refresh().finally(() => {
      if (liveReconciliationInFlight === operation) liveReconciliationInFlight = null;
    });
    liveReconciliationInFlight = operation;
  }

  function discardIncrementalPublication(): void {
    if (incrementalTimer) clearTimeout(incrementalTimer);
    incrementalTimer = null;
    incrementalDirty = false;
  }

  function flushIncrementalPublication(): boolean {
    if (incrementalTimer) clearTimeout(incrementalTimer);
    incrementalTimer = null;
    if (!incrementalDirty) return false;
    incrementalDirty = false;
    invalidateEntries();
    removeSatisfiedRequests();
    publishFinals();
    startBackfill();
    return true;
  }

  function scheduleIncrementalPublication(): void {
    incrementalDirty = true;
    if (incrementalTimer || stopped || !active) return;
    incrementalTimer = setTimeout(() => {
      incrementalTimer = null;
      flushIncrementalPublication();
    }, INCREMENTAL_PUBLISH_MS);
  }

  function resetTimeline(epoch: string | null): void {
    discardIncrementalPublication();
    olderEntries.clear();
    tailEntries.clear();
    liveEntries.clear();
    olderCursor = null;
    olderComplete = false;
    timelineEpoch = epoch;
    timelineAgentStatus = undefined;
    eventAgentStatus = undefined;
    lastObservedSeq = null;
    invalidateEntries();
    publishFinals();
  }

  function trimIncrementalTail(): void {
    let tailTrimmed = false;
    let firstRetained: number | undefined;
    while (tailEntries.size > INITIAL_TAIL_ENTRIES) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const seq of tailEntries.keys()) oldest = Math.min(oldest, seq);
      if (!Number.isFinite(oldest)) break;
      tailEntries.delete(oldest);
      tailTrimmed = true;
    }
    if (tailTrimmed) {
      for (const seq of tailEntries.keys()) {
        firstRetained = firstRetained === undefined ? seq : Math.min(firstRetained, seq);
      }
    }
    while (liveEntries.size > INITIAL_TAIL_ENTRIES) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const seq of liveEntries.keys()) oldest = Math.min(oldest, seq);
      if (!Number.isFinite(oldest)) break;
      liveEntries.delete(oldest);
    }
    if (tailTrimmed && timelineEpoch && firstRetained !== undefined) {
      olderCursor = { epoch: timelineEpoch, seq: firstRetained };
      olderComplete = false;
    }
  }

  function handleTimelineEvent(message: TimelineSubscriptionEvent): void {
    const event = message && typeof message === "object" ? message.event : undefined;
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      // Compatibility with older SDKs that only sent an invalidation signal.
      scheduleRefresh();
      return;
    }
    if (event.type === "replacement") {
      const replacementEpoch = typeof event.epoch === "string"
        ? event.epoch
        : typeof message.epoch === "string"
          ? message.epoch
          : null;
      resetTimeline(replacementEpoch);
      scheduleRefresh(0);
      return;
    }
    if (event.type === "timeline") {
      const seq = message.seq;
      const epoch = message.epoch;
      if (typeof seq !== "number" || !Number.isFinite(seq) || !event.item) {
        scheduleRefresh();
        return;
      }
      if (timelineEpoch && epoch && epoch !== timelineEpoch) {
        resetTimeline(epoch);
        scheduleRefresh(0);
        return;
      }
      if (!timelineEpoch && epoch) timelineEpoch = epoch;
      if (lastObservedSeq !== null && seq > lastObservedSeq + 1) {
        discardIncrementalPublication();
        scheduleRefresh(0);
        return;
      }

      const previousSeq = lastObservedSeq;
      const previous = previousSeq === null ? undefined : tailEntries.get(previousSeq);
      const candidate = parseEntry(
        event.item,
        event.turnId,
        seq,
        liveEntries.get(seq) ?? tailEntries.get(seq),
        true,
      );
      const merged = mergeAssistantEntries(previous, candidate);
      const parsed = merged ?? candidate;
      if (merged && previousSeq !== null) {
        tailEntries.delete(previousSeq);
        liveEntries.set(previousSeq, null);
      }
      liveEntries.set(seq, parsed);
      if (parsed) tailEntries.set(seq, parsed);
      else tailEntries.delete(seq);
      lastObservedSeq = Math.max(lastObservedSeq ?? seq, seq);
      trimIncrementalTail();
      scheduleIncrementalPublication();
      return;
    }
    if (event.type === "turn_started") {
      // The stream event can precede the React agent snapshot. Keep the prior
      // turn's final card, but classify subsequent timeline rows as running.
      eventAgentStatus = snapshotAgentStatus === "running" || snapshotAgentStatus === "initializing"
        ? undefined
        : "running";
      return;
    }
    if (event.type === "turn_completed" || event.type === "turn_canceled") {
      eventAgentStatus = snapshotAgentStatus === "idle" ? undefined : "idle";
      if (!flushIncrementalPublication()) publishFinals();
      reconcileUnknownLiveCandidates();
      return;
    }
    if (event.type === "turn_failed") {
      eventAgentStatus = snapshotAgentStatus === "error" ? undefined : "error";
      if (!flushIncrementalPublication()) publishFinals();
      reconcileUnknownLiveCandidates();
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    active = true;
    stopped = false;
    try {
      const cleanup = timeline.subscribe((message) => {
        if (!active) {
          refreshWhilePaused = true;
          return;
        }
        handleTimelineEvent(message as TimelineSubscriptionEvent);
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
    if (incrementalTimer) clearTimeout(incrementalTimer);
    refreshTimer = null;
    incrementalTimer = null;
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
    if (incrementalDirty) scheduleIncrementalPublication();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    active = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (incrementalTimer) clearTimeout(incrementalTimer);
    if (pollTimer) clearInterval(pollTimer);
    refreshTimer = null;
    incrementalTimer = null;
    incrementalDirty = false;
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
      if (eventAgentStatus === status) eventAgentStatus = undefined;
      const flushedIncremental = flushIncrementalPublication();
      // Paseo can publish `running` before the new user row reaches the
      // timeline. Keep the last proven final classification until timeline
      // data shows the new turn (or continued work in the same turn). Closed
      // statuses may still finalize the current tail immediately.
      const effectiveStatus = effectiveAgentStatus();
      if (effectiveStatus === "running" || effectiveStatus === "initializing") return;
      if (!flushedIncremental) publishFinals();
      reconcileUnknownLiveCandidates();
    },
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isFinal(messageId: string | null): boolean {
      return messageId !== null && finalIds.has(messageId);
    },
    isFinalText(text: string | null): boolean {
      return text !== null && (
        finalTexts.has(text) || finalTextByCanonicalText.has(canonicalAssistantText(text))
      );
    },
    finalText(messageId: string | null, text: string | null): string | null {
      if (messageId !== null) {
        const indexedText = finalTextById.get(messageId);
        if (indexedText !== undefined) return indexedText;
      }
      if (text === null) return null;
      if (finalTexts.has(text)) return stripTrailingHiddenAssistantMetadata(text);
      return finalTextByCanonicalText.get(canonicalAssistantText(text)) ?? null;
    },
    trackLiveCandidate(sourceKey: string, messageId: string | null, text: string | null): void {
      if (stopped || (messageId === null && text === null)) return;
      requestedMessages.delete(sourceKey);
      liveCandidates.set(sourceKey, { id: messageId, text });
      reconcileUnknownLiveCandidates();
    },
    ensureKnown(sourceKey: string, messageId: string | null, text: string | null): void {
      if (stopped || (messageId === null && text === null)) return;
      liveCandidates.delete(sourceKey);
      flushIncrementalPublication();
      const request = { id: messageId, text };
      if (isKnown(request)) {
        requestedMessages.delete(sourceKey);
        return;
      }
      // One mounted source owns one lookup. A completed snapshot replaces any
      // earlier candidate instead of retaining every streamed text prefix.
      requestedMessages.set(sourceKey, request);
      startBackfill();
    },
    forgetKnown(sourceKey: string): void {
      liveCandidates.delete(sourceKey);
      requestedMessages.delete(sourceKey);
    },
    diagnostics(): { tailEntries: number; liveEntries: number } {
      return { tailEntries: tailEntries.size, liveEntries: liveEntries.size };
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

/** Distinguishes identical agent IDs exposed by different connected hosts. */
export function turnFinalScopeKey(hostId: string, agentId: string): string {
  return `${hostId.length}:${hostId}${agentId}`;
}

export type TurnFinalCardPosition = "none" | "single" | "start" | "middle" | "end";

type TurnFinalFragment = {
  sourceKey: string;
  messageId: string | null;
  text: string;
  timestamp: number;
  phase: "streaming" | "complete";
  order: number;
  visible: boolean;
  finalTextMatch: boolean;
  token: symbol;
};

const finalFragments = new Map<string, Map<string, TurnFinalFragment>>();
const finalFragmentSourcesByMessage = new Map<string, Map<string, Set<string>>>();
const finalFragmentListeners = new Map<string, Map<string, Set<() => void>>>();
const finalFragmentVersions = new Map<string, Map<string, number>>();
const finalFragmentTopologyVersions = new Map<string, number>();
const finalFragmentPositionCache = new Map<string, {
  fragmentVersion: number;
  indexVersion: number;
  positions: Map<string, TurnFinalCardPosition>;
}>();
const finalFragmentPositionBuilds = new Map<string, number>();
let nextFinalFragmentOrder = 1;

function hasRenderableText(text: string): boolean {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    if (trimmed.length > 0 && !ASSISTANT_EDGE_SEPARATOR.test(trimmed)) return true;
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return false;
}

function affectedFragmentSources(
  agentId: string,
  sourceKey: string,
  ...messageIds: Array<string | null>
): Set<string> {
  const affected = new Set<string>([sourceKey]);
  const sourcesByMessage = finalFragmentSourcesByMessage.get(agentId);
  for (const messageId of messageIds) {
    if (messageId === null) continue;
    for (const siblingSource of sourcesByMessage?.get(messageId) ?? []) {
      affected.add(siblingSource);
    }
  }
  return affected;
}

function updateFragmentMessageIndex(
  agentId: string,
  sourceKey: string,
  previousMessageId: string | null,
  nextMessageId: string | null,
): void {
  if (previousMessageId === nextMessageId) return;
  let sourcesByMessage = finalFragmentSourcesByMessage.get(agentId);
  if (previousMessageId !== null) {
    const previousSources = sourcesByMessage?.get(previousMessageId);
    previousSources?.delete(sourceKey);
    if (previousSources?.size === 0) sourcesByMessage?.delete(previousMessageId);
  }
  if (nextMessageId !== null) {
    sourcesByMessage ??= new Map<string, Set<string>>();
    const nextSources = sourcesByMessage.get(nextMessageId) ?? new Set<string>();
    nextSources.add(sourceKey);
    sourcesByMessage.set(nextMessageId, nextSources);
    finalFragmentSourcesByMessage.set(agentId, sourcesByMessage);
  }
  if (sourcesByMessage?.size === 0) finalFragmentSourcesByMessage.delete(agentId);
}

function notifyFinalFragments(agentId: string, sourceKeys: Iterable<string>): void {
  finalFragmentPositionCache.delete(agentId);
  finalFragmentTopologyVersions.set(
    agentId,
    (finalFragmentTopologyVersions.get(agentId) ?? 0) + 1,
  );
  const versions = finalFragmentVersions.get(agentId) ?? new Map<string, number>();
  finalFragmentVersions.set(agentId, versions);
  const listeners = finalFragmentListeners.get(agentId);
  for (const sourceKey of sourceKeys) {
    versions.set(sourceKey, (versions.get(sourceKey) ?? 0) + 1);
    for (const listener of listeners?.get(sourceKey) ?? []) listener();
  }
}

function pruneFinalFragmentSource(agentId: string, sourceKey: string): void {
  if (finalFragments.get(agentId)?.has(sourceKey)) return;
  if ((finalFragmentListeners.get(agentId)?.get(sourceKey)?.size ?? 0) > 0) return;
  const versions = finalFragmentVersions.get(agentId);
  versions?.delete(sourceKey);
  if (versions?.size === 0) finalFragmentVersions.delete(agentId);
}

export type TurnFinalFragmentInput = {
  agentId: string;
  sourceKey: string;
  messageId: string | null;
  text: string;
  timestamp: number;
  phase: "streaming" | "complete";
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
    const appendOnly = existing !== undefined && next.text.startsWith(existing.text);
    const visible = existing?.visible && appendOnly
      ? true
      : appendOnly
        ? hasRenderableText(next.text.slice(existing.text.length))
        : hasRenderableText(next.text);
    const oldFinalText = existing?.finalTextMatch ?? false;
    // A running fragment cannot own a completed-turn card. Avoid normalizing
    // the growing message on every streamed chunk; completion and index
    // invalidations still rebuild the exact final-card position.
    const nextFinalText = next.phase === "complete"
      ? (index?.isFinalText(next.text) ?? false)
      : false;
    const previousMessageId = existing?.messageId ?? null;
    const topologyChanged = !existing ||
      existing.messageId !== next.messageId ||
      existing.timestamp !== next.timestamp ||
      existing.visible !== visible ||
      oldFinalText !== nextFinalText;
    const affected = topologyChanged
      ? affectedFragmentSources(input.agentId, input.sourceKey, previousMessageId, next.messageId)
      : null;
    fragments.set(input.sourceKey, {
      sourceKey: input.sourceKey,
      messageId: next.messageId,
      text: next.text,
      timestamp: next.timestamp,
      phase: next.phase,
      order: existing?.order ?? nextFinalFragmentOrder++,
      visible,
      finalTextMatch: nextFinalText,
      token,
    });
    updateFragmentMessageIndex(input.agentId, input.sourceKey, previousMessageId, next.messageId);
    if (next.phase === "streaming") index?.trackLiveCandidate(input.sourceKey, next.messageId, next.text);
    else index?.ensureKnown(input.sourceKey, next.messageId, next.text);
    if (topologyChanged) {
      notifyFinalFragments(input.agentId, affected!);
    }
  }

  update(input);
  return {
    update,
    release(): void {
      const current = finalFragments.get(input.agentId)?.get(input.sourceKey);
      if (!current || current.token !== token) return;
      const affected = affectedFragmentSources(input.agentId, input.sourceKey, current.messageId);
      updateFragmentMessageIndex(input.agentId, input.sourceKey, current.messageId, null);
      fragments.delete(input.sourceKey);
      stores.get(input.agentId)?.index.forgetKnown(input.sourceKey);
      if (fragments.size === 0) finalFragments.delete(input.agentId);
      notifyFinalFragments(input.agentId, affected);
      pruneFinalFragmentSource(input.agentId, input.sourceKey);
    },
  };
}

/** Compatibility helper for tests and one-shot consumers. */
export function retainTurnFinalFragment(input: TurnFinalFragmentInput): () => void {
  const mounted = mountTurnFinalFragment(input);
  return () => mounted.release();
}

export function subscribeTurnFinalFragments(
  agentId: string,
  sourceKey: string,
  listener: () => void,
): () => void {
  const agentListeners = finalFragmentListeners.get(agentId) ?? new Map<string, Set<() => void>>();
  const sourceListeners = agentListeners.get(sourceKey) ?? new Set<() => void>();
  sourceListeners.add(listener);
  agentListeners.set(sourceKey, sourceListeners);
  finalFragmentListeners.set(agentId, agentListeners);
  return () => {
    sourceListeners.delete(listener);
    if (sourceListeners.size === 0) agentListeners.delete(sourceKey);
    if (agentListeners.size === 0) finalFragmentListeners.delete(agentId);
    pruneFinalFragmentSource(agentId, sourceKey);
  };
}

export function turnFinalFragmentVersion(agentId: string, sourceKey: string): number {
  return finalFragmentVersions.get(agentId)?.get(sourceKey) ?? 0;
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
  const fragmentVersion = finalFragmentTopologyVersions.get(agentId) ?? 0;
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

/** Exact completed response owned by the visible end of one final card. */
export function getTurnFinalCardText(agentId: string, sourceKey: string): string | null {
  const position = getTurnFinalCardPosition(agentId, sourceKey);
  if (position !== "single" && position !== "end") return null;
  const fragment = finalFragments.get(agentId)?.get(sourceKey);
  const index = stores.get(agentId)?.index;
  if (!fragment || !index) return null;
  return index.finalText(fragment.messageId, fragment.text);
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
        if (fragment.phase === "complete") {
          index.ensureKnown(fragment.sourceKey, fragment.messageId, fragment.text);
        } else {
          index.trackLiveCandidate(fragment.sourceKey, fragment.messageId, fragment.text);
        }
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
  finalFragmentSourcesByMessage.clear();
  finalFragmentListeners.clear();
  finalFragmentVersions.clear();
  finalFragmentTopologyVersions.clear();
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

export function turnIndexDiagnostics(agentId: string): { tailEntries: number; liveEntries: number } {
  return stores.get(agentId)?.index.diagnostics() ?? { tailEntries: 0, liveEntries: 0 };
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
