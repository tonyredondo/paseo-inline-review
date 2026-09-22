import assert from "node:assert/strict";
import { test } from "node:test";

import { downloadLocalFileProgressively } from "../client/file-download.ts";

function chunk(value: string): string {
  return Buffer.from(value).toString("base64");
}

test("progressive downloads preserve source and destination order", async () => {
  const sourceOffsets: number[] = [];
  const writes: string[] = [];
  const progress: Array<number | null> = [];
  let closed = 0;
  let aborted = 0;

  const size = await downloadLocalFileProgressively({
    path: "/tmp/example.bin",
    chunkBytes: 3,
    onProgress: (value) => progress.push(value),
    openFile: async ({ offset, fileVersion }) => {
      sourceOffsets.push(offset);
      assert.equal(fileVersion, offset === 0 ? undefined : "version-1");
      return offset === 0
        ? { ok: true, base64: chunk("abc"), size: 6, fileVersion: "version-1", done: false }
        : { ok: true, base64: chunk("def"), size: 6, fileVersion: "version-1", done: true };
    },
    openDestination: async (fileName) => {
      assert.equal(fileName, "example.bin");
      return {
        async writeBase64(value) {
          const decoded = Buffer.from(value, "base64");
          writes.push(decoded.toString());
          return decoded.byteLength;
        },
        async close() { closed += 1; },
        async abort() { aborted += 1; },
      };
    },
  });

  assert.equal(size, 6);
  assert.deepEqual(sourceOffsets, [0, 3]);
  assert.deepEqual(writes, ["abc", "def"]);
  assert.deepEqual(progress, [0.5, 1, null]);
  assert.equal(closed, 1);
  assert.equal(aborted, 0);
});

test("a failed source chunk aborts the destination without closing it", async () => {
  const sourceOffsets: number[] = [];
  const writes: string[] = [];
  let closed = 0;
  let aborted = 0;

  await assert.rejects(
    downloadLocalFileProgressively({
      path: "C:\\tmp\\example.bin",
      chunkBytes: 3,
      openFile: async ({ offset }) => {
        sourceOffsets.push(offset);
        return offset === 0
          ? { ok: true, base64: chunk("abc"), size: 6, fileVersion: "version-1", done: false }
          : { ok: false, error: "source changed" };
      },
      openDestination: async (fileName) => {
        assert.equal(fileName, "example.bin");
        return {
          async writeBase64(value) {
            const decoded = Buffer.from(value, "base64");
            writes.push(decoded.toString());
            return decoded.byteLength;
          },
          async close() { closed += 1; },
          async abort() { aborted += 1; },
        };
      },
    }),
    /source changed/,
  );

  assert.deepEqual(sourceOffsets, [0, 3]);
  assert.deepEqual(writes, ["abc"]);
  assert.equal(closed, 0);
  assert.equal(aborted, 1);
});
