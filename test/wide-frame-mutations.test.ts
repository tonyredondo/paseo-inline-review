import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyWideFrameMutations,
  lowestCommonAncestor,
} from "../client/wide-frame-mutations.ts";

type FakeNode = {
  parentElement: FakeNode | null;
  style?: Record<string, string>;
  dataset?: Record<string, string>;
  maxWidth?: string;
  markers?: FakeNode[];
  marker?: boolean;
  matches?(selector: string): boolean;
  querySelectorAll?(selector: string): ArrayLike<FakeNode>;
};

function element(maxWidth = "none", markers: FakeNode[] = [], marker = false): FakeNode {
  return {
    parentElement: null,
    style: {},
    dataset: {},
    maxWidth,
    markers,
    marker,
    matches: () => marker,
    querySelectorAll: () => markers,
  };
}

const markerSelector = '[data-testid="inline-review-root"], [data-testid="user-message"]';
const classify = (mutations: Parameters<typeof classifyWideFrameMutations<FakeNode>>[0]["mutations"]) =>
  classifyWideFrameMutations<FakeNode>({
    mutations,
    markerSelector,
  });

test("unrelated additions schedule no timeline scan or style repair", () => {
  const unrelated = element();
  const result = classify([{ target: unrelated, addedNodes: [unrelated] }]);
  assert.equal(result.repairWidenedStyles, false);
  assert.deepEqual(result.scopes, []);
});

test("a host rewrite repairs widened styles without rescanning the document", () => {
  const widened = element();
  widened.dataset!.inlineReviewWide = "1";
  const result = classify([{ target: widened, attributeName: "style", addedNodes: [] }]);
  assert.equal(result.repairWidenedStyles, true);
  assert.deepEqual(result.scopes, []);
});

test("new known or marker-bearing subtrees schedule only their exact scopes", () => {
  const capped = element("820px");
  capped.dataset!.inlineReviewWide = "1";
  const marker = element();
  const subtree = element("none", [marker]);
  const duplicate = classify([
    { target: capped, addedNodes: [capped, capped] },
    { target: subtree, addedNodes: [subtree] },
  ]);
  assert.deepEqual(duplicate.scopes, [capped, subtree]);

  const textNode: FakeNode = { parentElement: capped };
  assert.deepEqual(classify([{ target: capped, addedNodes: [textNode] }]).scopes, [capped]);
});

test("a style rewrite inside a message repairs only that message subtree", () => {
  const message = element("none", [], true);
  const child = element();
  child.parentElement = message;

  const result = classify([{ target: child, attributeName: "style", addedNodes: [] }]);
  assert.equal(result.repairWidenedStyles, false);
  assert.deepEqual(result.scopes, [message]);
});

test("a marker added after insertion schedules its own card subtree", () => {
  const message = element("none", [], true);
  const result = classify([{
    target: message,
    attributeName: "data-testid",
    addedNodes: [],
  }]);
  assert.deepEqual(result.scopes, [message]);
});

test("lowestCommonAncestor finds the narrow shared timeline root", () => {
  const body = element();
  const timeline = element();
  const first = element();
  const second = element();
  timeline.parentElement = body;
  first.parentElement = timeline;
  second.parentElement = timeline;

  assert.equal(lowestCommonAncestor([first, second]), timeline);
  assert.equal(lowestCommonAncestor([first]), first);
  assert.equal(lowestCommonAncestor([]), null);
  assert.equal(lowestCommonAncestor([first, element()]), null);
});
