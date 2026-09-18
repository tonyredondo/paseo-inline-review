/**
 * Render-contract tests. The plugin code blocks render with React Native at
 * runtime (not unit-testable in Node), so these tests pin the CONTRACTS in the
 * renderer source that keep regressing: explicit monospace on every code token
 * (nested react-native-web Texts do not inherit fontFamily), no-wrap code with
 * horizontal scroll, and the solid black code background.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as path from "node:path";
const rendererSource = String(readFileSync(path.resolve("client/markdown.tsx"), "utf8"));

test("every code token Text carries the monospace family explicitly", () => {
  // react-native-web nested Texts do NOT inherit fontFamily: each token must
  // set it or the code block silently renders proportional again.
  assert.match(rendererSource, /<Text key=\{tokenIndex\} style=\{\[mono, \{ color: darkPalette/);
  assert.match(rendererSource, /\[\s*mono,\s*nowrap,/);
});

test("code blocks scroll horizontally and never wrap", () => {
  assert.match(rendererSource, /<ScrollView horizontal showsHorizontalScrollIndicator>/);
  assert.match(rendererSource, /flexDirection: "row"/);
  assert.match(rendererSource, /whiteSpace: "pre"/);
});

test("code blocks render on a solid black background with the custom palette", () => {
  assert.match(rendererSource, /backgroundColor: "#000000"/);
  assert.match(rendererSource, /const darkPalette = \{/);
  for (const token of ["plain", "keyword", "string", "comment", "number", "function", "type", "added", "removed", "meta"]) {
    assert.match(rendererSource, new RegExp(token + ": \"#"));
  }
});

test("inline code chips keep accent color, padding and monospace", () => {
  // the inline code case must include the monospace stack and surface2 chip
  const codeCase = String(rendererSource).slice(
    rendererSource.indexOf('case "code"'),
    rendererSource.indexOf('case "break"'),
  );
  assert.match(codeCase, /monospaceFont\(\)/);
  assert.match(codeCase, /paddingHorizontal: 5/);
  assert.match(codeCase, /theme\.colors\.accent/);
});

test("paragraph pressables never register onLongPress (native selection stays native)", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.ok(!timelineSource.includes("onLongPress"));
});

test("native paragraphs are selectable and double-tap driven (no Pressable wrapper)", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  // The native branch renders without a Pressable (a Pressable cancels the
  // platform selection on long-press) and wires the double-tap handler.
  assert.ok(timelineSource.includes('layout.platform === "web"'));
  assert.ok(timelineSource.includes("onChunkPress"));
  assert.ok(timelineSource.includes("selectable"));
  assert.ok(timelineSource.includes("handleChunkTap"));
});

test("the vendored UITextView is loaded lazily, never at bundle load", () => {
  // codegenNativeComponent only exists on native builds; a static import of
  // the vendored module crashes the whole plugin entry on web/Android.
  const spanSource = String(readFileSync(path.resolve("client/markdown-span.tsx")));
  assert.ok(!spanSource.includes('import { UITextView } from "./vendor/uitextview/Text.js"'));
  assert.match(spanSource, /import\("\.\/vendor\/uitextview\/Text\.js"\)/);
  assert.match(spanSource, /cachedUITextView/);
});
