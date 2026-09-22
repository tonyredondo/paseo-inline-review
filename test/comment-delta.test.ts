import assert from "node:assert/strict";
import { test } from "node:test";

import { createCommentDeltaAdapter } from "../client/comment-delta.ts";
import type { ReviewComment } from "../shared/review.ts";

function comment(id: string, revision = 1) {
  return {
    id, agentId: "a", messageId: "m", paragraphIndex: 0, itemIndex: null,
    paragraphText: "p", text: `text-${revision}`, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:00:0${revision}.000Z`, revision, status: "pending" as const,
  };
}

test("delta persistence sends only changed records and new tombstones", async () => {
  const calls: Array<{ agentId: string; upserts: ReviewComment[]; deleted: string[] }> = [];
  const adapter = createCommentDeltaAdapter(async (input) => { calls.push(input); });
  adapter.seed("a", [comment("one"), comment("two")]);
  await adapter.save({ agentId: "a", comments: [comment("one"), comment("two", 2)] });
  assert.deepEqual(calls[0].upserts.map((item) => item.id), ["two"]);
  await adapter.save({ agentId: "a", comments: [comment("one"), comment("two", 2)] });
  assert.equal(calls.length, 1);
  await adapter.save({ agentId: "a", comments: [comment("two", 2)], deleted: ["one"] });
  assert.deepEqual(calls[1], { agentId: "a", upserts: [], deleted: ["one"] });
});

test("failed deltas remain unacknowledged and retry unchanged", async () => {
  let calls = 0;
  const adapter = createCommentDeltaAdapter(async (input) => {
    calls += 1;
    assert.equal(input.upserts.length, 1);
    if (calls === 1) throw new Error("offline");
  });
  await assert.rejects(adapter.save({ agentId: "a", comments: [comment("one")] }), /offline/);
  await adapter.save({ agentId: "a", comments: [comment("one")] });
  assert.equal(calls, 2);
});
