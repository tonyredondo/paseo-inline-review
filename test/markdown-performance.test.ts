import assert from "node:assert/strict";
import { test } from "node:test";

import { clearMarkdownCache, compileMarkdown, markdownCacheDiagnostics } from "../client/markdown-compile.ts";
import { codeHighlightWindow } from "../shared/code-window.ts";

test("a compiled document tokenizes an identical paragraph line once", () => {
  clearMarkdownCache();
  const document = compileMarkdown("same **line**\n\nsame **line**");
  const first = document.inline("same **line**");
  const second = document.inline("same **line**");
  assert.equal(second, first);
});

test("completed markdown cache hits by identity and text and invalidates changed text", () => {
  clearMarkdownCache();
  const first = compileMarkdown("hello", undefined, "message-1");
  const second = compileMarkdown("hello", undefined, "message-1");
  const changed = compileMarkdown("hello changed", undefined, "message-1");
  assert.equal(second, first);
  assert.notEqual(changed, first);
  assert.equal(markdownCacheDiagnostics().hits, 1);
  assert.equal(markdownCacheDiagnostics().misses, 2);
});

test("completed markdown cache evicts by total character budget", () => {
  clearMarkdownCache();
  compileMarkdown("a".repeat(1_200_000), undefined, "large-a");
  compileMarkdown("b".repeat(1_200_000), undefined, "large-b");
  const diagnostics = markdownCacheDiagnostics();
  assert.ok(diagnostics.cachedCharacters <= 2_000_000);
  assert.equal(diagnostics.entries, 1);
});

test("collapsed code highlights only its visible prefix", () => {
  const code = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const collapsed = codeHighlightWindow(code, false, 40);
  assert.equal(collapsed.collapsed, true);
  assert.equal(collapsed.visibleLines, 40);
  assert.equal(collapsed.code.split("\n").length, 40);
  const expanded = codeHighlightWindow(code, true, 40);
  assert.equal(expanded.collapsed, false);
  assert.equal(expanded.code, code);
});
