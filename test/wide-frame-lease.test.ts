import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acquireWideFrameLease,
  releaseWideFrameCleanupLease,
  WIDE_FRAME_CLEANUP_GRACE_MS,
} from "../client/wide-frame-lease.ts";

type TimerHandle = ReturnType<typeof setTimeout>;
type LeaseHost = typeof globalThis & { [key: symbol]: unknown };

class FakeScheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delayMs: number): TimerHandle => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id as unknown as TimerHandle;
  };

  clearTimeout = (handle: TimerHandle): void => {
    this.tasks.delete(handle as unknown as number);
  };

  advance(delayMs: number): void {
    this.now += delayMs;
    const ready = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.now)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, task] of ready) {
      this.tasks.delete(id);
      task.callback();
    }
  }
}

function host(): LeaseHost {
  return {} as LeaseHost;
}

test("wide-frame cleanup waits for the full five-second grace period", () => {
  assert.equal(WIDE_FRAME_CLEANUP_GRACE_MS, 5_000);
  const scheduler = new FakeScheduler();
  const leaseHost = host();
  const lease = acquireWideFrameLease(leaseHost);
  let cleanups = 0;
  assert.equal(releaseWideFrameCleanupLease(lease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
  }), true);
  scheduler.advance(4_999);
  assert.equal(cleanups, 0);
  scheduler.advance(1);
  assert.equal(cleanups, 1);
});

test("a replacement bundle cancels cleanup regardless of reload ordering", () => {
  const scheduler = new FakeScheduler();
  const leaseHost = host();
  let cleanups = 0;

  const oldLease = acquireWideFrameLease(leaseHost);
  releaseWideFrameCleanupLease(oldLease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
  });
  const replacementLease = acquireWideFrameLease(leaseHost);
  scheduler.advance(5_000);
  assert.equal(cleanups, 0, "replacement acquisition cancels an earlier scheduled rollback");

  const newerLease = acquireWideFrameLease(leaseHost);
  assert.equal(releaseWideFrameCleanupLease(replacementLease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
  }), false, "stale cleanup cannot displace an owner acquired first");
  scheduler.advance(5_000);
  assert.equal(cleanups, 0);

  assert.equal(releaseWideFrameCleanupLease(newerLease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
  }), true);
  scheduler.advance(5_000);
  assert.equal(cleanups, 1);
});
