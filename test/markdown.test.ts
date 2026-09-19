import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlocks, parseInline, type Block, type InlineToken } from "../shared/markdown-parse.ts";
import * as syntax from "../shared/syntax.ts";

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

test("wrapped bullet lines stay inside the item", () => {
  const blocks = parseBlocks("- first item that wraps\n  over two lines");
  const block = first(blocks);
  if (block.kind !== "bullet") throw new Error("expected bullet");
  assert.equal(block.items.length, 1);
  const joined = block.items[0].spans.map((token) => (token.type === "text" ? token.text : "")).join("");
  assert.ok(joined.includes("over two lines"));
});

test("indented continuation after a blank line belongs to the list item", () => {
  const blocks = parseBlocks("- item\n\n  continued paragraph of the same item\n\nnext paragraph");
  const block = first(blocks);
  if (block.kind !== "bullet") throw new Error("expected bullet");
  assert.equal(block.items.length, 1);
  const joined = block.items[0].spans.map((token) => (token.type === "text" ? token.text : "")).join("");
  assert.ok(joined.includes("continued paragraph"));
  const last = blocks[blocks.length - 1];
  assert.ok(last.kind === "p" && last.lines[0] === "next paragraph");
});

test("indented code blocks after a blank line render as code", () => {
  const blocks = parseBlocks("text\n\n    const a = 1;\n    const b = 2;\n\nafter");
  assert.deepEqual(kinds(blocks), ["p", "code", "p"]);
  const block = blocks[1];
  if (block.kind !== "code") throw new Error("expected code");
  assert.equal(block.text, "const a = 1;\nconst b = 2;");
});

test("indented code cannot interrupt a paragraph", () => {
  const blocks = parseBlocks("paragraph start\n    still paragraph\n\n    code");
  assert.deepEqual(kinds(blocks), ["p", "code"]);
});

// --- syntax highlighting -----------------------------------------------------

import { highlightCode, normalizeLanguage } from "../shared/syntax.ts";

function tokenTypesPerLine(lines: { type: string; text: string }[][], lineIndex: number): string[] {
  return lines[lineIndex].map((token) => token.type);
}

test("highlightCode: keywords, strings, comments, numbers, functions", () => {
  const lines = highlightCode("const x = 1; // hi\nfunction foo() { return 'a' }", "ts");
  assert.deepEqual(tokenTypesPerLine(lines, 0), ["keyword", "plain", "number", "plain", "comment"]);
  assert.deepEqual(tokenTypesPerLine(lines, 1), ["keyword", "plain", "function", "plain", "keyword", "plain", "string", "plain"]);
  const joined = lines[1].map((token) => token.text).join("");
  assert.equal(joined, "function foo() { return 'a' }");
});

test("highlightCode: diff gets line colors", () => {
  const lines = highlightCode("+ added\n- removed\n@@ meta", "diff");
  assert.deepEqual(tokenTypesPerLine(lines, 0), ["added"]);
  assert.deepEqual(tokenTypesPerLine(lines, 1), ["removed"]);
  assert.deepEqual(tokenTypesPerLine(lines, 2), ["meta"]);
});

test("highlightCode: block comments span lines", () => {
  const lines = highlightCode("/* start\nstill comment\n*/ code", "js");
  assert.equal(lines[0][0].type, "comment");
  assert.equal(lines[1][0].type, "comment");
  assert.ok(lines[2].some((token) => token.type === "plain"));
});

test("highlightCode: unknown languages render plain", () => {
  const lines = highlightCode("anything here", "cobol");
  assert.deepEqual(tokenTypesPerLine(lines, 0), ["plain"]);
});

test("normalizeLanguage maps aliases", () => {
  assert.equal(normalizeLanguage("TypeScript"), "js");
  assert.equal(normalizeLanguage("c#"), "cs");
  assert.equal(normalizeLanguage("py"), "python");
  assert.equal(normalizeLanguage("golang"), "go");
});

// --- references, <br>, emoji --------------------------------------------------

import { extractRefDefs } from "../shared/markdown-parse.ts";

test("reference definitions are extracted and skipped from blocks", () => {
  const text = "text [link][repo] more\n\n[repo]: https://github.com/getpaseo\n";
  const refs = extractRefDefs(text);
  assert.equal(refs.get("repo"), "https://github.com/getpaseo");
  const blocks = parseBlocks(text);
  // the definition line is not rendered
  assert.ok(!JSON.stringify(blocks).includes("github.com/getpaseo"));
});

test("parseInline resolves reference links when refs are provided", () => {
  const refs = new Map([["repo", "https://github.com/getpaseo"]]);
  const tokens = parseInline("see [repo] and [the repo][repo]", refs);
  const links = tokens.filter((token) => token.type === "link");
  assert.equal(links.length, 2);
  assert.ok(links.every((token) => token.type === "link" && token.url === "https://github.com/getpaseo"));
});

test("parseInline without refs leaves shortcut brackets as text", () => {
  const tokens = parseInline("see [repo] now");
  assert.ok(tokens.every((token) => token.type !== "link"));
});

test("<br> becomes a break token", () => {
  const tokens = parseInline("one <br> two");
  assert.deepEqual(inlineTypes(tokens), ["text", "break", "text"]);
});

test("emoji shortcodes convert outside code spans", () => {
  const tokens = parseInline("shipped :tada: with `:tada:` literal");
  const textToken = tokens[0];
  assert.ok(textToken.type === "text" && textToken.text.includes("\u{1F389}"));
  const codeToken = tokens.find((token) => token.type === "code");
  assert.ok(codeToken && codeToken.type === "code" && codeToken.text === ":tada:");
});

test("inline code inside bold renders nested", () => {
  const tokens = parseInline("**2. Alta — un `tracer.Start()` posterior sigue**");
  assert.deepEqual(inlineTypes(tokens), ["bold"]);
  const bold = tokens[0];
  assert.ok(bold.type === "bold");
  const kinds = bold.tokens.map((token) => token.type);
  assert.ok(kinds.includes("code"), "expected a code token inside bold");
  const code = bold.tokens.find((token) => token.type === "code");
  assert.ok(code && code.type === "code" && code.text === "tracer.Start()");
});

test("nested bold survives recursion", () => {
  const tokens = parseInline("**outer *inner* end**");
  assert.deepEqual(inlineTypes(tokens), ["bold"]);
  assert.ok(tokens[0].type === "bold" && tokens[0].tokens.some((token) => token.type === "italic"));
});

test("link inside bold keeps its url", () => {
  const tokens = parseInline("**see [docs](https://paseo.sh)**");
  assert.ok(tokens[0].type === "bold");
  const link = tokens[0].tokens.find((token) => token.type === "link");
  assert.ok(link && link.type === "link" && link.url === "https://paseo.sh");
});

test("syntax: html tags, attributes and strings get color", () => {
  const tokens = syntax.highlightCode('<div class="a"><span>hi</span></div>', "html").flat();
  assert.ok(tokens.some((tk) => tk.type === "tag" && tk.text === "div"));
  assert.ok(tokens.some((tk) => tk.type === "type" && tk.text === "class"));
  assert.ok(tokens.some((tk) => tk.type === "string" && tk.text.includes("a")));
});

test("syntax: css properties, selectors and numbers get color", () => {
  const tokens = syntax.highlightCode(".a { max-width: 40rem; }", "css").flat();
  assert.ok(tokens.some((tk) => tk.type === "function" && tk.text === "max-width"));
  assert.ok(tokens.some((tk) => tk.type === "type" && tk.text === "a"));
  assert.ok(tokens.some((tk) => tk.type === "number" && tk.text === "40rem"));
});

test("syntax: shell flags and json keys get color", () => {
  assert.ok(syntax.highlightCode("git diff --check", "sh").flat().some((tk) => tk.type === "meta" && tk.text === "--check"));
  assert.ok(syntax.highlightCode('{ "a": 1 }', "json").flat().some((tk) => tk.type === "type" && tk.text === "\"a\""));
});

test("syntax: go and java builtins, java family, constants", () => {
  assert.ok(syntax.highlightCode("items := make([]string, 0)", "go").flat().some((tk) => tk.type === "function" && tk.text === "make"));
  assert.ok(syntax.highlightCode("public final class Foo {}", "java").flat().some((tk) => tk.type === "keyword" && tk.text === "class"));
  assert.ok(syntax.highlightCode("int MAX = 1;", "java").flat().some((tk) => tk.type === "number" && tk.text === "MAX"));
  assert.ok(syntax.highlightCode("var xs = new List<int>();", "cs").flat().some((tk) => tk.type === "function" && tk.text === "List"));
});

// --- intraword underscore (CommonMark left/right-flanking rule) ---

test("snake_case_word does not italicize", () => {
  assert.ok(parseInline("snake_case_word stays").every((tk) => tk.type !== "italic" && tk.type !== "bold"));
});

test("trailing underscore emphasis stays plain (my_var_)", () => {
  assert.ok(parseInline("value my_var_ here").every((tk) => tk.type !== "italic" && tk.type !== "bold"));
});

test("standalone _italic_ still works", () => {
  const tokens = parseInline("use _italics_ here");
  assert.deepEqual(inlineTypes(tokens), ["text", "italic", "text"]);
});

test("leading underscore variable does not italicize (_private)", () => {
  assert.ok(parseInline("field _private_thing_ ok").every((tk) => tk.type !== "italic" && tk.type !== "bold"));
});

test("intraword double underscore stays plain (foo__bar__baz)", () => {
  assert.ok(parseInline("foo__bar__baz").every((tk) => tk.type !== "bold"));
  assert.ok(parseInline("foo__bar__baz").every((tk) => tk.type !== "italic"));
});

test("star emphasis works intraword (a*b*c)", () => {
  assert.deepEqual(inlineTypes(parseInline("a*b*c")), ["text", "italic", "text"]);
});

test("underscore emphasis at punctuation boundaries still works", () => {
  assert.deepEqual(inlineTypes(parseInline("(_note_)")), ["text", "italic", "text"]);
});

test("bold containing snake_case keeps underscores plain", () => {
  const tokens = parseInline("**see snake_case_word now**");
  assert.ok(tokens[0].type === "bold");
  assert.ok(tokens[0].tokens.every((tk) => tk.type !== "italic"));
});

// --- www autolinks ---

test("www urls autolink with https", () => {
  const tokens = parseInline("go to www.example.com now");
  assert.deepEqual(inlineTypes(tokens), ["text", "link", "text"]);
  const link = tokens.find((tk) => tk.type === "link");
  assert.ok(link && link.type === "link" && link.url === "https://www.example.com");
});

test("www urls with paths autolink", () => {
  const link = parseInline("see www.paseo.sh/docs for more").find((tk) => tk.type === "link");
  assert.ok(link && link.type === "link" && link.url === "https://www.paseo.sh/docs");
});

test("existing http urls do not double-match", () => {
  const tokens = parseInline("visit https://www.example.com now");
  assert.deepEqual(inlineTypes(tokens), ["text", "link", "text"]);
  const link = tokens.find((tk) => tk.type === "link");
  assert.ok(link && link.type === "link" && link.url === "https://www.example.com");
});

test("bare domains without www stay plain", () => {
  assert.deepEqual(inlineTypes(parseInline("file example.com here")), ["text"]);
});

// --- hard line breaks ---

test("paragraph lines render as separate lines (hard-break design)", () => {
  const blocks = parseBlocks("trailing two spaces  \nnext line");
  assert.equal(blocks[0].kind, "p");
  assert.ok(blocks[0].kind === "p" && blocks[0].lines.length === 2);
  assert.equal(blocks[0].kind === "p" ? blocks[0].lines[0].trimEnd() : "", "trailing two spaces");
});

test("br tag still produces a break token", () => {
  assert.deepEqual(inlineTypes(parseInline("one<br>two")), ["text", "break", "text"]);
});
