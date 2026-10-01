import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlocks, parseInline } from "../shared/markdown-parse.ts";
import { blockReviewTarget, imageReviewTarget, locateReviewTarget, reviewTargetSchema, tableCellReviewTarget } from "../shared/review-target.ts";
import { findReviewCommentParagraphIndex, formatReview, parseReviewMessage, reviewCommentSchema, type ReviewComment } from "../shared/review.ts";
import { addComment, getComments, hydrate, relocateComment, registerPersist, persistAgentNow } from "../client/review-store.ts";

const table = "| Product | Price |\n| --- | --- |\n| Phone | 20 |\n| Tablet | 20 |";
const parsedTable = parseBlocks(table)[0];
assert.equal(parsedTable.kind, "table");
if (parsedTable.kind !== "table") throw new Error("Invalid fixture");
const cell = tableCellReviewTarget(parsedTable, [0], 1, 1);

test("table cells preserve row and column context across inserted rows and paragraphs", () => {
  const shifted = table.replace("| Phone |", "| Watch | 10 |\n| Phone |");
  const located = locateReviewTarget(shifted, cell);
  assert.ok(located && located.kind === "table-cell");
  assert.equal(located.row, 2);
  assert.equal(located.column, 1);
  assert.equal(findReviewCommentParagraphIndex({ paragraphIndex: 0, paragraphText: table, target: cell }, ["Intro", shifted]), 1);
  assert.equal(locateReviewTarget(table.replace("Tablet", "Camera"), cell), null);
  assert.equal(locateReviewTarget(table.replace("Price", "Weight"), cell), null);
  const header = tableCellReviewTarget(parsedTable, [0], -1, 1);
  assert.deepEqual(locateReviewTarget(table, header), header);
});

test("nested table and image targets use the same recursive Markdown paths as rendering", () => {
  const quote = table.split("\n").map(line => `> ${line}`).join("\n");
  const nestedCell = { ...cell, path: [0, 0] };
  assert.deepEqual(locateReviewTarget(quote, nestedCell), nestedCell);
  const image = parseInline("![Diagram](file:///tmp/diagram.png)")[0];
  assert.equal(image.type, "image");
  if (image.type !== "image") throw new Error("Invalid fixture");
  const target = imageReviewTarget(image, [0, 0], 0);
  assert.deepEqual(locateReviewTarget("> ![Diagram](file:///tmp/diagram.png)", target), target);
  assert.equal(locateReviewTarget("> ![Diagram](file:///tmp/other.png)", target), null);
});

test("images retain ordering beside externally defined reference links", () => {
  const target = imageReviewTarget({ type: "image", url: "/tmp/b.png", alt: "B" }, [0], 1);
  const refs = new Map([["a", "/tmp/a.png"], ["b", "/tmp/b.png"]]);
  assert.deepEqual(locateReviewTarget("![A](/tmp/a.png)[Reference][a]![B](/tmp/b.png)", target, refs), target);
  const shifted = locateReviewTarget("![C](/tmp/c.png)![A](/tmp/a.png)[Reference][a]![B](/tmp/b.png)", target, refs);
  assert.ok(shifted && shifted.kind === "image");
  assert.equal(shifted.imageIndex, 2);
});

test("structured blocks preserve precise kind and streamed prefixes without matching unrelated text", () => {
  const heading = parseBlocks("## Title")[0];
  const target = blockReviewTarget(heading, [0]);
  assert.ok(target);
  assert.deepEqual(locateReviewTarget("## Title", target), target);
  assert.equal(locateReviewTarget("Title", target), null);
  const quote = parseBlocks(`> ${"Context ".repeat(8)}`)[0];
  const quoteTarget = blockReviewTarget(quote, [0]);
  assert.ok(quoteTarget);
  assert.ok(locateReviewTarget(`> ${"Context ".repeat(8)}continued`, quoteTarget));
  assert.equal(locateReviewTarget("> unrelated", quoteTarget), null);
  assert.equal(locateReviewTarget("## Title\n\n## Title", { ...target, path: [99] }), null);
});

test("general response comments are first and round-trip with targeted and legacy comments", () => {
  const base = { agentId: "a", messageId: "m", paragraphIndex: 0, paragraphText: table, text: "Check this", createdAt: "2026-10-01", status: "pending" };
  const specific = reviewCommentSchema.parse({ ...base, id: "cell", target: cell });
  const general = reviewCommentSchema.parse({ ...base, id: "general", paragraphIndex: -1, target: { kind: "response" }, text: "Overall direction" });
  const legacy = reviewCommentSchema.parse({ ...base, id: "legacy" });
  const sent = reviewCommentSchema.parse({ ...base, id: "sent", target: { kind: "response" }, status: "sent" });
  const parsed = parseReviewMessage(formatReview([specific, legacy, general, sent]));
  assert.deepEqual(parsed.entries.map(entry => entry.comment), ["Overall direction", "Check this", "Check this"]);
  assert.match(parsed.entries[0].quote, /^Entire response:/);
  assert.match(parsed.entries[1].quote, /Table row 2.*Price.*20.*Tablet/);
  assert.equal(findReviewCommentParagraphIndex(general, [table]), -1);
  assert.equal(legacy.target, undefined);
  assert.equal(reviewTargetSchema.safeParse({ ...cell, column: -1 }).success, false);
});

test("target identity survives store persistence, streaming relocation and device hydration", async () => {
  const agentId = `targets-${Date.now()}`;
  let saved: ReviewComment[] = [];
  const unregister = registerPersist(async input => { if (input.agentId === agentId) saved = input.comments; });
  try {
    const first = addComment({ agentId, messageId: null, sourceKey: "source", paragraphIndex: 0, paragraphText: table, target: cell, text: "Same text" });
    const second = addComment({ agentId, messageId: null, sourceKey: "source", paragraphIndex: 0, paragraphText: table, target: tableCellReviewTarget(parsedTable, [0], 0, 1), text: "Same text" });
    assert.notEqual(first.id, second.id);
    const response = addComment({ agentId, messageId: null, sourceKey: "source", paragraphIndex: -1, paragraphText: "Response", target: { kind: "response" }, text: "General" });
    relocateComment(first.id, "message", 1, undefined, { ...cell, path: [1] });
    relocateComment(response.id, "message", -1, undefined, response.target);
    await persistAgentNow(agentId);
    assert.equal(saved.length, 3);
    hydrate(agentId, saved.map(comment => reviewCommentSchema.parse(JSON.parse(JSON.stringify(comment)))));
    const restored = getComments().find(comment => comment.id === first.id)!;
    assert.equal(restored.messageId, "message");
    assert.equal(restored.sourceKey, null);
    assert.equal(restored.paragraphIndex, 1);
    assert.deepEqual(restored.target, { ...cell, path: [1] });
    assert.equal(getComments().find(comment => comment.id === response.id)?.target?.kind, "response");
  } finally { await unregister(); }
});
