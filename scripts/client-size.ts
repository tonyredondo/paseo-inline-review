import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = [
  "client/plugin-entry.tsx",
  "client/wide-frame-lease.ts",
  "client/adaptive-sweep.ts",
  "client/comment-delta.ts",
  "client/comment-sync.ts",
  "client/file-download.ts",
  "client/image-preview-store.ts",
  "client/markdown-compile.ts",
  "client/markdown-stream.ts",
  "client/paragraph-stream.ts",
  "client/markdown-span.tsx",
  "client/markdown.tsx",
  "client/panel.tsx",
  "client/pills.tsx",
  "client/preview-store.ts",
  "client/review-store.ts",
  "client/stream-text.ts",
  "client/timeline.tsx",
  "client/turn-final-store.ts",
  "client/web.ts",
  "client/wide-frame-controller.tsx",
  "client/wide-frame-mutations.ts",
  "client/wide-frame-settings.tsx",
  "client/wide-frame.ts",
];

const parts = files.map((file) => ({ file, source: readFileSync(resolve(file), "utf8") }));
const baselineRawBytes = 216_783;
const baselineGzipBytes = 45_806;
const growthLimit = 1.1;
const forbidden = parts.flatMap(({ file, source }) => {
  const matches = source.match(/(?:from\s+|import\s*\()["'](?:node:|\.\.\/server\/|sharp)/g) ?? [];
  return matches.map((match) => ({ file, match }));
});
if (forbidden.length > 0) {
  process.stderr.write(`${JSON.stringify({ forbidden }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  const joined = parts.map(({ file, source }) => `// ${file}\n${source}`).join("\n");
  const generated = readFileSync(resolve("client/generated-entry.js"));
  const rawBytes = generated.byteLength;
  const gzipBytes = gzipSync(generated).byteLength;
  const rawGrowthPercent = ((rawBytes / baselineRawBytes) - 1) * 100;
  const gzipGrowthPercent = ((gzipBytes / baselineGzipBytes) - 1) * 100;
  process.stdout.write(`${JSON.stringify({
    kind: "client-prebundle-size",
    fileCount: files.length,
    sourceRawBytes: Buffer.byteLength(joined),
    sourceGzipBytes: gzipSync(joined).byteLength,
    rawBytes,
    gzipBytes,
    baselineRawBytes,
    baselineGzipBytes,
    rawGrowthPercent,
    gzipGrowthPercent,
    warningThresholdRawBytes: Math.floor(baselineRawBytes * growthLimit),
    warningThresholdGzipBytes: Math.floor(baselineGzipBytes * growthLimit),
    warning: rawGrowthPercent > 10 || gzipGrowthPercent > 10,
    analysis: "The generated minified entry is the transfer proxy; plugin reload plus size:installed is the authoritative Paseo boundary check.",
    forbiddenImports: 0,
  }, null, 2)}\n`);
}
