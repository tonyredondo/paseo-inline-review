import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReview, reviewCommentSchema, shortenQuote, splitParagraphs, type ReviewComment } from "../shared/review.ts";

test("splitParagraphs splits on blank lines and trims empties", () => {
  assert.deepEqual(splitParagraphs("one\n\ntwo\n\n\n\nthree"), ["one", "two", "three"]);
  assert.deepEqual(splitParagraphs("\n\n  spaced  \n\n"), ["spaced"]);
  assert.deepEqual(splitParagraphs(""), []);
});

test("single newlines stay inside one paragraph", () => {
  assert.deepEqual(splitParagraphs("line a\nline b"), ["line a\nline b"]);
});

test("fenced code blocks stay whole even with blank lines inside", () => {
  const text = "intro\n\n```\nAntes:\ntest span \u2014\u2014\u2510\n\nhttp span \u2014\u2014\u2518\n```\n\ndespues";
  assert.deepEqual(splitParagraphs(text), ["intro", "```\nAntes:\ntest span \u2014\u2014\u2510\n\nhttp span \u2014\u2014\u2518\n```", "despues"]);
});

test("unclosed fence while streaming stays one chunk", () => {
  assert.deepEqual(splitParagraphs("```\npartial\n\nmore"), ["```\npartial\n\nmore"]);
});

test("blank lines inside indented text still split outside fences", () => {
  assert.deepEqual(splitParagraphs("a\n\n\tb\n\nc"), ["a", "b", "c"]);
});

test("shortenQuote flattens whitespace and truncates", () => {
  assert.equal(shortenQuote("a  \n b"), "a b");
  assert.equal(shortenQuote("x".repeat(400)).length, 280);
  assert.ok(shortenQuote("x".repeat(400)).endsWith("\u2026"));
  assert.equal(shortenQuote("short"), "short");
});

test("formatReview emits numbered quotes and comments", () => {
  const out = formatReview([
    {
      id: "1",
      agentId: "a",
      messageId: "m",
      paragraphIndex: 0,
      paragraphText: "The bug is here",
      text: "Fix the null check",
      createdAt: new Date().toISOString(),
      status: "pending" as const,
    },
  ]);
  assert.match(out, /\[1\] On: "The bug is here"/);
  assert.match(out, /Comment: Fix the null check/);
  assert.equal(formatReview([]), "");
});

test("review comment schema accepts per-item comments with itemIndex", () => {
  const parsed = reviewCommentSchema.parse({
    id: "c1",
    agentId: "a",
    messageId: null,
    paragraphIndex: 2,
    itemIndex: 1,
    paragraphText: "item text",
    text: "comment",
    createdAt: "2026-01-01",
    status: "pending",
  });
  assert.equal(parsed.itemIndex, 1);
  // Legacy comments without itemIndex keep working (absent = paragraph-level).
  const legacy = reviewCommentSchema.parse({
    id: "c2",
    agentId: "a",
    messageId: null,
    paragraphIndex: 0,
    paragraphText: "p",
    text: "t",
    createdAt: "2026-01-01",
    status: "sent",
  });
  assert.equal(legacy.itemIndex, undefined);
});
