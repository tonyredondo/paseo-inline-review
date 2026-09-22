import assert from "node:assert/strict";
import { test } from "node:test";

import { createAdaptiveSweep } from "../client/adaptive-sweep.ts";

test("adaptive sweeps back off, wake after activity, and stop cleanly", () => {
  const callbacks: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  let runs = 0;
  const sweep = createAdaptiveSweep({
    run() { runs += 1; },
    minimumMs: 10,
    maximumMs: 40,
    schedule(callback, delay) {
      callbacks.push({ callback, delay, cancelled: false });
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel(timer) {
      callbacks[Number(timer) - 1].cancelled = true;
    },
  });
  sweep.start();
  assert.equal(callbacks[0].delay, 10);
  callbacks[0].callback();
  assert.equal(runs, 1);
  assert.equal(callbacks[1].delay, 20);
  callbacks[1].callback();
  assert.equal(callbacks[2].delay, 40);
  sweep.wake();
  assert.equal(callbacks[2].cancelled, true);
  assert.equal(callbacks[3].delay, 10);
  sweep.stop();
  assert.equal(callbacks[3].cancelled, true);
  callbacks[3].callback();
  assert.equal(runs, 2);
});
