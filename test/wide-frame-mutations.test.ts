import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyWideFrameMutations } from "../client/wide-frame-mutations.ts";

type FakeNode = {
  parentElement: FakeNode | null;
  style?: Record<string, string>;
  dataset?: Record<string, string>;
  maxWidth?: string;
  markers?: FakeNode[];
  querySelectorAll?(selector: string): ArrayLike<FakeNode>;
};

function element(maxWidth = "none", markers: FakeNode[] = []): FakeNode {
  return {
    parentElement: null,
    style: {},
    dataset: {},
    maxWidth,
    markers,
    querySelectorAll: () => markers,
  };
}

const markerSelector = '[data-testid="inline-review-root"], [data-testid="user-message"]';
const classify = (mutations: Parameters<typeof classifyWideFrameMutations<FakeNode>>[0]["mutations"]) =>
  classifyWideFrameMutations<FakeNode>({
    mutations,
    markerSelector,
    getMaxWidth: (node) => node.maxWidth ?? "none",
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

test("new capped or marker-bearing subtrees schedule only their exact scopes", () => {
  const capped = element("820px");
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
