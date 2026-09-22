import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  disposeTurnIndexes,
  getTurnFinalCardPosition,
  isTurnFinalMessage,
  isTurnFinalText,
  retainTurnFinalFragment,
  retainTurnIndex,
  subscribeTurnIndex,
} from "../client/turn-final-store.ts";

after(() => disposeTurnIndexes());

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
  const releaseFirst = retainTurnIndex(agentId, timeline, 0);
  const releaseSecond = retainTurnIndex(agentId, timeline, 0);
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
  const releaseFragment = retainTurnFinalFragment({
    agentId,
    sourceKey: "old-row",
    messageId: "old",
    text: "old text",
    timestamp: 1,
  });
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 2);
  releaseFragment();
  release();
});

test("startup fetches one tail and no historical page until an old row is mounted", async () => {
  const agentId = `lazy-history-${Date.now()}`;
  let tailCalls = 0;
  let beforeCalls = 0;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        return {
          entries: [{
            item: { type: "assistant_message", messageId: "old", text: "old final" },
            turnId: "old-turn", seqEnd: 10,
          }],
          agent: { status: "idle" },
          hasOlder: false,
          startCursor: null,
        };
      }
      tailCalls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "recent", text: "recent final" },
          turnId: "recent-turn", seqEnd: 1000,
        }],
        agent: { status: "idle" },
        hasOlder: true,
        startCursor: { epoch: "e", seq: 1000 },
      };
    },
  };
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tailCalls, 1);
  assert.equal(beforeCalls, 0);
  assert.equal(isTurnFinalMessage(agentId, "recent"), true);

  const releaseFragment = retainTurnFinalFragment({
    agentId, sourceKey: "old-source", messageId: "old", text: "old final", timestamp: 1,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  assert.equal(isTurnFinalMessage(agentId, "old"), true);
  releaseFragment();
  releaseIndex();
});

test("two mounted historical rows share one demand-driven page walk", async () => {
  const agentId = `shared-history-${Date.now()}`;
  let beforeCalls = 0;
  const releaseFirstFragment = retainTurnFinalFragment({
    agentId, sourceKey: "one", messageId: "old-1", text: "old one", timestamp: 1,
  });
  const releaseSecondFragment = retainTurnFinalFragment({
    agentId, sourceKey: "two", messageId: "old-2", text: "old two", timestamp: 2,
  });
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        return {
          entries: [
            { item: { type: "assistant_message", messageId: "old-1", text: "old one" }, turnId: "t1", seqEnd: 1 },
            { item: { type: "assistant_message", messageId: "old-2", text: "old two" }, turnId: "t2", seqEnd: 2 },
          ],
          agent: { status: "idle" }, hasOlder: false, startCursor: null,
        };
      }
      return {
        entries: [], agent: { status: "idle" }, hasOlder: true,
        startCursor: { epoch: "e", seq: 100 },
      };
    },
  };
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  assert.equal(isTurnFinalMessage(agentId, "old-1"), true);
  assert.equal(isTurnFinalMessage(agentId, "old-2"), true);
  releaseIndex();
  releaseSecondFragment();
  releaseFirstFragment();
});

test("an index remount inside the grace period reuses bootstrap and subscription", async () => {
  const agentId = `index-grace-${Date.now()}`;
  let subscriptions = 0;
  let cleanups = 0;
  let tailCalls = 0;
  const timeline = {
    subscribe(): () => void {
      subscriptions += 1;
      return () => { cleanups += 1; };
    },
    async refetch() {
      tailCalls += 1;
      return { entries: [], hasOlder: false, startCursor: null };
    },
  };
  const releaseFirst = retainTurnIndex(agentId, timeline, 30);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  const releaseSecond = retainTurnIndex(agentId, timeline, 30);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(subscriptions, 1);
  assert.equal(tailCalls, 1);
  assert.equal(cleanups, 0);
  releaseSecond();
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(cleanups, 1);
});

test("timeline epoch replacement drops stale final classifications", async () => {
  const agentId = `epoch-replacement-${Date.now()}`;
  let notify: (() => void) | null = null;
  let epoch = "first";
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = () => handler(undefined);
      return () => {};
    },
    async refetch() {
      const first = epoch === "first";
      return {
        entries: [{
          item: { type: "assistant_message", messageId: first ? "old" : "new", text: first ? "old" : "new" },
          turnId: first ? "old-turn" : "new-turn",
          seqEnd: first ? 10 : 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
        startCursor: { epoch, seq: first ? 10 : 1 },
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "old"), true);
  epoch = "second";
  (notify as unknown as () => void)();
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "old"), false);
  assert.equal(isTurnFinalMessage(agentId, "new"), true);
  release();
});

test("a historical lookup completing after disposal cannot publish", async () => {
  const agentId = `disposed-backfill-${Date.now()}`;
  let resolveOlder: ((page: {
    entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
    agent: { status: string };
    hasOlder: boolean;
    startCursor: null;
  }) => void) | null = null;
  let cleanupCalls = 0;
  let beforeCalls = 0;
  const timeline = {
    subscribe(): () => void { return () => { cleanupCalls += 1; }; },
    async refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        return new Promise<{
          entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
          agent: { status: string };
          hasOlder: boolean;
          startCursor: null;
        }>((resolve) => { resolveOlder = resolve; });
      }
      return {
        entries: [], agent: { status: "idle" }, hasOlder: true,
        startCursor: { epoch: "e", seq: 100 },
      };
    },
  };
  const releaseFragment = retainTurnFinalFragment({
    agentId, sourceKey: "old", messageId: "old", text: "old final", timestamp: 1,
  });
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  let publications = 0;
  const unsubscribe = subscribeTurnIndex(agentId, () => { publications += 1; });
  for (let attempt = 0; attempt < 20 && beforeCalls === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(beforeCalls, 1);
  releaseIndex();
  const beforeCompletion = publications;
  (resolveOlder as unknown as (page: {
    entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
    agent: { status: string };
    hasOlder: boolean;
    startCursor: null;
  }) => void)({
    entries: [{ item: { type: "assistant_message", messageId: "old", text: "old final" }, turnId: "t", seqEnd: 1 }],
    agent: { status: "idle" }, hasOlder: false, startCursor: null,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
  assert.equal(publications, beforeCompletion);
  assert.equal(isTurnFinalMessage(agentId, "old"), false);
  unsubscribe();
  releaseFragment();
});
