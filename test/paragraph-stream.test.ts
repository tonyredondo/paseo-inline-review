import assert from "node:assert/strict";
import { test } from "node:test";

import { createStableParagraphs } from "../client/paragraph-stream.ts";
import { splitParagraphs } from "../shared/review.ts";

test("incremental paragraphs match the canonical splitter at every append boundary", () => {
  const paragraphs = createStableParagraphs();
  const complete = [
    "Intro text",
    "",
    "````md",
    "A fenced paragraph",
    "",
    "```",
    "````",
    "",
    "- first item",
    "  continued line",
    "- second item",
    "",
    "1. ordered item",
    "",
    "Final paragraph",
  ].join("\n");
  let streamed = "";
  for (const character of complete) {
    streamed += character;
    assert.deepEqual(paragraphs.update(streamed), splitParagraphs(streamed));
  }
});

test("non-append edits rebuild paragraph and fence state", () => {
  const paragraphs = createStableParagraphs();
  paragraphs.update("intro\n\n```md\nopen\n\nstill open");
  const replaced = "replacement\n\nsecond";
  assert.deepEqual(paragraphs.update(replaced), splitParagraphs(replaced));
  assert.equal(paragraphs.diagnostics().fullRebuilds, 2);
});

test("append-only paragraphs inspect new lines instead of the full message", () => {
  const paragraphs = createStableParagraphs();
  let text = "";
  let cumulativeCharacters = 0;
  for (let index = 0; index < 200; index += 1) {
    text += `paragraph ${index}\n\n`;
    cumulativeCharacters += text.length;
    paragraphs.update(text);
  }

  const diagnostics = paragraphs.diagnostics();
  assert.equal(diagnostics.fullRebuilds, 1);
  assert.ok(diagnostics.inspectedCharacters < cumulativeCharacters / 20);
  assert.ok(diagnostics.materializedCharacters < cumulativeCharacters / 20);
});

test("an unchanged snapshot reuses its paragraph array", () => {
  const paragraphs = createStableParagraphs();
  const first = paragraphs.update("one\n\ntwo");
  assert.equal(paragraphs.update("one\n\ntwo"), first);
});
