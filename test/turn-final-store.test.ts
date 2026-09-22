import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getTurnFinalCardPosition,
  isTurnFinalMessage,
  isTurnFinalText,
  retainTurnFinalFragment,
  retainTurnIndex,
} from "../client/turn-final-store.ts";

test("turn indexes are shared and release their timeline subscription", async () => {
  const agentId = `turn-index-${Date.now()}`;
  let subscriptions = 0;
  let cleanups = 0;
  const timeline = {
    subscribe(): () => void {
      subscriptions += 1;
      return () => {
        cleanups += 1;
      };
    },
    async refetch() {
      return {
        entries: [
          { item: { type: "assistant_message", messageId: "m1", text: "first" }, seqEnd: 1 },
          { item: { type: "user_message", messageId: "u1", text: "next" }, seqEnd: 2 },
          { item: { type: "assistant_message", messageId: "m2", text: "second" }, seqEnd: 3 },
        ],
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  };
  const releaseFirst = retainTurnIndex(agentId, timeline);
  const releaseSecond = retainTurnIndex(agentId, timeline);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(subscriptions, 1);
  assert.equal(isTurnFinalMessage(agentId, "m1"), true);
  assert.equal(isTurnFinalMessage(agentId, "m2"), true);
  releaseFirst();
  assert.equal(cleanups, 0);
  releaseSecond();
  assert.equal(cleanups, 1);
});

test("reused message ids do not mark every streamed segment final", async () => {
  const agentId = `reused-id-${Date.now()}`;
  const timeline = {
    subscribe(): () => void {
      return () => {};
    },
    async refetch() {
      return {
        entries: [
          { item: { type: "assistant_message", messageId: "same", text: "partial" }, seqEnd: 1 },
          { item: { type: "assistant_message", messageId: "same", text: "complete" }, seqEnd: 2 },
          { item: { type: "user_message", messageId: "u1", text: "next" }, seqEnd: 3 },
        ],
        hasOlder: false,
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "same"), false);
  assert.equal(isTurnFinalText(agentId, "complete"), true);
  release();
});

test("a merged history row with a unique id remains a safe final selector", async () => {
  const agentId = `merged-stream-${Date.now()}`;
  const timeline = {
    subscribe(): () => void {
      return () => {};
    },
    async refetch() {
      return {
        entries: [
          {
            item: {
              type: "assistant_message",
              messageId: "shared",
              text: "first paragraph\n\nsecond paragraph",
            },
            seqEnd: 2,
            collapsed: ["assistant_merge"],
          },
          { item: { type: "user_message", messageId: "u1", text: "next" }, seqEnd: 3 },
        ],
        hasOlder: false,
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline);
  await new Promise<void>((resolve) => setImmediate(resolve));

  // assistant_merge describes replacements inside this one source row. Its id
  // is safe when it appears only once in the fetched timeline.
  assert.equal(isTurnFinalMessage(agentId, "shared"), true);
  assert.equal(isTurnFinalText(agentId, "first paragraph"), false);
  assert.equal(isTurnFinalText(agentId, "first paragraph\n\nsecond paragraph"), true);
  release();
});

test("live fragments sharing the final id form one continuous card", async () => {
  const agentId = `merged-live-fragments-${Date.now()}`;
  const timeline = {
    subscribe(): () => void {
      return () => {};
    },
    async refetch() {
      return {
        entries: [
          {
            item: {
              type: "assistant_message",
              messageId: "shared-final",
              text: "First paragraph.\n\nLast paragraph.",
            },
            turnId: "turn-1",
            seqEnd: 3,
            collapsed: ["assistant_merge"],
          },
        ],
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  };
  const releaseIndex = retainTurnIndex(agentId, timeline);
  const releaseFirst = retainTurnFinalFragment({
    agentId,
    sourceKey: "first",
    messageId: "shared-final",
    text: "First paragraph.",
    timestamp: 1,
  });
  const releaseDivider = retainTurnFinalFragment({
    agentId,
    sourceKey: "divider",
    messageId: "shared-final",
    text: "---",
    timestamp: 2,
  });
  const releaseLast = retainTurnFinalFragment({
    agentId,
    sourceKey: "last",
    messageId: "shared-final",
    text: "Last paragraph.",
    timestamp: 3,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getTurnFinalCardPosition(agentId, "first"), "start");
  assert.equal(getTurnFinalCardPosition(agentId, "divider"), "none");
  assert.equal(getTurnFinalCardPosition(agentId, "last"), "end");

  releaseLast();
  releaseDivider();
  releaseFirst();
  releaseIndex();
});

test("a completed turn marks only the assistant message after its final tool call", async () => {
  const agentId = `turn-tool-tail-${Date.now()}`;
  let agentStatus = "running";
  let notify: ((message: unknown) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      return {
        entries: [
          {
            item: { type: "user_message", messageId: "user", text: "task" },
            turnId: "turn-1",
            seqEnd: 1,
          },
          {
            item: { type: "assistant_message", messageId: "progress", text: "Working on it." },
            turnId: "turn-1",
            seqEnd: 2,
            collapsed: ["assistant_merge"],
          },
          {
            item: { type: "tool_call", status: "completed" },
            turnId: "turn-1",
            seqEnd: 3,
            collapsed: ["tool_lifecycle"],
          },
          {
            item: { type: "assistant_message", messageId: "final", text: "Finished." },
            turnId: "turn-1",
            seqEnd: 4,
            collapsed: ["assistant_merge"],
          },
        ],
        agent: { status: agentStatus },
        hasOlder: false,
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline);
  await new Promise<void>((resolve) => setImmediate(resolve));

  // The assistant tail is still provisional until the turn actually ends.
  assert.equal(isTurnFinalMessage(agentId, "progress"), false);
  assert.equal(isTurnFinalMessage(agentId, "final"), false);
  assert.equal(isTurnFinalText(agentId, "Finished."), false);

  agentStatus = "idle";
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(isTurnFinalMessage(agentId, "progress"), false);
  assert.equal(isTurnFinalText(agentId, "Working on it."), false);
  assert.equal(isTurnFinalMessage(agentId, "final"), true);
  assert.equal(isTurnFinalText(agentId, "Finished."), true);
  release();
});

test("overlapping refresh requests are serialized and keep a trailing refresh", async () => {
  const agentId = `serialized-refresh-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let active = 0;
  let maxActive = 0;
  const resolvers: Array<(page: {
    entries: Array<{ item: { type: string; messageId: string; text: string }; seqEnd: number }>;
    hasOlder: boolean;
  }) => void> = [];
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    refetch() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<{
        entries: Array<{ item: { type: string; messageId: string; text: string }; seqEnd: number }>;
        hasOlder: boolean;
      }>((resolve) => {
        resolvers.push((page) => {
          active -= 1;
          resolve(page);
        });
      });
    },
  };
  const release = retainTurnIndex(agentId, timeline);
  await new Promise<void>((resolve) => setImmediate(resolve));
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.equal(resolvers.length, 1);
  resolvers[0]({ entries: [], hasOlder: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  resolvers[1]({ entries: [], hasOlder: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 1);
  release();
});

test("failed history backfill is eligible for retry on the next update", async () => {
  const agentId = `backfill-retry-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let beforeCalls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        if (beforeCalls === 1) throw new Error("temporary history failure");
        return { entries: [], hasOlder: false, startCursor: null };
      }
      return {
        entries: [{ item: { type: "assistant_message", messageId: "m1", text: "tail" }, seqEnd: 10 }],
        hasOlder: true,
        startCursor: { epoch: "e", seq: 10 },
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 2);
  release();
});
