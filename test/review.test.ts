import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILE_TRANSFER_CHUNK_BYTES,
  commentBelongsToReviewSource,
  findReviewCommentParagraphIndex,
  formatReview,
  openLocalFileRpc,
  parseReviewMessage,
  reviewCommentSchema,
  shortenQuote,
  splitParagraphs,
} from "../shared/review.ts";

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
      revision: 1,
      status: "pending" as const,
    },
  ]);
  assert.match(out, /\[1\] On: "The bug is here"/);
  assert.match(out, /Comment: "Fix the null check"/);
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
  assert.equal(legacy.revision, 0);
});

test("file RPC carries source identity and caps each transfer at 5 MB", () => {
  assert.throws(() => openLocalFileRpc.input.parse({
    path: "/tmp/file",
    mode: "download",
    length: FILE_TRANSFER_CHUNK_BYTES + 1,
  }));
  const parsed = openLocalFileRpc.input.parse({
    path: "/tmp/file",
    mode: "download",
    length: FILE_TRANSFER_CHUNK_BYTES,
    fileVersion: "v1",
  });
  assert.equal(parsed.fileVersion, "v1");
});

test("formatted reviews round-trip quotes, backslashes and multiline comments", () => {
  const text = formatReview([{
    id: "complex",
    agentId: "a",
    messageId: "m",
    paragraphIndex: 0,
    paragraphText: 'A "quoted" C:\\path',
    text: "first line\n\nsecond line",
    createdAt: "2026-09-22T00:00:00.000Z",
    revision: 1,
    status: "pending",
  }]);
  assert.deepEqual(parseReviewMessage(`Preface\n\n${text}`), {
    note: "Preface",
    entries: [{ quote: 'A "quoted" C:\\path', comment: "first line\n\nsecond line" }],
  });
});

test("streaming comments belong only to their mounted source", () => {
  const comment = reviewCommentSchema.parse({
    id: "streaming",
    agentId: "a",
    messageId: null,
    sourceKey: "source-a",
    paragraphIndex: 0,
    paragraphText: "same paragraph",
    text: "comment",
    createdAt: "2026-09-22T00:00:00.000Z",
    status: "pending",
  });
  assert.equal(commentBelongsToReviewSource(comment, null, "source-a"), true);
  assert.equal(commentBelongsToReviewSource(comment, null, "source-b"), false);
});

test("completed messages re-anchor streaming list-item comments", () => {
  const comment = reviewCommentSchema.parse({
    id: "list-streaming",
    agentId: "a",
    messageId: null,
    sourceKey: "source-a",
    paragraphIndex: 0,
    itemIndex: 1,
    paragraphText: "second item",
    text: "comment",
    createdAt: "2026-09-22T00:00:00.000Z",
    status: "pending",
  });
  assert.equal(findReviewCommentParagraphIndex(comment, ["intro", "- first item\n- second item"]), 1);
});
