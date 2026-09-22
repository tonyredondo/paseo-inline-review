import assert from "node:assert/strict";
import { test } from "node:test";

import { createStableReferenceDefinitions } from "../client/markdown-stream.ts";
import { extractRefDefs } from "../shared/markdown-parse.ts";

test("streaming text reuses reference definitions until their semantics change", () => {
  const definitions = createStableReferenceDefinitions();
  const first = definitions.update("First paragraph.\n\n[guide]: https://example.com/one");
  const appended = definitions.update(
    "First paragraph.\n\nSecond paragraph.\n\n[guide]: https://example.com/one",
  );
  const changed = definitions.update(
    "First paragraph.\n\nSecond paragraph.\n\n[guide]: https://example.com/two",
  );

  assert.equal(appended, first);
  assert.notEqual(changed, first);
  assert.equal(changed.get("guide"), "https://example.com/two");
  const diagnostics = definitions.diagnostics();
  assert.equal(diagnostics.parses, 3);
  assert.equal(diagnostics.publications, 2);
  assert.equal(diagnostics.fullScans, 3);
});

test("reference definitions inside a streaming fence do not invalidate stable paragraphs", () => {
  const definitions = createStableReferenceDefinitions();
  const first = definitions.update("Before\n\n```md\n[guide]: https://ignored.example");
  const continued = definitions.update(
    "Before\n\n```md\n[guide]: https://ignored.example\nmore streamed code",
  );

  assert.equal(continued, first);
  assert.equal(continued.size, 0);
  const diagnostics = definitions.diagnostics();
  assert.equal(diagnostics.parses, 2);
  assert.equal(diagnostics.publications, 1);
  assert.equal(diagnostics.fullScans, 1);
});

test("append-only streaming scans new complete lines instead of the full message", () => {
  const definitions = createStableReferenceDefinitions();
  let text = "";
  let cumulativeCharacters = 0;
  for (let index = 0; index < 200; index += 1) {
    text += `ordinary streamed line ${index}\n`;
    cumulativeCharacters += text.length;
    definitions.update(text);
  }

  const diagnostics = definitions.diagnostics() as ReturnType<typeof definitions.diagnostics> & {
    inspectedCharacters?: number;
    fullScans?: number;
  };
  assert.equal(diagnostics.fullScans, 1);
  assert.ok((diagnostics.inspectedCharacters ?? Infinity) < cumulativeCharacters / 20);
});

test("non-append edits rebuild state without leaking stale references or fence state", () => {
  const definitions = createStableReferenceDefinitions();
  definitions.update("```md\n[hidden]: https://hidden.example\n");
  const replaced = definitions.update("[visible]: https://visible.example");
  assert.deepEqual([...replaced], [["visible", "https://visible.example"]]);
});

test("incremental reference scanning matches the canonical parser at every append boundary", () => {
  const definitions = createStableReferenceDefinitions();
  const complete = [
    "Intro text",
    "[one]: https://example.com/one",
    "````md",
    "[hidden]: https://example.com/hidden",
    "```",
    "````",
    "[ONE]: https://example.com/replaced",
    "[two]: <https://example.com/two>",
  ].join("\n");
  let streamed = "";
  for (const character of complete) {
    streamed += character;
    assert.deepEqual([...definitions.update(streamed)], [...extractRefDefs(streamed)]);
  }
});
