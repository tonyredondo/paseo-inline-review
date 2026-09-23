import assert from "node:assert/strict";
import test from "node:test";

import { createFinalCardHoverStore } from "../client/final-card-hover.ts";

test("hover stays visible while the pointer crosses slices of one final card", () => {
  type Pending = { callback: () => void; cancelled: boolean };
  const pending: Pending[] = [];
  const store = createFinalCardHoverStore(
    (callback) => {
      const timer = { callback, cancelled: false };
      pending.push(timer);
      return timer;
    },
    (timer) => {
      (timer as Pending).cancelled = true;
    },
  );
  let notifications = 0;
  const unsubscribe = store.subscribe("agent:message", () => { notifications += 1; });

  store.show("agent:message");
  assert.equal(store.isHovered("agent:message"), true);
  assert.equal(notifications, 1);

  store.hide("agent:message");
  assert.equal(store.isHovered("agent:message"), true, "leaving one slice must not hide immediately");
  store.show("agent:message");
  pending[0]?.callback();
  assert.equal(store.isHovered("agent:message"), true, "entering the next slice cancels the pending hide");
  assert.equal(notifications, 1, "crossing slices does not rerender the controls");

  store.hide("agent:message");
  pending[1]?.callback();
  assert.equal(store.isHovered("agent:message"), false);
  assert.equal(notifications, 2);

  unsubscribe();
});

test("different final cards never share hover state", () => {
  const store = createFinalCardHoverStore();
  store.show("agent:first");
  assert.equal(store.isHovered("agent:first"), true);
  assert.equal(store.isHovered("agent:second"), false);
});
