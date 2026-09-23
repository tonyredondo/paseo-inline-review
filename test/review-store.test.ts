import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addComment,
  getCommentsForSource,
  getComments,
  hasPendingSaves,
  hydrate,
  markAgentCommentsSent,
  markCommentsSent,
  persistAgentNow,
  relocateComment,
  registerPersist,
  subscribeCommentsForSource,
  updateComment,
} from "../client/review-store.ts";

test("immediate saves are serialized and preserve the latest status", async () => {
  const agentId = `save-order-${Date.now()}`;
  const calls: Array<{
    comments: Array<{ status: "pending" | "sent" }>;
    release: () => void;
  }> = [];
  const unregister = registerPersist((input) => new Promise<void>((resolve) => {
    calls.push({ comments: input.comments, release: resolve });
  }));

  addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });
  const first = persistAgentNow(agentId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].comments[0].status, "pending");

  markAgentCommentsSent(agentId);
  const second = persistAgentNow(agentId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "the second RPC waits for the first");
  calls[0].release();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].comments[0].status, "sent");
  calls[1].release();
  await second;
  assert.equal(getComments().find((comment) => comment.agentId === agentId)?.status, "sent");
  await unregister();
});

test("immediate persistence exposes RPC failures", async () => {
  const agentId = `save-failure-${Date.now()}`;
  let attempts = 0;
  const unregister = registerPersist(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk full");
  });
  addComment({
    agentId,
    messageId: null,
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });
  await assert.rejects(persistAgentNow(agentId), /disk full/);
  assert.equal(hasPendingSaves(agentId), true);
  await unregister();
});

test("a comment edited during a send stays pending", async () => {
  const agentId = `edited-during-send-${Date.now()}`;
  const unregister = registerPersist(async () => {});
  const original = addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "original",
  });
  updateComment(original.id, "edited");
  markCommentsSent([original]);
  assert.equal(getComments().find((comment) => comment.id === original.id)?.status, "pending");
  await persistAgentNow(agentId);
  await unregister();
});

test("a comment changed and restored during a send stays pending", async () => {
  const agentId = `restored-during-send-${Date.now()}`;
  const unregister = registerPersist(async () => {});
  const original = addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "original",
  });
  updateComment(original.id, "temporary edit");
  updateComment(original.id, "original");
  markCommentsSent([original]);
  assert.equal(getComments().find((comment) => comment.id === original.id)?.status, "pending");
  await persistAgentNow(agentId);
  await unregister();
});

test("failed saves retry and clear dirty state after recovery", async () => {
  const agentId = `save-retry-${Date.now()}`;
  let calls = 0;
  const unregister = registerPersist(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary outage");
  });
  addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });
  await assert.rejects(persistAgentNow(agentId), /temporary outage/);
  await new Promise<void>((resolve) => setTimeout(resolve, 550));
  assert.equal(calls, 2);
  assert.equal(hasPendingSaves(agentId), false);
  await unregister();
});

test("persistence cleanup waits for the final dirty snapshot", async () => {
  const agentId = `cleanup-flush-${Date.now()}`;
  let release: (() => void) | null = null;
  const unregister = registerPersist(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });
  let finished = false;
  const cleanup = unregister().then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.ok(release);
  (release as unknown as () => void)();
  await cleanup;
  assert.equal(finished, true);
});

test("persistence cleanup retries a transient final-save failure", async () => {
  const agentId = `cleanup-retry-${Date.now()}`;
  let attempts = 0;
  const unregister = registerPersist(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("daemon restarting");
  });
  addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });
  await unregister();
  assert.equal(attempts, 3);
  assert.equal(hasPendingSaves(agentId), false);
});

test("newer hydrated edits win and stale copies cannot overwrite them", async () => {
  const agentId = `hydrate-version-${Date.now()}`;
  const unregister = registerPersist(async () => {});
  const local = addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "local",
  });
  hydrate(agentId, [{
    ...local,
    text: "remote newer",
    revision: local.revision + 1,
    updatedAt: "9999-01-01T00:00:00.000Z",
  }]);
  assert.equal(getComments().find((comment) => comment.id === local.id)?.text, "remote newer");
  hydrate(agentId, [{
    ...local,
    text: "remote stale",
    revision: local.revision,
    updatedAt: local.updatedAt,
  }]);
  assert.equal(getComments().find((comment) => comment.id === local.id)?.text, "remote newer");
  await persistAgentNow(agentId);
  await unregister();
});

test("duplicate detection keeps identical comments on different list items", async () => {
  const agentId = `list-duplicates-${Date.now()}`;
  const unregister = registerPersist(async () => {});
  const first = addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    itemIndex: 0,
    paragraphText: "first item",
    text: "same comment",
  });
  const second = addComment({
    agentId,
    messageId: "m1",
    paragraphIndex: 0,
    itemIndex: 1,
    paragraphText: "second item",
    text: "same comment",
  });
  assert.notEqual(first.id, second.id);
  assert.equal(getComments().filter((comment) => comment.agentId === agentId).length, 2);
  await persistAgentNow(agentId);
  await unregister();
});

test("one comment mutation notifies only its mounted message source", () => {
  const agentId = `source-notifications-${Date.now()}`;
  const notifications = Array.from({ length: 300 }, () => 0);
  const unsubscribers = notifications.map((_, index) =>
    subscribeCommentsForSource(agentId, `message-${index}`, `source-${index}`, () => {
      notifications[index] += 1;
    }),
  );

  addComment({
    agentId,
    messageId: "message-137",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });

  assert.equal(notifications.reduce((total, count) => total + count, 0), 1);
  assert.equal(notifications[137], 1);
  assert.equal(getCommentsForSource(agentId, "message-137", "source-137").length, 1);
  assert.equal(getCommentsForSource(agentId, "message-138", "source-138").length, 0);
  unsubscribers.forEach((unsubscribe) => unsubscribe());
});

test("relocating a streaming comment notifies its old and completed sources", () => {
  const agentId = `source-relocation-${Date.now()}`;
  let streamingNotifications = 0;
  let completedNotifications = 0;
  const unsubscribeStreaming = subscribeCommentsForSource(agentId, null, "stream-source", () => {
    streamingNotifications += 1;
  });
  const unsubscribeCompleted = subscribeCommentsForSource(agentId, "message-final", "unused", () => {
    completedNotifications += 1;
  });
  const comment = addComment({
    agentId,
    messageId: null,
    sourceKey: "stream-source",
    paragraphIndex: 0,
    paragraphText: "paragraph",
    text: "comment",
  });

  assert.equal(streamingNotifications, 1);
  assert.equal(completedNotifications, 0);
  relocateComment(comment.id, "message-final", 0);
  assert.equal(streamingNotifications, 2);
  assert.equal(completedNotifications, 1);
  assert.equal(getCommentsForSource(agentId, null, "stream-source").length, 0);
  assert.equal(getCommentsForSource(agentId, "message-final", "unused").length, 1);
  unsubscribeStreaming();
  unsubscribeCompleted();
});
