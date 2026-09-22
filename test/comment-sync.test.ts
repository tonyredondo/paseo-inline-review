import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommentSyncController } from "../client/comment-sync.ts";

test("one synchronization tick batches every registered agent", async () => {
  const calls: unknown[] = [];
  const hydrated: string[] = [];
  const controller = createCommentSyncController({
    sync: async (input) => {
      calls.push(input);
      return {
        epoch: "epoch-1",
        buckets: input.agents.map(({ agentId }) => ({
          agentId,
          revision: 0,
          comments: [],
          deleted: [],
        })),
      };
    },
    hydrate(agentId) {
      hydrated.push(agentId);
    },
    hasPendingSaves: () => false,
    schedule: () => ({}) as ReturnType<typeof setTimeout>,
    cancel: () => {},
  });

  for (let index = 0; index < 9; index += 1) controller.addAgent(`agent-${index}`);
  await controller.refresh();

  assert.equal(calls.length, 1);
  assert.deepEqual(hydrated.sort(), Array.from({ length: 9 }, (_, index) => `agent-${index}`));
  controller.stop();
});

test("overlapping synchronization requests share one flight and keep one trailing refresh", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const controller = createCommentSyncController({
    sync: async () => {
      calls += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return { epoch: "epoch-1", buckets: [] };
    },
    hydrate: () => {},
    hasPendingSaves: () => false,
    schedule: () => ({}) as ReturnType<typeof setTimeout>,
    cancel: () => {},
  });
  controller.addAgent("agent");

  const first = controller.refresh();
  const second = controller.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()?.();
  await Promise.all([first, second]);
  controller.stop();
});

test("background state stops scheduled synchronization and resume refreshes once", async () => {
  const scheduled: Array<() => void> = [];
  let cancelled = 0;
  let calls = 0;
  const controller = createCommentSyncController({
    sync: async () => {
      calls += 1;
      return { epoch: "epoch-1", buckets: [] };
    },
    hydrate: () => {},
    hasPendingSaves: () => false,
    schedule(callback) {
      scheduled.push(callback);
      return callback as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {
      cancelled += 1;
    },
  });
  controller.addAgent("agent");
  controller.start();
  assert.equal(scheduled.length, 1);
  controller.setActive(false);
  assert.equal(cancelled, 1);
  controller.setActive(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  controller.stop();
});

test("one request covers one, nine, and one hundred agents", async () => {
  for (const count of [1, 9, 100]) {
    let calls = 0;
    const controller = createCommentSyncController({
      async sync(input) {
        calls += 1;
        assert.equal(input.agents.length, count);
        return { epoch: "e", buckets: [] };
      },
      hydrate() {},
      hasPendingSaves: () => false,
    });
    for (let index = 0; index < count; index += 1) controller.addAgent(`a${index}`);
    await controller.refresh();
    assert.equal(calls, 1);
    controller.stop();
  }
});

test("only changed buckets hydrate and an epoch replacement refreshes every bucket", async () => {
  const hydrated: string[] = [];
  let call = 0;
  const controller = createCommentSyncController({
    async sync(input) {
      call += 1;
      if (call === 1) {
        return {
          epoch: "first",
          buckets: input.agents.map(({ agentId }) => ({ agentId, revision: 1, comments: [], deleted: [] })),
        };
      }
      if (call === 2) {
        assert.deepEqual(input.agents.map((agent) => agent.revision), [1, 1]);
        return { epoch: "first", buckets: [{ agentId: "b", revision: 2, comments: [], deleted: [] }] };
      }
      return {
        epoch: "replacement",
        buckets: input.agents.map(({ agentId }) => ({ agentId, revision: 1, comments: [], deleted: [] })),
      };
    },
    hydrate(agentId) { hydrated.push(agentId); },
    hasPendingSaves: () => false,
  });
  controller.addAgent("a");
  controller.addAgent("b");
  await controller.refresh();
  await controller.refresh();
  await controller.refresh();
  assert.deepEqual(hydrated, ["a", "b", "b", "a", "b"]);
  controller.stop();
});

test("dirty buckets are not hydrated and refresh as soon as their save settles", async () => {
  let dirty = true;
  let calls = 0;
  const hydrated: string[] = [];
  const controller = createCommentSyncController({
    async sync() {
      calls += 1;
      return { epoch: "e", buckets: [{ agentId: "a", revision: 1, comments: [], deleted: [] }] };
    },
    hydrate(agentId) { hydrated.push(agentId); },
    hasPendingSaves: () => dirty,
  });
  controller.addAgent("a");
  await controller.refresh();
  assert.deepEqual(hydrated, []);
  dirty = false;
  controller.notifySaveSettled("a");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(hydrated, ["a"]);
  controller.stop();
});

test("errors back off, success resets the delay, and cleanup suppresses work", async () => {
  const delays: number[] = [];
  const callbacks: Array<() => void> = [];
  let calls = 0;
  const controller = createCommentSyncController({
    async sync() {
      calls += 1;
      if (calls < 3) throw new Error("offline");
      return calls === 3
        ? { epoch: "e", buckets: [{ agentId: "a", revision: 1, comments: [], deleted: [] }] }
        : { epoch: "e", buckets: [] };
    },
    hydrate() {},
    hasPendingSaves: () => false,
    intervalMs: 100,
    random: () => 0,
    schedule(callback, delay) {
      callbacks.push(callback);
      delays.push(delay);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {},
  });
  controller.addAgent("a");
  controller.start();
  await controller.refresh();
  await controller.refresh();
  await controller.refresh();
  assert.deepEqual(delays.slice(-3), [200, 400, 100]);
  controller.stop();
  callbacks.at(-1)?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
});

test("unchanged foreground ticks back off and a changed bucket resets the interval", async () => {
  const delays: number[] = [];
  let calls = 0;
  const controller = createCommentSyncController({
    async sync() {
      calls += 1;
      return calls === 3
        ? { epoch: "e", buckets: [{ agentId: "a", revision: 1, comments: [], deleted: [] }] }
        : { epoch: "e", buckets: [] };
    },
    hydrate() {},
    hasPendingSaves: () => false,
    intervalMs: 100,
    random: () => 0,
    schedule(_callback, delay) {
      delays.push(delay);
      return delays.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {},
  });
  controller.addAgent("a");
  controller.start();
  await controller.refresh();
  await controller.refresh();
  await controller.refresh();
  assert.deepEqual(delays.slice(-3), [200, 400, 100]);
  assert.equal(controller.diagnostics().unchangedStreak, 0);
  controller.stop();
});
