export type CommentSyncInput = {
  epoch?: string;
  agents: Array<{ agentId: string; revision?: number }>;
};

export type CommentSyncBucket<Comment> = {
  agentId: string;
  revision: number;
  comments: Comment[];
  deleted: string[];
};

export type CommentSyncResult<Comment> = {
  epoch: string;
  buckets: Array<CommentSyncBucket<Comment>>;
};

type Timer = ReturnType<typeof setTimeout>;

/**
 * Owns one batched, single-flight synchronization loop for every agent pill.
 * The controller is React-free so lifecycle, retries, and cleanup are covered
 * by deterministic tests rather than UI timing.
 */
export function createCommentSyncController<Comment>({
  sync,
  hydrate,
  hasPendingSaves,
  intervalMs = 15_000,
  random = Math.random,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
}: {
  sync(input: CommentSyncInput): Promise<CommentSyncResult<Comment>>;
  hydrate(agentId: string, comments: Comment[], deleted: string[]): void;
  hasPendingSaves(agentId: string): boolean;
  intervalMs?: number;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  const agents = new Set<string>();
  const revisions = new Map<string, number>();
  let epoch: string | undefined;
  let timer: Timer | null = null;
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let started = false;
  let active = true;
  let stopped = false;
  let failures = 0;
  let unchangedStreak = 0;

  function clearTimer(): void {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function nextDelay(): number {
    const retryMultiplier = failures > 0
      ? 2 ** Math.min(failures, 2)
      : 2 ** Math.min(unchangedStreak, 2);
    // Positive-only jitter keeps the documented four-polls/minute ceiling.
    return Math.round(intervalMs * retryMultiplier * (1 + random() * 0.1));
  }

  function scheduleNext(): void {
    clearTimer();
    if (!started || stopped || !active || agents.size === 0) return;
    timer = schedule(() => {
      timer = null;
      void refresh();
    }, nextDelay());
  }

  async function syncOnce(): Promise<boolean> {
    const requested = [...agents].sort().map((agentId) => ({
      agentId,
      revision: revisions.get(agentId),
    }));
    if (requested.length === 0) return false;
    const result = await sync({ epoch, agents: requested });
    if (result.epoch !== epoch) {
      epoch = result.epoch;
      revisions.clear();
    }
    for (const bucket of result.buckets) {
      if (!agents.has(bucket.agentId) || hasPendingSaves(bucket.agentId)) continue;
      hydrate(bucket.agentId, bucket.comments, bucket.deleted);
      revisions.set(bucket.agentId, bucket.revision);
    }
    return result.buckets.length > 0;
  }

  function refresh(): Promise<void> {
    if (stopped || !active || agents.size === 0) return Promise.resolve();
    clearTimer();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const run = async (): Promise<void> => {
      do {
        queued = false;
        try {
          const changed = await syncOnce();
          failures = 0;
          unchangedStreak = changed ? 0 : Math.min(unchangedStreak + 1, 2);
        } catch {
          failures += 1;
          unchangedStreak = 0;
        }
      } while (queued && !stopped && active);
    };
    let operation: Promise<void>;
    operation = run().finally(() => {
      if (inFlight === operation) inFlight = null;
      scheduleNext();
    });
    inFlight = operation;
    return operation;
  }

  return {
    addAgent(agentId: string): void {
      if (!stopped) agents.add(agentId);
    },
    removeAgent(agentId: string): void {
      agents.delete(agentId);
      revisions.delete(agentId);
      if (agents.size === 0) clearTimer();
    },
    start(): void {
      if (started || stopped) return;
      started = true;
      scheduleNext();
    },
    refresh,
    setActive(next: boolean): void {
      if (active === next || stopped) return;
      active = next;
      if (!active) {
        clearTimer();
        return;
      }
      void refresh();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      queued = false;
      clearTimer();
      agents.clear();
      revisions.clear();
    },
    /** Refreshes a bucket immediately after a dirty local save becomes clean. */
    notifySaveSettled(agentId: string): void {
      if (!agents.has(agentId) || hasPendingSaves(agentId)) return;
      void refresh();
    },
    diagnostics(): { agents: number; inFlight: boolean; scheduled: boolean; failures: number; unchangedStreak: number } {
      return { agents: agents.size, inFlight: inFlight !== null, scheduled: timer !== null, failures, unchangedStreak };
    },
  };
}
