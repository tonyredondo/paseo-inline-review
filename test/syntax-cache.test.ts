import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearSyntaxScannerCache,
  highlightCode,
  syntaxScannerCacheDiagnostics,
} from "../shared/syntax.ts";

test("syntax scanners unpack once per canonical language and stay bounded", () => {
  clearSyntaxScannerCache();
  assert.deepEqual(syntaxScannerCacheDiagnostics(), {
    entries: 0,
    builds: 0,
    languages: [],
  });

  highlightCode("opaque text", "not-a-language");
  highlightCode("+added", "diff");
  assert.equal(syntaxScannerCacheDiagnostics().entries, 0);

  highlightCode("package main", "go");
  highlightCode("func main() {}", "golang");
  assert.deepEqual(syntaxScannerCacheDiagnostics(), {
    entries: 1,
    builds: 1,
    languages: ["go"],
  });

  highlightCode("const value: string = 'x';", "typescript");
  highlightCode("let other = 1;", "js");
  assert.deepEqual(syntaxScannerCacheDiagnostics(), {
    entries: 2,
    builds: 2,
    languages: ["go", "js"],
  });
});

test("cached templates never leak mutable HTML scanner state", () => {
  clearSyntaxScannerCache();
  const expected = highlightCode("<div class=\"one\">text</div>", "html");
  highlightCode("<span", "html");
  assert.deepEqual(highlightCode("<div class=\"one\">text</div>", "html"), expected);
  assert.deepEqual(syntaxScannerCacheDiagnostics(), {
    entries: 1,
    builds: 1,
    languages: ["html"],
  });
});
