import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acquireWideFrameLease,
  releaseWideFrameCleanupLease,
  updateWideFrameLease,
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
  let preparations = 0;
  assert.equal(releaseWideFrameCleanupLease(lease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
    prepareCleanup: () => {
      preparations += 1;
      return true;
    },
  }), true);
  assert.equal(preparations, 1, "the observer stops immediately");
  scheduler.advance(4_999);
  assert.equal(cleanups, 0);
  scheduler.advance(1);
  assert.equal(cleanups, 1);
});

test("the first reload cancels cleanup from the legacy single-owner state", () => {
  const leaseHost = host();
  let cancellations = 0;
  leaseHost[Symbol.for("paseo.inline-review.wide-frame-lease.v1")] = {
    owner: Symbol("legacy-owner"),
    pending: { cancel: () => { cancellations += 1; } },
  };

  const replacement = acquireWideFrameLease(leaseHost);
  assert.equal(cancellations, 1);
  assert.equal(updateWideFrameLease(replacement, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  }), true);
});

test("a configured replacement cancels cleanup regardless of reload ordering", () => {
  const scheduler = new FakeScheduler();
  const leaseHost = host();
  let cleanups = 0;

  const oldLease = acquireWideFrameLease(leaseHost);
  releaseWideFrameCleanupLease(oldLease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
  });
  scheduler.advance(4_000);
  const replacementLease = acquireWideFrameLease(leaseHost);
  scheduler.advance(4_999);
  assert.equal(cleanups, 0, "acquisition gives a replacement a fresh grace period");
  assert.equal(updateWideFrameLease(replacementLease, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  }), true);
  scheduler.advance(5_000);
  assert.equal(cleanups, 0, "configuration cancels the deferred rollback");

  const activeLease = acquireWideFrameLease(leaseHost);
  assert.equal(updateWideFrameLease(activeLease, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  }), true);
  const newerLease = acquireWideFrameLease(leaseHost);
  assert.equal(releaseWideFrameCleanupLease(activeLease, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
    prepareCleanup: () => true,
  }), true);
  scheduler.advance(4_999);
  assert.equal(updateWideFrameLease(newerLease, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  }), true);
  scheduler.advance(5_000);
  assert.equal(cleanups, 0, "acquire-before-release ordering transfers cleanup too");
});

test("the selected host replaces the previous host policy", () => {
  const leaseHost = host();
  const m5 = acquireWideFrameLease(leaseHost);
  const m4 = acquireWideFrameLease(leaseHost);
  const events: string[] = [];
  const configure = (lease: symbol, hostId: string, enabled: boolean) =>
    updateWideFrameLease(lease, {
      host: leaseHost,
      hostId,
      enabled,
      activate: () => { events.push(`${hostId}:on`); return true; },
      deactivate: () => { events.push(`${hostId}:off`); },
    });

  assert.equal(configure(m5, "M5", true), true);
  assert.equal(configure(m4, "M4", false), true);
  assert.deepEqual(events, ["M5:on", "M4:off"]);
  assert.equal(configure(m5, "M5", true), false, "the prior host cannot reclaim the client");
  assert.equal(releaseWideFrameCleanupLease(m5, () => {}, { host: leaseHost }), false);
});

test("a replacement for the same host supersedes stale callbacks", () => {
  const leaseHost = host();
  const oldLease = acquireWideFrameLease(leaseHost);
  const replacementLease = acquireWideFrameLease(leaseHost);
  let deactivations = 0;
  const configure = (lease: symbol, enabled: boolean) => updateWideFrameLease(lease, {
    host: leaseHost,
    hostId: "M5",
    enabled,
    activate: () => true,
    deactivate: () => { deactivations += 1; },
  });

  assert.equal(configure(oldLease, true), true);
  assert.equal(configure(replacementLease, true), true);
  assert.equal(configure(oldLease, false), false);
  assert.equal(releaseWideFrameCleanupLease(oldLease, () => {}, { host: leaseHost }), false);
  assert.equal(deactivations, 0);
});

test("an unselected provisional bundle cannot suppress cleanup beyond the grace period", () => {
  const scheduler = new FakeScheduler();
  const leaseHost = host();
  const active = acquireWideFrameLease(leaseHost);
  updateWideFrameLease(active, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  });
  const loading = acquireWideFrameLease(leaseHost);
  let preparations = 0;
  let cleanups = 0;

  assert.equal(releaseWideFrameCleanupLease(active, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
    prepareCleanup: () => {
      preparations += 1;
      return true;
    },
  }), true);
  assert.equal(preparations, 1, "the released runtime stops immediately");
  scheduler.advance(4_999);
  assert.equal(cleanups, 0);
  scheduler.advance(1);
  assert.equal(cleanups, 1, "an idle peer cannot retain another host's DOM indefinitely");
  assert.equal(releaseWideFrameCleanupLease(loading, () => {}, {
    host: leaseHost,
    scheduler,
  }), true);
});

test("a policy without a mounted timeline cannot claim authority", () => {
  const scheduler = new FakeScheduler();
  const leaseHost = host();
  const active = acquireWideFrameLease(leaseHost);
  const replacement = acquireWideFrameLease(leaseHost);
  let cleanups = 0;
  assert.equal(updateWideFrameLease(active, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  }), true);
  releaseWideFrameCleanupLease(active, () => { cleanups += 1; }, {
    host: leaseHost,
    scheduler,
    prepareCleanup: () => true,
  });

  assert.equal(updateWideFrameLease(replacement, {
    host: leaseHost,
    hostId: "M4",
    enabled: true,
    activate: () => false,
    deactivate: () => {},
  }), false);
  scheduler.advance(5_000);
  assert.equal(cleanups, 1, "an anchorless peer cannot cancel the pending restoration");
});

test("a configured replacement discards the deferred visual cleanup", () => {
  const scheduler = new FakeScheduler();
  const leaseHost = host();
  const active = acquireWideFrameLease(leaseHost);
  const replacement = acquireWideFrameLease(leaseHost);
  const cleanups: string[] = [];
  updateWideFrameLease(active, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  });

  releaseWideFrameCleanupLease(active, () => { cleanups.push("old"); }, {
    host: leaseHost,
    scheduler,
    prepareCleanup: () => true,
  });
  updateWideFrameLease(replacement, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  });
  releaseWideFrameCleanupLease(replacement, () => { cleanups.push("replacement"); }, {
    host: leaseHost,
    scheduler,
    prepareCleanup: () => true,
  });
  scheduler.advance(5_000);

  assert.deepEqual(cleanups, ["replacement"]);
});

test("stale cleanup cannot stop the selected runtime", () => {
  const leaseHost = host();
  const oldLease = acquireWideFrameLease(leaseHost);
  const currentLease = acquireWideFrameLease(leaseHost);
  updateWideFrameLease(oldLease, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  });
  updateWideFrameLease(currentLease, {
    host: leaseHost,
    hostId: "M5",
    enabled: true,
    activate: () => true,
    deactivate: () => {},
  });
  let preparations = 0;
  assert.equal(releaseWideFrameCleanupLease(oldLease, () => {}, {
    host: leaseHost,
    prepareCleanup: () => {
      preparations += 1;
      return true;
    },
  }), false);
  assert.equal(preparations, 0);
});
