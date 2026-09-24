export const WIDE_FRAME_CLEANUP_GRACE_MS = 5_000;

export type WideFrameLease = symbol;

type TimerHandle = ReturnType<typeof setTimeout>;
type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};
type PendingCleanup = {
  cancel(): void;
  defer(): void;
};
type LeaseOwner = {
  hostId: string | null;
};
type LeaseState = {
  owners: Map<WideFrameLease, LeaseOwner>;
  pending: PendingCleanup | null;
  deferredCleanup: (() => void) | null;
};
type LeaseHost = typeof globalThis & {
  [key: symbol]: unknown;
};

const LEASE_STATE = Symbol.for("paseo.inline-review.wide-frame-lease.v1");
const defaultScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

function leaseState(host: LeaseHost): LeaseState {
  const existing = host[LEASE_STATE] as LeaseState | undefined;
  if (existing?.owners instanceof Map) {
    existing.deferredCleanup ??= null;
    return existing;
  }
  // The first reload from the former single-owner implementation sees its
  // state under this same Symbol.for key. Cancel its pending rollback, then
  // replace the incompatible shape; its stale cleanup will no longer match.
  (existing as unknown as { pending?: PendingCleanup } | undefined)?.pending?.cancel();
  const created: LeaseState = {
    owners: new Map(),
    pending: null,
    deferredCleanup: null,
  };
  host[LEASE_STATE] = created;
  return created;
}

export function cancelPendingWideFrameCleanup(
  host = globalThis as LeaseHost,
): void {
  const state = leaseState(host);
  state.pending?.cancel();
  state.pending = null;
  state.deferredCleanup = null;
}

/** Claims a provisional share while a bundle waits to become authoritative. */
export function acquireWideFrameLease(
  host = globalThis as LeaseHost,
): WideFrameLease {
  const state = leaseState(host);
  // Acquisition alone does not identify Paseo's selected host. Give a real
  // replacement a fresh grace period without letting an idle peer suppress
  // visual cleanup forever.
  state.pending?.defer();
  const lease = Symbol("inline-review-wide-frame-owner");
  state.owners.set(lease, {
    hostId: null,
  });
  return lease;
}

/**
 * Makes the latest configured bundle authoritative. Paseo renders one
 * selected host's contribution, so an older host or bundle must not keep a
 * document-wide policy alive after selection changes.
 */
export function updateWideFrameLease(
  lease: WideFrameLease,
  {
    hostId,
    enabled,
    activate,
    deactivate,
    host = globalThis as LeaseHost,
  }: {
    hostId: string;
    enabled: boolean;
    activate(): boolean;
    deactivate(): void;
    host?: LeaseHost;
  },
): boolean {
  const state = leaseState(host);
  const owner = state.owners.get(lease);
  if (!owner) return false;

  const applied = enabled ? activate() : (deactivate(), true);
  if (!applied) return false;
  cancelPendingWideFrameCleanup(host);

  // Preserve only unconfigured leases: they may be a replacement that has
  // acquired ownership but has not loaded settings yet. Every configured
  // predecessor is stale once the selected host publishes its policy. Commit
  // the authority transfer only after the new policy applied successfully.
  for (const [candidateLease, candidate] of state.owners) {
    if (candidateLease !== lease && candidate.hostId !== null) {
      state.owners.delete(candidateLease);
    }
  }
  owner.hostId = hostId;
  return true;
}

function hasConfiguredOwner(state: LeaseState): boolean {
  for (const owner of state.owners.values()) {
    if (owner.hostId !== null) return true;
  }
  return false;
}

function scheduleWideFrameCleanup(
  state: LeaseState,
  cleanup: () => void,
  delayMs: number,
  scheduler: Scheduler,
): void {
  state.pending?.cancel();
  state.deferredCleanup = cleanup;
  let active = true;
  let timer: TimerHandle | null = null;
  const run = (): void => {
    if (!active) return;
    timer = scheduler.setTimeout(() => {
      if (!active || state.pending !== pending) return;
      active = false;
      state.pending = null;
      const finalCleanup = state.deferredCleanup;
      state.deferredCleanup = null;
      if (!hasConfiguredOwner(state)) finalCleanup?.();
    }, delayMs);
  };
  const pending: PendingCleanup = {
    cancel(): void {
      if (!active) return;
      active = false;
      if (timer !== null) scheduler.clearTimeout(timer);
    },
    defer(): void {
      if (!active) return;
      if (timer !== null) scheduler.clearTimeout(timer);
      run();
    },
  };
  state.pending = pending;
  run();
}

/**
 * Releases only a live plugin instance. Its runtime work stops immediately;
 * visual restoration may transfer to a replacement that is still loading.
 */
export function releaseWideFrameCleanupLease(
  lease: WideFrameLease,
  cleanup: () => void,
  {
    prepareCleanup,
    delayMs = WIDE_FRAME_CLEANUP_GRACE_MS,
    host = globalThis as LeaseHost,
    scheduler = defaultScheduler,
  }: {
    prepareCleanup?: () => boolean;
    delayMs?: number;
    host?: LeaseHost;
    scheduler?: Scheduler;
  } = {},
): boolean {
  const state = leaseState(host);
  if (!state.owners.delete(lease)) return false;

  // Runtime work belongs to the released lease and must stop immediately.
  // Visual restoration stays bounded even when another daemon's bundle was
  // acquired but never selected and therefore never configures its lease.
  const prepared = prepareCleanup?.() === true;
  if (prepared) {
    scheduleWideFrameCleanup(state, cleanup, delayMs, scheduler);
  } else if (!state.pending && state.deferredCleanup) {
    scheduleWideFrameCleanup(state, state.deferredCleanup, delayMs, scheduler);
  } else if (!state.pending && state.owners.size === 0) {
    scheduleWideFrameCleanup(state, cleanup, delayMs, scheduler);
  }
  return true;
}
