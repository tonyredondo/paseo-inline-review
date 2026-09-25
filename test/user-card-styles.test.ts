import assert from "node:assert/strict";
import { test } from "node:test";

import {
  releaseUserCardStyles,
  retainUserCardStyles,
} from "../client/user-card-styles.ts";

type FakeStyle = {
  dataset: Record<string, string>;
  parentElement: FakeHead | null;
  textContent: string;
  remove(): void;
};

type FakeHead = {
  children: FakeStyle[];
  appendChild(style: FakeStyle): void;
};

function fakeDocument() {
  const head: FakeHead = {
    children: [],
    appendChild(style) {
      style.parentElement = this;
      this.children.push(style);
    },
  };
  return {
    head,
    createElement(): FakeStyle {
      return {
        dataset: {},
        parentElement: null,
        textContent: "",
        remove() {
          const index = head.children.indexOf(this);
          if (index >= 0) head.children.splice(index, 1);
          this.parentElement = null;
        },
      };
    },
  };
}

test("user cards do not depend on timeline ownership or widening", () => {
  const document = fakeDocument();
  const host = { document };

  const first = retainUserCardStyles(host);
  assert.equal(document.head.children.length, 1);
  assert.match(document.head.children[0].textContent, /\[data-testid="user-message"\]/);
  assert.match(document.head.children[0].textContent, /border-left-width:\s*5px\s*!important/);
  assert.match(document.head.children[0].textContent, /background-color:.*!important/);

  const second = retainUserCardStyles(host);
  assert.equal(document.head.children.length, 1, "independent daemon bundles share one stylesheet");

  releaseUserCardStyles(first, host);
  assert.equal(document.head.children.length, 1, "one daemon cannot remove another daemon's cards");
  releaseUserCardStyles(second, host);
  assert.equal(document.head.children.length, 0);
});
