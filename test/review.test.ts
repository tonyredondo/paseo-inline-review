import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILE_TRANSFER_CHUNK_BYTES,
  commentBelongsToReviewSource,
  createCodeLineAnchor,
  findReviewCommentParagraphIndex,
  formatReview,
  isMarkdownPath,
  locateCodeLineAnchor,
  openLocalFileRpc,
  parseCodeReviewQuote,
  parseReviewMessage,
  reviewCommentSchema,
  sameCodeLineAnchor,
  shortenQuote,
  splitParagraphs,
  userMessageHasHostAttachments,
} from "../shared/review.ts";

test("Markdown preview recognizes common Markdown file extensions", () => {
  for (const path of ["README.md", "/tmp/report.MD", "guide.markdown", "notes.mdown", "doc.mkd", "doc.mkdn", "page.mdx"]) {
    assert.equal(isMarkdownPath(path), true, path);
  }
  for (const path of ["README", "report.txt", "/tmp/archive.md.bak", ".markdownlint.json"]) {
    assert.equal(isMarkdownPath(path), false, path);
  }
});

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

test("code-line anchors persist surrounding context without breaking legacy comments", () => {
  const codeAnchor = createCodeLineAnchor(
    ["setup()", "const repeated = value", "target()", "const repeated = value", "cleanup()"].join("\n"),
    1,
    3,
  );
  assert.deepEqual(codeAnchor, {
    blockIndex: 1,
    lineIndex: 3,
    lineText: "const repeated = value",
    contextBefore: ["const repeated = value", "target()"],
    contextAfter: ["cleanup()"],
  });
  const parsed = reviewCommentSchema.parse({
    id: "code-line",
    agentId: "a",
    messageId: "m",
    paragraphIndex: 2,
    itemIndex: null,
    paragraphText: "```ts\nconst repeated = value\n```",
    codeAnchor,
    text: "comment",
    createdAt: "2026-01-01",
    status: "pending",
  });
  assert.deepEqual(parsed.codeAnchor, codeAnchor);
  assert.equal(sameCodeLineAnchor(undefined, null), true);
});

test("code-line anchors use both previous and next context to disambiguate repeated lines", () => {
  const original = [
    "beforeFirst()",
    "repeat()",
    "afterFirst()",
    "beforeSecond()",
    "repeat()",
    "afterSecond()",
  ].join("\n");
  const anchor = createCodeLineAnchor(original, 0, 4);
  const shiftedParagraph = [
    "```ts",
    "inserted()",
    "beforeFirst()",
    "repeat()",
    "afterFirst()",
    "beforeSecond()",
    "repeat()",
    "afterSecond()",
    "```",
  ].join("\n");
  const located = locateCodeLineAnchor(shiftedParagraph, anchor);
  assert.equal(located?.blockIndex, 0);
  assert.equal(located?.lineIndex, 5);
  assert.equal(located?.lineText, "repeat()");
  assert.deepEqual(located?.contextBefore, ["afterFirst()", "beforeSecond()"]);
  assert.deepEqual(located?.contextAfter, ["afterSecond()"]);
});

test("code-line anchors do not attach to an unrelated occurrence with no matching context", () => {
  const anchor = createCodeLineAnchor("expectedBefore()\nrepeat()\nexpectedAfter()", 0, 1);
  const unrelated = "```ts\nunrelatedBefore()\nrepeat()\nunrelatedAfter()\n```";
  assert.equal(locateCodeLineAnchor(unrelated, anchor), null);
});

test("code-line block indexes count code blocks rather than surrounding Markdown blocks", () => {
  const anchor = createCodeLineAnchor("secondTarget()", 1, 0);
  const paragraph = [
    "intro text",
    "```ts",
    "firstTarget()",
    "```",
    "middle text",
    "```ts",
    "secondTarget()",
    "```",
  ].join("\n");
  assert.equal(locateCodeLineAnchor(paragraph, anchor)?.blockIndex, 1);
});

test("completed messages re-anchor code-line comments using their surrounding context", () => {
  const anchor = createCodeLineAnchor(
    ["firstContext()", "same()", "firstAfter()", "secondContext()", "same()", "secondAfter()"].join("\n"),
    0,
    4,
  );
  const comment = reviewCommentSchema.parse({
    id: "code-streaming",
    agentId: "a",
    messageId: null,
    sourceKey: "source-a",
    paragraphIndex: 0,
    paragraphText: "```ts\nsecondContext()\nsame()",
    codeAnchor: anchor,
    text: "this occurrence",
    createdAt: "2026-09-22T00:00:00.000Z",
    status: "pending",
  });
  const paragraphs = [
    "intro",
    "```ts\nfirstContext()\nsame()\nfirstAfter()\nsecondContext()\nsame()\nsecondAfter()\n```",
  ];
  assert.equal(findReviewCommentParagraphIndex(comment, paragraphs), 1);
  assert.equal(locateCodeLineAnchor(paragraphs[1], anchor)?.lineIndex, 4);
});

test("formatted code-line reviews identify the selected line and include its context", () => {
  const codeAnchor = createCodeLineAnchor("before()\nrepeat()\nafter()", 0, 1);
  const out = formatReview([{
    id: "code-format",
    agentId: "a",
    messageId: "m",
    paragraphIndex: 0,
    itemIndex: null,
    paragraphText: "```ts\nbefore()\nrepeat()\nafter()\n```",
    codeAnchor,
    text: "change only this occurrence",
    createdAt: "2026-09-22T00:00:00.000Z",
    revision: 1,
    status: "pending" as const,
  }]);
  assert.match(out, /Code block 1, line 2/);
  assert.match(out, /before\(\).*>>> repeat\(\).*after\(\)/s);
  assert.match(out, /Comment: "change only this occurrence"/);
  assert.deepEqual(parseReviewMessage(out).entries, [{
    quote: "Code block 1, line 2:\nbefore()\n>>> repeat()\nafter()",
    comment: "change only this occurrence",
  }]);
});

test("code review quotes become numbered context rows with one selected line", () => {
  assert.deepEqual(
    parseCodeReviewQuote([
      "Code block 2, line 7:",
      "beforeOne()",
      "beforeTwo()",
      ">>> target()",
      "afterOne()",
    ].join("\n")),
    {
      blockNumber: 2,
      lineNumber: 7,
      lines: [
        { lineNumber: 5, text: "beforeOne()", selected: false },
        { lineNumber: 6, text: "beforeTwo()", selected: false },
        { lineNumber: 7, text: "target()", selected: true },
        { lineNumber: 8, text: "afterOne()", selected: false },
      ],
    },
  );
  assert.equal(parseCodeReviewQuote("A normal paragraph quote"), null);
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

test("native user cards defer to host-owned attachment rows", () => {
  assert.equal(userMessageHasHostAttachments({ text: "plain" }), false);
  assert.equal(userMessageHasHostAttachments({ text: "plain", images: [] }), false);
  assert.equal(userMessageHasHostAttachments({ text: "image", images: [{ mimeType: "image/png" }] }), true);
  assert.equal(userMessageHasHostAttachments({ text: "file", attachments: { count: 1 } }), true);
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
