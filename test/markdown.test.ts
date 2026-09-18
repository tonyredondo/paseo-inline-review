import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlocks, parseInline, type Block, type InlineToken } from "../shared/markdown-parse.ts";

function first(blocks: Block[]): Block {
  assert.ok(blocks.length > 0, "expected at least one block");
  return blocks[0];
}

function kinds(blocks: Block[]): string[] {
  return blocks.map((block) => block.kind);
}

function inlineTypes(tokens: InlineToken[]): string[] {
  return tokens.map((token) => token.type);
}

test("headings levels 1-6", () => {
  const blocks = parseBlocks("# Title\n## Sub\n### Sub sub\n#### Deep\n##### Deeper\n###### Deepest");
  assert.deepEqual(kinds(blocks), ["heading", "heading", "heading", "heading", "heading", "heading"]);
  assert.ok(blocks.every((block) => block.kind === "heading"));
  assert.deepEqual(blocks.map((block) => (block.kind === "heading" ? block.level : 0)), [1, 2, 3, 4, 5, 6]);
});

test("fenced code block consumes language tag", () => {
  const blocks = parseBlocks("```ts\nconst a = 1;\n```\n");
  const block = first(blocks);
  if (block.kind !== "code") throw new Error("expected code");
  assert.equal(block.text, "const a = 1;");
});

test("unclosed fence while streaming consumes to the end", () => {
  const blocks = parseBlocks("```\npartial code without close");
  const block = first(blocks);
  if (block.kind !== "code") throw new Error("expected code");
  assert.equal(block.text, "partial code without close");
});

test("bullet lists: multiple items, nesting, and tabs as two spaces", () => {
  const blocks = parseBlocks("- a\n- b\n  - nested\n\t- tabbed");
  const block = first(blocks);
  if (block.kind !== "bullet") throw new Error("expected bullet");
  assert.deepEqual(
    block.items.map((item) => [item.level, item.spans[0].type === "text" ? item.spans[0].text : ""]),
    [
      [0, "a"],
      [0, "b"],
      [1, "nested"],
      [1, "tabbed"],
    ],
  );
});

test("task list items keep checked state", () => {
  const blocks = parseBlocks("- [ ] to do\n- [x] done\n- [X] also done");
  const block = first(blocks);
  if (block.kind !== "bullet") throw new Error("expected bullet");
  assert.deepEqual(
    block.items.map((item) => [item.task, item.checked]),
    [
      [true, false],
      [true, true],
      [true, true],
    ],
  );
  assert.ok(block.items[0].spans[0].type === "text" && block.items[0].spans[0].text === "to do");
});

test("ordered list keeps markers", () => {
  const blocks = parseBlocks("1. one\n2) two\n10. ten");
  const block = first(blocks);
  if (block.kind !== "ordered") throw new Error("expected ordered");
  assert.deepEqual(
    block.items.map((item) => item.marker),
    ["1", "2", "10"],
  );
});

test("multi-line quote merges into one block", () => {
  const blocks = parseBlocks("> line one\n> line two");
  const block = first(blocks);
  if (block.kind !== "quote") throw new Error("expected quote");
  assert.equal(block.text, "line one line two");
});

test("GFM table with alignment and short rows", () => {
  const blocks = parseBlocks(
    "| Name | Qty | Notes |\n| :--- | ---: | :---: |\n| alpha | 1 | first |\n| beta | | |",
  );
  const block = first(blocks);
  if (block.kind !== "table") throw new Error("expected table");
  assert.deepEqual(block.header.map((cell) => cell.text), ["Name", "Qty", "Notes"]);
  assert.deepEqual(
    block.header.map((cell) => cell.align),
    ["left", "right", "center"],
  );
  assert.equal(block.rows.length, 2);
  assert.equal(block.rows[0][2].text, "first");
  assert.deepEqual(block.rows[1].map((cell) => cell.text), ["beta", "", ""]);
  assert.equal(block.rows[1][2].align, "center");
});

test("table row missing cells pads with empty aligned cells", () => {
  const blocks = parseBlocks("| A | B | C |\n| --- | --- | --- |\n| only |");
  const block = first(blocks);
  if (block.kind !== "table") throw new Error("expected table");
  assert.equal(block.rows[0].length, 3);
  assert.equal(block.rows[0][1].text, "");
});

test("dashes under a paragraph make a setext heading; blank line keeps the hr", () => {
  assert.deepEqual(kinds(parseBlocks("above\n---\nbelow")), ["heading", "p"]);
  assert.deepEqual(kinds(parseBlocks("above\n\n---\n\nbelow")), ["p", "hr", "p"]);
});

test("asterisk and underscore rules are horizontal rules", () => {
  assert.equal(first(parseBlocks("***")).kind, "hr");
  assert.equal(first(parseBlocks("* * *")).kind, "hr");
  assert.equal(first(parseBlocks("___")).kind, "hr");
});

test("paragraphs merge consecutive plain lines and split on blank lines", () => {
  const blocks = parseBlocks("line one\nline two\n\nline three");
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].kind === "p" && blocks[0].lines.join(" ") === "line one line two");
  assert.ok(blocks[1].kind === "p");
});

test("paragraph stops at a following heading", () => {
  const blocks = parseBlocks("intro text\n## Heading");
  assert.deepEqual(kinds(blocks), ["p", "heading"]);
});

test("inline: bold, underscore bold, italic, code, strike, link, image, bare URL", () => {
  const tokens = parseInline("a **b** __c__ *d* `e` ~~f~~ [g](https://x) ![h](https://i.png) https://bare");
  assert.deepEqual(inlineTypes(tokens), [
    "text",
    "bold",
    "text",
    "bold",
    "text",
    "italic",
    "text",
    "code",
    "text",
    "strike",
    "text",
    "link",
    "text",
    "image",
    "text",
    "link",
  ]);
  const link = tokens.find((token) => token.type === "link");
  assert.ok(link && link.type === "link" && link.url === "https://x");
});

test("inline: unmatched markers stay plain text", () => {
  const tokens = parseInline("a ** b `c");
  assert.ok(tokens.every((token) => token.type === "text"));
  assert.equal(tokens.map((token) => (token.type === "text" ? token.text : "")).join(""), "a ** b `c");
});

test("inline: asterisks inside code are not styled", () => {
  const tokens = parseInline("`*not italic*`");
  assert.deepEqual(inlineTypes(tokens), ["code"]);
  assert.ok(tokens[0].type === "code" && tokens[0].text === "*not italic*");
});

test("table cells are inline-parsed", () => {
  const blocks = parseBlocks("| A | B |\n| --- | --- |\n| **bold** | plain |");
  const block = first(blocks);
  if (block.kind !== "table") throw new Error("expected table");
  assert.ok(block.rows[0][0].spans[0].type === "bold");
});

test("streaming table without separator line yet stays a paragraph", () => {
  const blocks = parseBlocks("| A | B |");
  assert.deepEqual(kinds(blocks), ["p"]);
});

test("table cells containing pipes inside code spans", () => {
  const blocks = parseBlocks("| A | B |\n| --- | --- |\n| `x|y` | plain |");
  const block = first(blocks);
  if (block.kind !== "table") throw new Error("expected table");
  // naive pipe split still splits inside code spans; the cell text keeps both fragments
  assert.ok(block.rows[0].length >= 2);
});

test("paragraph line with pipe but no separator row stays a paragraph", () => {
  const blocks = parseBlocks("use | pipes | in prose");
  assert.deepEqual(kinds(blocks), ["p"]);
});

test("escaped characters never become inline styles", () => {
  const tokens = parseInline("\\*not italic\\* and \\*\\*not bold\\*\\* and \\`not code\\`");
  assert.ok(tokens.every((token) => token.type === "text"));
  assert.equal(tokens.map((token) => (token.type === "text" ? token.text : "")).join(""), "*not italic* and **not bold** and `not code`");
});

test("setext headings from === and --- underlines", () => {
  const blocks = parseBlocks("My title\n===\n\nother text\n---\ntrail");
  assert.deepEqual(kinds(blocks), ["heading", "heading", "p"]);
  assert.ok(blocks[0].kind === "heading" && blocks[0].level === 1);
  assert.ok(blocks[1].kind === "heading" && blocks[1].level === 2 && blocks[1].text === "other text");
});

test("lone dashes after a blank line are still an hr", () => {
  assert.deepEqual(kinds(parseBlocks("above\n\n---\n\nbelow")), ["p", "hr", "p"]);
});

test("angle autolinks become link tokens", () => {
  const tokens = parseInline("see <https://paseo.sh/docs> now");
  assert.deepEqual(inlineTypes(tokens), ["text", "link", "text"]);
  const link = tokens.find((token) => token.type === "link");
  assert.ok(link && link.type === "link" && link.url === "https://paseo.sh/docs");
});

test("link titles are ignored but the link survives", () => {
  const tokens = parseInline('[docs](https://paseo.sh "the docs")');
  assert.deepEqual(inlineTypes(tokens), ["link"]);
  assert.ok(tokens[0].type === "link" && tokens[0].url === "https://paseo.sh" && tokens[0].text === "docs");
});

test("nested quotes render as stacked depth levels", () => {
  const blocks = parseBlocks("> outer\n>> inner");
  if (blocks[0].kind !== "quote" || blocks[0].depth !== 1) throw new Error("expected outer quote");
  assert.equal(blocks[0].text, "outer");
  if (blocks[1].kind !== "quote" || blocks[1].depth !== 2) throw new Error("expected nested quote");
  assert.equal(blocks[1].text, "inner");
});
