export const WIDE_FRAME_CLEANUP_GRACE_MS = 5_000;

export type WideFrameLease = symbol;

type TimerHandle = ReturnType<typeof setTimeout>;
type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};
type PendingCleanup = { cancel(): void };
type LeaseState = {
  owner: WideFrameLease | null;
  pending: PendingCleanup | null;
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
  if (existing) return existing;
  const created: LeaseState = { owner: null, pending: null };
  host[LEASE_STATE] = created;
  return created;
}

export function cancelPendingWideFrameCleanup(
  host = globalThis as LeaseHost,
): void {
  const state = leaseState(host);
  state.pending?.cancel();
  state.pending = null;
}

/**
 * Claims the host-wide DOM styling for one plugin instance. The state lives
 * on globalThis so a newly evaluated client bundle can cancel the previous
 * bundle's delayed cleanup before the browser paints the default timeline.
 */
export function acquireWideFrameLease(
  host = globalThis as LeaseHost,
): WideFrameLease {
  const state = leaseState(host);
  cancelPendingWideFrameCleanup(host);
  const lease = Symbol("inline-review-wide-frame-owner");
  state.owner = lease;
  return lease;
}

/**
 * Releases only the matching plugin instance. This also covers the inverse
 * reload ordering: cleanup from an old bundle cannot schedule a rollback
 * after the replacement bundle has already acquired ownership.
 */
export function releaseWideFrameCleanupLease(
  lease: WideFrameLease,
  cleanup: () => void,
  {
    delayMs = WIDE_FRAME_CLEANUP_GRACE_MS,
    host = globalThis as LeaseHost,
    scheduler = defaultScheduler,
  }: {
    delayMs?: number;
    host?: LeaseHost;
    scheduler?: Scheduler;
  } = {},
): boolean {
  const state = leaseState(host);
  if (state.owner !== lease) return false;
  state.owner = null;
  cancelPendingWideFrameCleanup(host);

  let active = true;
  let timer: TimerHandle | null = null;
  const pending: PendingCleanup = {
    cancel() {
      if (!active) return;
      active = false;
      if (timer !== null) scheduler.clearTimeout(timer);
    },
  };
  timer = scheduler.setTimeout(() => {
    if (!active) return;
    active = false;
    if (state.pending === pending) state.pending = null;
    cleanup();
  }, delayMs);
  state.pending = pending;
  return true;
}
