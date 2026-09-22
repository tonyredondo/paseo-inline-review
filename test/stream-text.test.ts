import assert from "node:assert/strict";
import { test } from "node:test";

import { createStreamingTextCoalescer } from "../client/stream-text.ts";

test("streaming text coalesces updates and publishes completion immediately", () => {
  const published: string[] = [];
  const scheduled: Array<() => void> = [];
  const cancelled = new Set<() => void>();
  const coalescer = createStreamingTextCoalescer({
    publish: (text) => published.push(text),
    schedule(callback) {
      scheduled.push(callback);
      return callback as unknown as ReturnType<typeof setTimeout>;
    },
    cancel(timer) { cancelled.add(timer as unknown as () => void); },
  });

  coalescer.update("a", false);
  coalescer.update("ab", false);
  coalescer.update("abc", false);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(published, []);
  scheduled[0]!();
  assert.deepEqual(published, ["abc"]);

  coalescer.update("abcd", false);
  coalescer.update("complete text", true);
  assert.deepEqual(published, ["abc", "complete text"]);
  assert.equal(cancelled.has(scheduled[1]!), true);

  coalescer.dispose();
  scheduled[1]!();
  coalescer.update("too late", true);
  assert.deepEqual(published, ["abc", "complete text"]);
});
