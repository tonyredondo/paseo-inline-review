import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  disposeTurnIndexes,
  getTurnFinalCardPosition,
  getTurnFinalCardText,
  isTurnFinalMessage,
  isTurnFinalText,
  mountTurnFinalFragment,
  retainTurnFinalFragment,
  retainTurnIndex,
  subscribeTurnFinalFragments,
  subscribeTurnIndex,
  turnFinalFragmentDiagnostics,
  turnFinalScopeKey,
  turnIndexDiagnostics,
  updateTurnAgentStatus,
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

test("identical agent ids on different hosts keep independent turn indexes", async () => {
  const agentId = `shared-agent-${Date.now()}`;
  const firstScope = turnFinalScopeKey("M5", agentId);
  const secondScope = turnFinalScopeKey("M4", agentId);
  assert.notEqual(firstScope, secondScope);
  const timeline = (messageId: string) => ({
    subscribe(): () => void { return () => {}; },
    async refetch() {
      return {
        entries: [{
          item: { type: "assistant_message", messageId, text: messageId },
          turnId: "turn",
          seqEnd: 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  });
  const releaseFirst = retainTurnIndex(firstScope, timeline("first"), 0);
  const releaseSecond = retainTurnIndex(secondScope, timeline("second"), 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(isTurnFinalMessage(firstScope, "first"), true);
  assert.equal(isTurnFinalMessage(firstScope, "second"), false);
  assert.equal(isTurnFinalMessage(secondScope, "second"), true);
  assert.equal(isTurnFinalMessage(secondScope, "first"), false);
  releaseSecond();
  releaseFirst();
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
    phase: "complete",
  });
  const releaseDivider = retainTurnFinalFragment({
    agentId,
    sourceKey: "divider",
    messageId: "shared-final",
    text: "---",
    timestamp: 2,
    phase: "complete",
  });
  const releaseLast = retainTurnFinalFragment({
    agentId,
    sourceKey: "last",
    messageId: "shared-final",
    text: "Last paragraph.",
    timestamp: 3,
    phase: "complete",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getTurnFinalCardPosition(agentId, "first"), "start");
  assert.equal(getTurnFinalCardPosition(agentId, "divider"), "none");
  assert.equal(getTurnFinalCardPosition(agentId, "last"), "end");
  assert.equal(
    getTurnFinalCardText(agentId, "last"),
    "First paragraph.\n\nLast paragraph.",
    "the final slice copies the exact consolidated response",
  );
  assert.equal(getTurnFinalCardText(agentId, "first"), null);
  assert.equal(getTurnFinalCardText(agentId, "divider"), null);

  releaseLast();
  releaseDivider();
  releaseFirst();
  releaseIndex();
});

test("streaming fragment text updates do not fan out to every sibling", async () => {
  const agentId = `fragment-updates-${Date.now()}`;
  let notifications = 0;
  const unsubscribe = subscribeTurnFinalFragments(agentId, "stream", () => { notifications += 1; });
  const mounted = mountTurnFinalFragment({
    agentId,
    sourceKey: "stream",
    messageId: "message",
    text: "start",
    timestamp: 1,
    phase: "streaming",
  });
  for (let index = 0; index < 100; index += 1) {
    mounted.update({ messageId: "message", text: `stream ${index}`, timestamp: 1, phase: "streaming" });
  }
  assert.equal(notifications, 1);
  mounted.release();
  assert.equal(notifications, 2);
  unsubscribe();
});

test("append-only streaming preserves visibility and rewrites can still hide a fragment", () => {
  const agentId = `fragment-visibility-${Date.now()}`;
  let notifications = 0;
  const unsubscribe = subscribeTurnFinalFragments(agentId, "stream", () => { notifications += 1; });
  const mounted = mountTurnFinalFragment({
    agentId,
    sourceKey: "stream",
    messageId: "message",
    text: "---",
    timestamp: 1,
    phase: "streaming",
  });
  assert.equal(notifications, 1);

  mounted.update({
    messageId: "message",
    text: "---\n\nvisible",
    timestamp: 1,
    phase: "streaming",
  });
  assert.equal(notifications, 2, "newly appended content makes the fragment visible");
  mounted.update({
    messageId: "message",
    text: "---\n\nvisible and still growing",
    timestamp: 1,
    phase: "streaming",
  });
  assert.equal(notifications, 2, "append-only text keeps the existing topology");
  mounted.update({ messageId: "message", text: "---", timestamp: 1, phase: "streaming" });
  assert.equal(notifications, 3, "a non-append rewrite is inspected in full");

  mounted.release();
  unsubscribe();
});

test("mounting unrelated fragments notifies only their own subscribers", () => {
  const agentId = `fragment-scoped-mounts-${Date.now()}`;
  const rowCount = 300;
  let notifications = 0;
  const unsubscribers = Array.from({ length: rowCount }, (_, index) =>
    subscribeTurnFinalFragments(agentId, `source-${index}`, () => {
      notifications += 1;
    }),
  );
  const fragments = Array.from({ length: rowCount }, (_, index) =>
    mountTurnFinalFragment({
      agentId,
      sourceKey: `source-${index}`,
      messageId: `message-${index}`,
      text: `message ${index}`,
      timestamp: index,
      phase: "streaming",
    }),
  );

  assert.equal(notifications, rowCount);

  for (const unsubscribe of unsubscribers) unsubscribe();
  for (const fragment of fragments) fragment.release();
});

test("fragment topology changes notify only siblings sharing the message id", () => {
  const agentId = `fragment-scoped-siblings-${Date.now()}`;
  const notifications = new Map<string, number>();
  const subscribe = (sourceKey: string) =>
    subscribeTurnFinalFragments(agentId, sourceKey, () => {
      notifications.set(sourceKey, (notifications.get(sourceKey) ?? 0) + 1);
    });
  const unsubscribeFirst = subscribe("first");
  const unsubscribeLast = subscribe("last");
  const unsubscribeOther = subscribe("other");
  const first = mountTurnFinalFragment({
    agentId, sourceKey: "first", messageId: "shared", text: "first", timestamp: 1, phase: "streaming",
  });
  const last = mountTurnFinalFragment({
    agentId, sourceKey: "last", messageId: "shared", text: "last", timestamp: 2, phase: "streaming",
  });
  const other = mountTurnFinalFragment({
    agentId, sourceKey: "other", messageId: "unrelated", text: "other", timestamp: 3, phase: "streaming",
  });
  notifications.clear();

  first.update({ messageId: "shared", text: "---", timestamp: 1, phase: "streaming" });

  assert.deepEqual(Object.fromEntries(notifications), { first: 1, last: 1 });

  notifications.clear();
  first.update({ messageId: "unrelated", text: "first", timestamp: 1, phase: "streaming" });
  assert.deepEqual(Object.fromEntries(notifications), { first: 1, last: 1, other: 1 });

  notifications.clear();
  first.update({ messageId: "unrelated", text: "---", timestamp: 1, phase: "streaming" });
  assert.deepEqual(Object.fromEntries(notifications), { first: 1, other: 1 });

  unsubscribeOther();
  unsubscribeLast();
  unsubscribeFirst();
  other.release();
  last.release();
  first.release();
});

test("final card positions are built once per fragment and index version", async () => {
  const agentId = `position-cache-${Date.now()}`;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "shared", text: "first\n\nlast" },
          turnId: "turn",
          seqEnd: 3,
        }],
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  };
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  const first = mountTurnFinalFragment({ agentId, sourceKey: "first", messageId: "shared", text: "first", timestamp: 1, phase: "complete" });
  const last = mountTurnFinalFragment({ agentId, sourceKey: "last", messageId: "shared", text: "last", timestamp: 2, phase: "complete" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getTurnFinalCardPosition(agentId, "first"), "start");
  assert.equal(getTurnFinalCardPosition(agentId, "last"), "end");
  assert.equal(getTurnFinalCardPosition(agentId, "first"), "start");
  assert.deepEqual(turnFinalFragmentDiagnostics(agentId), { positionBuilds: 1 });
  last.release();
  first.release();
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

test("a running completed-looking tail does not poll indefinitely without an event", async () => {
  const agentId = `no-running-poll-${Date.now()}`;
  let calls = 0;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "tail", text: "provisional" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 950));
  assert.equal(calls, 1);
  release();
});

test("an agent status event finalizes the tail without another timeline request", async () => {
  const agentId = `status-finality-${Date.now()}`;
  let calls = 0;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "tail", text: "done" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "tail"), false);
  updateTurnAgentStatus(agentId, "idle");
  assert.equal(isTurnFinalMessage(agentId, "tail"), true);
  assert.equal(calls, 1);
  release();
});

test("starting a new user turn keeps the previous final card while history catches up", async () => {
  const agentId = `new-turn-card-continuity-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let entries: Array<{
    item: { type: string; messageId?: string; text?: string; status?: string };
    turnId: string;
    seqEnd: number;
  }> = [{
    item: { type: "assistant_message", messageId: "previous-final", text: "done" },
    turnId: "turn-1",
    seqEnd: 1,
  }];
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      return {
        entries,
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "previous-final"), true);

  // Paseo publishes the running agent snapshot before the new user row reaches
  // the timeline. The previous completed card must remain visually stable in
  // that interval instead of briefly reverting to a plain message.
  updateTurnAgentStatus(agentId, "running");
  assert.equal(isTurnFinalMessage(agentId, "previous-final"), true);

  entries = [
    entries[0],
    {
      item: { type: "user_message", messageId: "new-user", text: "follow up" },
      turnId: "turn-2",
      seqEnd: 2,
    },
  ];
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.equal(isTurnFinalMessage(agentId, "previous-final"), true);

  // A real continuation of the same turn still removes the stale final card
  // once the timeline, rather than the earlier status snapshot, proves it.
  entries = [
    entries[0],
    {
      item: { type: "tool_call", status: "running" },
      turnId: "turn-1",
      seqEnd: 3,
    },
  ];
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.equal(isTurnFinalMessage(agentId, "previous-final"), false);

  release();
});

test("an identified user boundary closes a preceding anonymous assistant turn", async () => {
  const agentId = `mixed-turn-boundary-${Date.now()}`;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      return {
        entries: [
          {
            item: {
              type: "assistant_message",
              messageId: "anonymous-final",
              text: "Previous final response.",
            },
            seqEnd: 1,
          },
          {
            item: { type: "user_message", messageId: "identified-user", text: "Follow up." },
            turnId: "turn-2",
            seqEnd: 2,
          },
        ],
        agent: { status: "running" },
        hasOlder: false,
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(isTurnFinalMessage(agentId, "anonymous-final"), true);
  assert.equal(isTurnFinalText(agentId, "Previous final response."), true);
  release();
});

test("a native fragment without an id matches final text after host separators are removed", async () => {
  const agentId = `native-normalized-final-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let status = "running";
  let entries = [
    {
      item: {
        type: "assistant_message",
        messageId: "previous-final",
        text: "\n\n---\n\nPrevious final response.",
      },
      turnId: "turn-1",
      seqEnd: 1,
    },
    {
      item: { type: "user_message", messageId: "new-user", text: "follow up" },
      turnId: "turn-2",
      seqEnd: 2,
    },
    {
      item: { type: "assistant_message", text: "Current progress." },
      turnId: "turn-2",
      seqEnd: 3,
    },
    {
      item: { type: "tool_call", status: "running" },
      turnId: "turn-2",
      seqEnd: 4,
    },
  ];
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      return {
        entries,
        agent: { status },
        hasOlder: false,
      };
    },
  };

  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  const previous = mountTurnFinalFragment({
    agentId,
    sourceKey: "previous-visible-row",
    messageId: null,
    text: "Previous final response.",
    timestamp: 1,
    phase: "complete",
  });
  const current = mountTurnFinalFragment({
    agentId,
    sourceKey: "current-streaming-row",
    messageId: null,
    text: "Current progress.",
    timestamp: 2,
    phase: "streaming",
  });
  const internalRule = mountTurnFinalFragment({
    agentId,
    sourceKey: "internal-rule-row",
    messageId: null,
    text: "Previous final response.\n\n---\n\nDifferent content.",
    timestamp: 3,
    phase: "complete",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getTurnFinalCardPosition(agentId, "previous-visible-row"), "single");
  assert.equal(getTurnFinalCardText(agentId, "previous-visible-row"), "\n\n---\n\nPrevious final response.");
  assert.equal(getTurnFinalCardPosition(agentId, "current-streaming-row"), "none");
  assert.equal(getTurnFinalCardPosition(agentId, "internal-rule-row"), "none");

  status = "idle";
  entries = [
    ...entries.slice(0, 4),
    {
      item: {
        type: "assistant_message",
        messageId: "current-final",
        text: "\n\n---\n\nCurrent final response.",
      },
      turnId: "turn-2",
      seqEnd: 5,
    },
  ];
  current.update({
    messageId: null,
    text: "Current final response.",
    timestamp: 2,
    phase: "complete",
  });
  (notify as unknown as (message: unknown) => void)(undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));

  assert.equal(getTurnFinalCardPosition(agentId, "previous-visible-row"), "single");
  assert.equal(getTurnFinalCardPosition(agentId, "current-streaming-row"), "single");
  assert.equal(getTurnFinalCardText(agentId, "current-streaming-row"), "\n\n---\n\nCurrent final response.");

  internalRule.release();
  current.release();
  previous.release();
  releaseIndex();
});

test("a native fragment without an id matches a final hidden memory citation", async () => {
  const agentId = `native-hidden-memory-citation-${Date.now()}`;
  const visibleText = "Completed response.\n\n- `npm test`: passes.";
  const timelineText = `${visibleText}\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:43-43|note=[runtime lifecycle context]\n</citation_entries>\n<rollout_ids>\n01a0c817-5288-7160-af97-a566a2ad2e56\n</rollout_ids>\n</oai-mem-citation>`;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      return {
        entries: [{
          item: { type: "assistant_message", text: timelineText },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  };

  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "visible-final-row",
    messageId: null,
    text: visibleText,
    timestamp: 1,
    // Codex can finish the turn without republishing the renderer row as complete.
    phase: "streaming",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getTurnFinalCardPosition(agentId, "visible-final-row"), "single");
  assert.equal(getTurnFinalCardText(agentId, "visible-final-row"), visibleText);

  fragment.release();
  releaseIndex();
});

test("a native fragment matches when an inline memory marker hides the remaining response", async () => {
  const agentId = `native-inline-memory-marker-${Date.now()}`;
  const visibleText = "Fixed. The timeline keeps the hidden block `";
  const timelineText = `${visibleText}<oai-mem-citation>\`.\n\nLater visible explanation.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:43-43|note=[runtime lifecycle context]\n</citation_entries>\n<rollout_ids>\n01a0c817-5288-7160-af97-a566a2ad2e56\n</rollout_ids>\n</oai-mem-citation>`;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      return {
        entries: [{
          item: { type: "assistant_message", text: timelineText },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
      };
    },
  };

  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "truncated-visible-final-row",
    messageId: null,
    text: visibleText,
    timestamp: 1,
    phase: "streaming",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getTurnFinalCardPosition(agentId, "truncated-visible-final-row"), "single");
  assert.equal(getTurnFinalCardText(agentId, "truncated-visible-final-row"), visibleText);

  fragment.release();
  releaseIndex();
});

test("a live idle snapshot wins over an older timeline response", async () => {
  const agentId = `status-race-${Date.now()}`;
  type StatusPage = {
    entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
    agent: { status: string };
    hasOlder: boolean;
  };
  let resolveTimeline: ((page: StatusPage) => void) | null = null;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    refetch() {
      return new Promise<StatusPage>((resolve) => { resolveTimeline = resolve; });
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  updateTurnAgentStatus(agentId, "idle");
  (resolveTimeline as unknown as (page: StatusPage) => void)({
    entries: [{
      item: { type: "assistant_message", messageId: "tail", text: "done" },
      turnId: "turn-1",
      seqEnd: 1,
    }],
    agent: { status: "running" },
    hasOlder: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "tail"), true);
  release();
});

test("a closed snapshot reconciles a renderer-only final response once", async () => {
  const agentId = `renderer-only-final-${Date.now()}`;
  let calls = 0;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch() {
      calls += 1;
      if (calls === 1) {
        return {
          entries: [{
            item: { type: "assistant_message", messageId: "previous", text: "Previous response." },
            turnId: "turn-1",
            seqEnd: 1,
          }],
          agent: { status: "running" },
          hasOlder: false,
          startCursor: { epoch: "epoch-1", seq: 1 },
        };
      }
      return {
        entries: [
          {
            item: { type: "assistant_message", messageId: "previous", text: "Previous response." },
            turnId: "turn-1",
            seqEnd: 1,
          },
          {
            item: { type: "assistant_message", messageId: "current", text: "Current final response." },
            turnId: "turn-2",
            seqEnd: 2,
          },
        ],
        agent: { status: "idle" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };

  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  updateTurnAgentStatus(agentId, "running");
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "renderer-only-response",
    messageId: "current",
    text: "Current final response.",
    timestamp: 2,
    // This is the observed Paseo path: the renderer never publishes complete.
    phase: "streaming",
  });

  assert.equal(getTurnFinalCardPosition(agentId, "renderer-only-response"), "none");
  updateTurnAgentStatus(agentId, "idle");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(calls, 2, "closing the turn must reconcile the missed timeline tail exactly once");
  assert.equal(getTurnFinalCardPosition(agentId, "renderer-only-response"), "single");
  assert.equal(getTurnFinalCardText(agentId, "renderer-only-response"), "Current final response.");

  fragment.release();
  releaseIndex();
});

test("renderer updates after an early idle snapshot share one tail reconciliation", async () => {
  const agentId = `renderer-after-idle-${Date.now()}`;
  let calls = 0;
  let resolveReconciliation: ((page: {
    entries: Array<{
      item: { type: string; messageId: string; text: string };
      turnId: string;
      seqEnd: number;
    }>;
    agent: { status: string };
    hasOlder: false;
    startCursor: { epoch: string; seq: number };
  }) => void) | null = null;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    refetch() {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          entries: [],
          agent: { status: "running" },
          hasOlder: false as const,
          startCursor: { epoch: "epoch-1", seq: 0 },
        });
      }
      return new Promise<{
        entries: Array<{
          item: { type: string; messageId: string; text: string };
          turnId: string;
          seqEnd: number;
        }>;
        agent: { status: string };
        hasOlder: false;
        startCursor: { epoch: string; seq: number };
      }>((resolve) => { resolveReconciliation = resolve; });
    },
  };

  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  updateTurnAgentStatus(agentId, "idle");
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "late-renderer-response",
    messageId: "current",
    text: "Current",
    timestamp: 1,
    phase: "streaming",
  });
  fragment.update({
    messageId: "current",
    text: "Current final",
    timestamp: 1,
    phase: "streaming",
  });
  fragment.update({
    messageId: "current",
    text: "Current final response.",
    timestamp: 1,
    phase: "streaming",
  });

  assert.equal(calls, 2, "renderer chunks must share the in-flight reconciliation");
  (resolveReconciliation as unknown as (page: unknown) => void)({
    entries: [{
      item: { type: "assistant_message", messageId: "current", text: "Current final response." },
      turnId: "turn-1",
      seqEnd: 1,
    }],
    agent: { status: "idle" },
    hasOlder: false,
    startCursor: { epoch: "epoch-1", seq: 1 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls, 2);
  assert.equal(getTurnFinalCardPosition(agentId, "late-renderer-response"), "single");
  fragment.release();
  releaseIndex();
});

test("a timeline-backed live final does not trigger terminal reconciliation", async () => {
  const agentId = `timeline-backed-final-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 0 },
      };
    },
  };

  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "timeline-backed-response",
    messageId: "current",
    text: "Current final response.",
    timestamp: 1,
    phase: "streaming",
  });
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    seq: 1,
    event: {
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "current", text: "Current final response." },
    },
  });
  updateTurnAgentStatus(agentId, "idle");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(calls, 1, "the already indexed final must not refetch the tail");
  assert.equal(getTurnFinalCardPosition(agentId, "timeline-backed-response"), "single");
  fragment.release();
  releaseIndex();
});

test("a retained index performs no refetch after its last consumer releases", async () => {
  const agentId = `inactive-index-${Date.now()}`;
  let calls = 0;
  let notify: (() => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = () => handler(undefined);
      return () => {};
    },
    async refetch() {
      calls += 1;
      return { entries: [], agent: { status: "idle" }, hasOlder: false };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 2_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  (notify as unknown as () => void)();
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.equal(calls, 1);
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

test("timeline stream events update the tail without refetching the last 100 entries", async () => {
  const agentId = `incremental-tail-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "tail", text: "start" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let index = 0; index < 100; index += 1) {
    (notify as unknown as (message: unknown) => void)({
      agentId,
      epoch: "epoch-1",
      seq: 1,
      timestamp: new Date().toISOString(),
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", messageId: "tail", text: `stream ${index}` },
      },
    });
  }
  updateTurnAgentStatus(agentId, "idle");

  assert.equal(isTurnFinalText(agentId, "stream 99"), true);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.equal(calls, 1);
  release();
});

test("a stale bootstrap response cannot overwrite a newer timeline event", async () => {
  const agentId = `incremental-bootstrap-race-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  let resolvePage: ((page: {
    entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
    agent: { status: string };
    hasOlder: false;
    startCursor: { epoch: string; seq: number };
  }) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    refetch() {
      calls += 1;
      return new Promise<{
        entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
        agent: { status: string };
        hasOlder: false;
        startCursor: { epoch: string; seq: number };
      }>((resolve) => { resolvePage = resolve; });
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    seq: 1,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "tail", text: "new " },
    },
  });
  (resolvePage as unknown as (page: unknown) => void)({
    entries: [{
      item: { type: "assistant_message", messageId: "tail", text: "stale page" },
      turnId: "turn-1",
      seqEnd: 1,
    }],
    agent: { status: "running" },
    hasOlder: false,
    startCursor: { epoch: "epoch-1", seq: 1 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    seq: 2,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "tail", text: "event" },
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  updateTurnAgentStatus(agentId, "idle");

  assert.equal(calls, 1, "the preserved event sequence must prevent a redundant gap refetch");
  assert.equal(isTurnFinalText(agentId, "new event"), true);
  assert.equal(isTurnFinalText(agentId, "stale page"), false);
  release();
});

test("a closed canonical snapshot replaces an incomplete live overlay for the final card", async () => {
  const agentId = `closed-snapshot-live-overlay-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let resolvePage: ((page: {
    entries: Array<{
      item: { type: string; messageId: string; text: string };
      turnId: string;
      seqStart: number;
      seqEnd: number;
    }>;
    agent: { status: string };
    hasOlder: false;
    startCursor: { epoch: string; seq: number };
  }) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    refetch() {
      return new Promise<{
        entries: Array<{
          item: { type: string; messageId: string; text: string };
          turnId: string;
          seqStart: number;
          seqEnd: number;
        }>;
        agent: { status: string };
        hasOlder: false;
        startCursor: { epoch: string; seq: number };
      }>((resolve) => { resolvePage = resolve; });
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "rendered-final",
    messageId: "final-message",
    text: "Complete final response.",
    timestamp: 1,
    phase: "complete",
  });
  const emit = (seq: number, text: string) =>
    (notify as unknown as (message: unknown) => void)({
      agentId,
      epoch: "epoch-1",
      seq,
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", messageId: "final-message", text },
      },
    });
  emit(1, "Complete ");
  emit(2, "final");
  (resolvePage as unknown as (page: unknown) => void)({
    entries: [{
      item: {
        type: "assistant_message",
        messageId: "final-message",
        text: "Complete final response.",
      },
      turnId: "turn-1",
      seqStart: 1,
      seqEnd: 2,
    }],
    agent: { status: "idle" },
    hasOlder: false,
    startCursor: { epoch: "epoch-1", seq: 1 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getTurnFinalCardPosition(agentId, "rendered-final"), "single");
  assert.equal(getTurnFinalCardText(agentId, "rendered-final"), "Complete final response.");
  fragment.release();
  release();
});

test("a live continuation received during bootstrap joins its fetched prefix", async () => {
  const agentId = `incremental-bootstrap-fragment-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let resolvePage: ((page: {
    entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
    agent: { status: string };
    hasOlder: false;
    startCursor: { epoch: string; seq: number };
  }) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    refetch() {
      return new Promise<{
        entries: Array<{ item: { type: string; messageId: string; text: string }; turnId: string; seqEnd: number }>;
        agent: { status: string };
        hasOlder: false;
        startCursor: { epoch: string; seq: number };
      }>((resolve) => { resolvePage = resolve; });
    },
  };
  const release = retainTurnIndex(agentId, timeline, 0);
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "bootstrap-fragment-response",
    messageId: "assistant-1",
    text: "Hello world",
    timestamp: 1,
    phase: "complete",
  });
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    seq: 2,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "assistant-1", text: "world" },
    },
  });
  (resolvePage as unknown as (page: unknown) => void)({
    entries: [{
      item: { type: "assistant_message", messageId: "assistant-1", text: "Hello " },
      turnId: "turn-1",
      seqEnd: 1,
    }],
    agent: { status: "running" },
    hasOlder: false,
    startCursor: { epoch: "epoch-1", seq: 1 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  (notify as unknown as (message: unknown) => void)({
    agentId,
    event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
  });

  assert.equal(getTurnFinalCardPosition(agentId, "bootstrap-fragment-response"), "single");
  assert.equal(getTurnFinalCardText(agentId, "bootstrap-fragment-response"), "Hello world");
  fragment.release();
  release();
});

test("incremental timeline bursts coalesce final-index publications", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const agentId = `incremental-coalescing-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "tail", text: "start" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let publications = 0;
  const unsubscribe = subscribeTurnIndex(agentId, () => { publications += 1; });

  for (let index = 0; index < 100; index += 1) {
    (notify as unknown as (message: unknown) => void)({
      agentId,
      epoch: "epoch-1",
      seq: 1,
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", messageId: "tail", text: `stream ${index}` },
      },
    });
  }

  assert.equal(publications, 0);
  context.mock.timers.tick(50);
  assert.equal(publications, 1);
  assert.equal(isTurnFinalText(agentId, "stream 99"), true);
  unsubscribe();
  release();
});

test("incremental timeline storage remains bounded across long turns", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const agentId = `incremental-bounds-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "user_message", messageId: "user-1", text: "start" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (let seq = 2; seq <= 251; seq += 1) {
    (notify as unknown as (message: unknown) => void)({
      agentId,
      epoch: "epoch-1",
      seq,
      event: {
        type: "timeline",
        provider: "codex",
        turnId: `turn-${seq}`,
        item: { type: "user_message", messageId: `user-${seq}`, text: `message ${seq}` },
      },
    });
  }
  context.mock.timers.tick(50);

  assert.deepEqual(turnIndexDiagnostics(agentId), { tailEntries: 100, liveEntries: 100 });
  assert.equal(calls, 1);
  release();
});

test("bootstrap overlap keeps evicted tail history demand-loadable", async () => {
  const agentId = `incremental-bootstrap-cursor-${Date.now()}`;
  type TestPage = {
    entries: Array<{
      item: { type: string; messageId: string; text: string };
      turnId: string;
      seqEnd: number;
    }>;
    agent: { status: string };
    hasOlder: boolean;
    startCursor: { epoch: string; seq: number } | null;
  };
  let notify: ((message: unknown) => void) | null = null;
  let resolveTail: ((page: TestPage) => void) | null = null;
  const beforeCursors: Array<{ epoch: string; seq: number } | undefined> = [];
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    refetch(options?: { direction?: string; cursor?: { epoch: string; seq: number } }) {
      if (options?.direction === "before") {
        beforeCursors.push(options.cursor);
        return Promise.resolve({
          entries: [{
            item: { type: "assistant_message", messageId: "oldest", text: "oldest response" },
            turnId: "turn-1",
            seqEnd: 1,
          }],
          agent: { status: "running" },
          hasOlder: false,
          startCursor: null,
        });
      }
      return new Promise<TestPage>((resolve) => { resolveTail = resolve; });
    },
  };
  const release = retainTurnIndex(agentId, timeline, 0);
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    seq: 101,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-101",
      item: { type: "assistant_message", messageId: "newest", text: "newest response" },
    },
  });
  (resolveTail as unknown as (page: TestPage) => void)({
    entries: Array.from({ length: 100 }, (_, index) => ({
      item: {
        type: "assistant_message",
        messageId: index === 0 ? "oldest" : `message-${index + 1}`,
        text: index === 0 ? "oldest response" : `response ${index + 1}`,
      },
      turnId: `turn-${index + 1}`,
      seqEnd: index + 1,
    })),
    agent: { status: "running" },
    hasOlder: false,
    startCursor: { epoch: "epoch-1", seq: 1 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const releaseFragment = retainTurnFinalFragment({
    agentId,
    sourceKey: "evicted-oldest",
    messageId: "oldest",
    text: "oldest response",
    timestamp: 1,
    phase: "complete",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(beforeCursors, [{ epoch: "epoch-1", seq: 2 }]);
  releaseFragment();
  release();
});

test("terminal and non-timeline stream events do not refetch history", async () => {
  const agentId = `incremental-terminal-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "tail", text: "done" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    event: { type: "permission_requested", provider: "codex" },
  });
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
  });

  assert.equal(isTurnFinalMessage(agentId, "tail"), true);
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.equal(calls, 1);
  release();
});

test("turn_started keeps an incrementally streamed tail provisional until completion", async () => {
  const agentId = `incremental-running-status-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "previous", text: "previous" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };
  const emit = (message: unknown) =>
    (notify as unknown as (message: unknown) => void)(message);

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit({ agentId, event: { type: "turn_started", provider: "codex", turnId: "turn-2" } });
  emit({
    agentId,
    epoch: "epoch-1",
    seq: 2,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-2",
      item: { type: "assistant_message", messageId: "streaming", text: "still growing" },
    },
  });

  assert.equal(isTurnFinalMessage(agentId, "previous"), true);
  assert.equal(isTurnFinalMessage(agentId, "streaming"), false);
  emit({ agentId, event: { type: "turn_completed", provider: "codex", turnId: "turn-2" } });
  assert.equal(isTurnFinalMessage(agentId, "streaming"), true);
  assert.equal(calls, 1);
  release();
});

test("fragmented assistant timeline events form the completed final card", async () => {
  const agentId = `incremental-fragmented-assistant-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      return {
        entries: [{
          item: { type: "user_message", messageId: "user-1", text: "question" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };
  const emit = (message: unknown) =>
    (notify as unknown as (message: unknown) => void)(message);
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "rendered-response",
    messageId: "assistant-1",
    text: "The first part.",
    timestamp: 1,
    phase: "complete",
  });

  emit({ agentId, event: { type: "turn_started", provider: "codex", turnId: "turn-1" } });
  emit({
    agentId,
    epoch: "epoch-1",
    seq: 2,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "assistant-1", text: "The first " },
    },
  });
  emit({
    agentId,
    epoch: "epoch-1",
    seq: 3,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "assistant-1", text: "part." },
    },
  });
  emit({ agentId, event: { type: "turn_completed", provider: "codex", turnId: "turn-1" } });

  assert.equal(getTurnFinalCardPosition(agentId, "rendered-response"), "single");
  assert.equal(getTurnFinalCardText(agentId, "rendered-response"), "The first part.");
  fragment.release();
  release();
});

test("fragmented final text preserves whitespace and does not cross tool boundaries", async () => {
  const agentId = `incremental-fragments-after-tool-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      return {
        entries: [{
          item: { type: "user_message", messageId: "user-1", text: "question" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };
  const emitTimeline = (seq: number, item: Record<string, unknown>) =>
    (notify as unknown as (message: unknown) => void)({
      agentId,
      epoch: "epoch-1",
      seq,
      event: { type: "timeline", provider: "codex", turnId: "turn-1", item },
    });
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "rendered-final-response",
    messageId: null,
    text: "Final answer\n\nDone.",
    timestamp: 1,
    phase: "complete",
  });

  emitTimeline(2, { type: "assistant_message", text: "Working " });
  emitTimeline(3, { type: "assistant_message", text: "now" });
  emitTimeline(4, { type: "tool_call", status: "completed" });
  emitTimeline(5, { type: "assistant_message", text: "Final answer" });
  emitTimeline(6, { type: "assistant_message", text: "\n\n" });
  emitTimeline(7, { type: "assistant_message", text: "Done." });
  (notify as unknown as (message: unknown) => void)({
    agentId,
    event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
  });

  assert.equal(isTurnFinalText(agentId, "Working now"), false);
  assert.equal(getTurnFinalCardPosition(agentId, "rendered-final-response"), "single");
  assert.equal(getTurnFinalCardText(agentId, "rendered-final-response"), "Final answer\n\nDone.");
  fragment.release();
  release();
});

test("a sequence gap refetches once instead of applying an incomplete tail", async () => {
  const agentId = `incremental-gap-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: "tail", text: calls === 1 ? "one" : "three" },
          turnId: "turn-1",
          seqEnd: calls === 1 ? 1 : 3,
        }],
        agent: { status: "idle" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: calls === 1 ? 1 : 3 },
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  (notify as unknown as (message: unknown) => void)({
    agentId,
    epoch: "epoch-1",
    seq: 3,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn-1",
      item: { type: "assistant_message", messageId: "tail", text: "three" },
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.equal(calls, 2);
  assert.equal(isTurnFinalText(agentId, "three"), true);
  release();
});

test("an explicit epoch replacement clears stale finals and refetches once", async () => {
  const agentId = `explicit-replacement-${Date.now()}`;
  let notify: ((message: unknown) => void) | null = null;
  let epoch = "first";
  let calls = 0;
  const timeline = {
    subscribe(handler: (message: unknown) => void): () => void {
      notify = handler;
      return () => {};
    },
    async refetch() {
      calls += 1;
      return {
        entries: [{
          item: { type: "assistant_message", messageId: epoch, text: epoch },
          turnId: epoch,
          seqEnd: 1,
        }],
        agent: { status: "idle" },
        hasOlder: false,
        startCursor: { epoch, seq: 1 },
      };
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "first"), true);
  epoch = "second";
  (notify as unknown as (message: unknown) => void)({
    agentId,
    event: { type: "replacement", epoch: "second" },
  });
  assert.equal(isTurnFinalMessage(agentId, "first"), false);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.equal(calls, 2);
  assert.equal(isTurnFinalMessage(agentId, "second"), true);
  release();
});

test("a timed-out refetch remains single-flight until its RPC settles", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const agentId = `bounded-refetch-${Date.now()}`;
  let calls = 0;
  const releases: Array<(page: { entries: []; hasOlder: false }) => void> = [];
  const timeline = {
    subscribe(): () => void { return () => {}; },
    refetch() {
      calls += 1;
      return new Promise<{ entries: []; hasOlder: false }>((resolve) => releases.push(resolve));
    },
  };

  const release = retainTurnIndex(agentId, timeline, 0);
  try {
    assert.equal(calls, 1);
    context.mock.timers.tick(4_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "a timeout must not start compatibility RPCs beside the pending request");
    releases[0]({ entries: [], hasOlder: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, "the index must retry once the owned RPC actually settles");
  } finally {
    release();
    for (const resolve of releases) resolve({ entries: [], hasOlder: false });
  }
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
    phase: "complete",
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
  const requests: Array<{
    direction?: string;
    limit?: number;
    cursor?: { epoch: string; seq: number };
  } | undefined> = [];
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch(options?: {
      direction?: string;
      limit?: number;
      cursor?: { epoch: string; seq: number };
    }) {
      requests.push(options);
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
  assert.deepEqual(requests, [{ direction: "tail", limit: 100 }]);
  assert.equal(isTurnFinalMessage(agentId, "recent"), true);

  const releaseFragment = retainTurnFinalFragment({
    agentId, sourceKey: "old-source", messageId: "old", text: "old final", timestamp: 1, phase: "complete",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  assert.deepEqual(requests[1], {
    direction: "before",
    cursor: { epoch: "e", seq: 1000 },
    limit: 200,
  });
  assert.equal(isTurnFinalMessage(agentId, "old"), true);
  releaseFragment();
  releaseIndex();
});

test("a live id-less streaming fragment never requests historical pages", async () => {
  const agentId = `live-idless-${Date.now()}`;
  let beforeCalls = 0;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        return {
          entries: [],
          agent: { status: "running" },
          hasOlder: true,
          startCursor: { epoch: "e", seq: 100 - beforeCalls },
        };
      }
      return {
        entries: [],
        agent: { status: "running" },
        hasOlder: true,
        startCursor: { epoch: "e", seq: 100 },
      };
    },
  };
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "live-row",
    messageId: null,
    text: "streaming prefix",
    timestamp: 1,
    phase: "streaming",
  });
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(beforeCalls, 0);
  fragment.release();
  releaseIndex();
});

test("an id-less fragment requests history once after it becomes complete", async () => {
  const agentId = `completed-idless-${Date.now()}`;
  let beforeCalls = 0;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    async refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        return {
          entries: [{
            item: { type: "assistant_message", text: "final text" },
            turnId: "old-turn",
            seqEnd: 1,
          }],
          agent: { status: "idle" },
          hasOlder: false,
          startCursor: null,
        };
      }
      return {
        entries: [],
        agent: { status: "idle" },
        hasOlder: true,
        startCursor: { epoch: "e", seq: 100 },
      };
    },
  };
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "transitioning-row",
    messageId: null,
    text: "partial",
    timestamp: 1,
    phase: "streaming",
  });
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 0);

  fragment.update({
    messageId: null,
    text: "final text",
    timestamp: 1,
    phase: "complete",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  assert.equal(isTurnFinalText(agentId, "final text"), true);
  assert.equal(getTurnFinalCardText(agentId, "transitioning-row"), "final text");

  fragment.release();
  releaseIndex();
});

test("unmounting a historical fragment stops its page walk", async () => {
  const agentId = `cancelled-history-${Date.now()}`;
  let beforeCalls = 0;
  let resolveBefore: ((page: {
    entries: never[];
    hasOlder: boolean;
    startCursor: { epoch: string; seq: number };
  }) => void) | null = null;
  const timeline = {
    subscribe(): () => void { return () => {}; },
    refetch(options?: { direction?: string }) {
      if (options?.direction === "before") {
        beforeCalls += 1;
        return new Promise<{
          entries: never[];
          hasOlder: boolean;
          startCursor: { epoch: string; seq: number };
        }>((resolve) => { resolveBefore = resolve; });
      }
      return Promise.resolve({
        entries: [],
        agent: { status: "idle" },
        hasOlder: true,
        startCursor: { epoch: "e", seq: 100 },
      });
    },
  };
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "old-row",
    messageId: "missing",
    text: "missing text",
    timestamp: 1,
    phase: "complete",
  });
  const releaseIndex = retainTurnIndex(agentId, timeline, 0);
  for (let attempt = 0; attempt < 20 && beforeCalls === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(beforeCalls, 1);

  fragment.release();
  (resolveBefore as unknown as (page: {
    entries: never[];
    hasOlder: boolean;
    startCursor: { epoch: string; seq: number };
  }) => void)({ entries: [], hasOlder: true, startCursor: { epoch: "e", seq: 99 } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(beforeCalls, 1);
  releaseIndex();
});

test("two mounted historical rows share one demand-driven page walk", async () => {
  const agentId = `shared-history-${Date.now()}`;
  let beforeCalls = 0;
  const releaseFirstFragment = retainTurnFinalFragment({
    agentId, sourceKey: "one", messageId: "old-1", text: "old one", timestamp: 1, phase: "complete",
  });
  const releaseSecondFragment = retainTurnFinalFragment({
    agentId, sourceKey: "two", messageId: "old-2", text: "old two", timestamp: 2, phase: "complete",
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
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "epoch-row",
    messageId: "old",
    text: "old",
    timestamp: 1,
    phase: "complete",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "old"), true);
  assert.equal(getTurnFinalCardText(agentId, "epoch-row"), "old");
  epoch = "second";
  (notify as unknown as () => void)();
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isTurnFinalMessage(agentId, "old"), false);
  assert.equal(isTurnFinalMessage(agentId, "new"), true);
  assert.equal(getTurnFinalCardText(agentId, "epoch-row"), null);
  fragment.release();
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
    agentId, sourceKey: "old", messageId: "old", text: "old final", timestamp: 1, phase: "complete",
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
