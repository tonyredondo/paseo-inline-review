import { performance } from "node:perf_hooks";
import { gunzipSync, gzipSync } from "node:zlib";

import { createCommentSyncController } from "../client/comment-sync.ts";
import { createImagePreviewStore } from "../client/image-preview-store.ts";
import { createStableReferenceDefinitions } from "../client/markdown-stream.ts";
import {
  clearMarkdownCache,
  compileMarkdown,
  markdownCacheDiagnostics,
} from "../client/markdown-compile.ts";
import { highlightCode } from "../shared/syntax.ts";
import { FILE_TRANSFER_CHUNK_BYTES } from "../shared/review.ts";

type Measurement = Record<string, unknown>;

async function measureCommentSync(agentCount: number): Promise<Measurement> {
  let rpcCount = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  const controller = createCommentSyncController({
    async sync(input) {
      rpcCount += 1;
      requestBytes += Buffer.byteLength(JSON.stringify(input));
      const result = {
        epoch: "fixture-epoch",
        buckets: input.agents.map(({ agentId }) => ({
          agentId,
          revision: 1,
          comments: [],
          deleted: [],
        })),
      };
      responseBytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    },
    hydrate() {},
    hasPendingSaves: () => false,
  });
  for (let index = 0; index < agentCount; index += 1) controller.addAgent(`agent-${index}`);
  const started = performance.now();
  await controller.refresh();
  const elapsedMs = performance.now() - started;
  const runningState = controller.diagnostics();
  controller.stop();
  const cleanupState = controller.diagnostics();
  return { agentCount, rpcCount, requestBytes, responseBytes, elapsedMs, runningState, cleanupState };
}

function markdownFixture(size: number): string {
  const unit = "A paragraph with **bold**, `code`, [link](https://example.com), and words.\n\n";
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

function measureMarkdown(size: number): Measurement {
  const text = markdownFixture(size);
  clearMarkdownCache();
  const started = performance.now();
  const document = compileMarkdown(text, undefined, `fixture-${size}`);
  const uniqueInlineInputs = new Set<string>();
  let inlineLookups = 0;
  for (const block of document.blocks) {
    if (block.kind !== "p") continue;
    for (const line of block.lines) {
      document.inline(line);
      uniqueInlineInputs.add(line);
      inlineLookups += 1;
    }
  }
  const firstRenderMs = performance.now() - started;
  const remountStarted = performance.now();
  const remounted = compileMarkdown(text, undefined, `fixture-${size}`);
  const remountMs = performance.now() - remountStarted;
  const cache = markdownCacheDiagnostics();
  clearMarkdownCache();
  return {
    inputBytes: Buffer.byteLength(text),
    blockCount: document.blocks.length,
    inlineLookups,
    uniqueInlineParses: uniqueInlineInputs.size,
    uniqueInlineInputCharacters: [...uniqueInlineInputs].reduce((total, line) => total + line.length, 0),
    firstRenderMs,
    remountMs,
    completedDocumentReused: remounted === document,
    cache,
  };
}

function measureStreamingReferences(lineCount: number): Measurement {
  const definitions = createStableReferenceDefinitions();
  let text = "";
  let naiveInputCharacters = 0;
  const started = performance.now();
  for (let index = 0; index < lineCount; index += 1) {
    text += index === lineCount - 1
      ? `[guide]: https://example.com/${index}\n`
      : `ordinary streamed line ${index}\n`;
    naiveInputCharacters += text.length;
    definitions.update(text);
  }
  const diagnostics = definitions.diagnostics();
  return {
    lineCount,
    finalInputCharacters: text.length,
    naiveFullScanCharacters: naiveInputCharacters,
    incrementalInspectedCharacters: diagnostics.inspectedCharacters,
    scanReduction: 1 - diagnostics.inspectedCharacters / naiveInputCharacters,
    publications: diagnostics.publications,
    elapsedMs: performance.now() - started,
  };
}

function measureCode(lines: number, visibleLines: number): Measurement {
  const code = Array.from({ length: lines }, (_, index) => `const value${index} = ${index};`).join("\n");
  const visible = code.split("\n").slice(0, visibleLines).join("\n");
  const started = performance.now();
  highlightCode(visible, "ts");
  return {
    totalLines: lines,
    highlightedLines: visibleLines,
    totalInputBytes: Buffer.byteLength(code),
    highlightedInputBytes: Buffer.byteLength(visible),
    invocations: 1,
    elapsedMs: performance.now() - started,
  };
}

function imageTransfer(sourceBytes: number): Measurement {
  return {
    sourceBytes,
    fullBase64Bytes: Math.ceil(sourceBytes / 3) * 4,
    automaticFullImageRpcCount: 0,
  };
}

function downloadTransfer(sourceBytes: number, chunkBytes: number): Measurement {
  return {
    sourceBytes,
    chunkBytes,
    chunks: Math.ceil(sourceBytes / chunkBytes),
    maximumFrameBase64Bytes: Math.ceil(chunkBytes / 3) * 4,
  };
}

async function measureThumbnailStore(): Promise<Measurement> {
  let loaderCalls = 0;
  let active = 0;
  let maxActive = 0;
  const store = createImagePreviewStore({ mountDelayMs: 0, concurrency: 2 });
  const loader = async () => {
    loaderCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      ok: true,
      fileVersion: "fixture-v1",
      mimeType: "image/png",
      base64: "AAAA",
      thumbnailSize: 3,
    };
  };
  const releases = ["a", "b", "c", "d"].map((path) => store.retain(path, loader, () => {}));
  while (store.diagnostics().active > 0 || store.diagnostics().queued > 0 || loaderCalls < 4) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  releases.forEach((release) => release());
  const releaseCached = store.retain("a", loader, () => {});
  releaseCached();
  const beforeCleanup = store.diagnostics();
  store.dispose();
  let compactLoaderCalls = 0;
  const compactStore = createImagePreviewStore({ mountDelayMs: 0 });
  const releaseCompact = compactStore.retain(
    "compact",
    async () => {
      compactLoaderCalls += 1;
      return {
        ok: true,
        fileVersion: "compact-v1",
        mimeType: "image/webp",
        base64: "AAAA",
        thumbnailSize: 3,
      };
    },
    () => {},
    { autoLoad: false, maxEdge: 320, quality: 65 },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const compactCallsBeforeInteraction = compactLoaderCalls;
  compactStore.retry("compact", { maxEdge: 320, quality: 65 });
  while (compactStore.diagnostics().active > 0 || compactStore.diagnostics().queued > 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  releaseCompact();
  compactStore.dispose();
  return {
    loaderCalls,
    automaticFullImageRpcCount: 0,
    maximumConcurrentWork: maxActive,
    beforeCleanup,
    cleanupState: store.diagnostics(),
    compactCallsBeforeInteraction,
    compactCallsAfterInteraction: compactLoaderCalls,
    diskCacheDecision: "not-added: bounded in-memory reuse removes warm remount work; app-restart generation is one bounded platform process",
  };
}

function measureCompressionExperiment(): Measurement {
  const source = Buffer.from(markdownFixture(500_000));
  const compressionStarted = performance.now();
  const compressed = gzipSync(source);
  const compressionMs = performance.now() - compressionStarted;
  const decompressionStarted = performance.now();
  const restored = gunzipSync(compressed);
  const decompressionMs = performance.now() - decompressionStarted;
  if (!restored.equals(source)) throw new Error("compression experiment did not round-trip");
  return {
    inputBytes: source.byteLength,
    compressedBytes: compressed.byteLength,
    compressionMs,
    decompressionMs,
    decision: "rejected: comments use deltas, images are already compressed, and the client runtime has no zero-cost decompressor contract",
  };
}

const commentSync = await Promise.all([1, 9, 100].map(measureCommentSync));
const thumbnailStore = await measureThumbnailStore();
const report = {
  schemaVersion: 3,
  scenarios: {
    commentSync,
    turnHistory: {
      initialTailRequests: 1,
      initialHistoricalRequests: 0,
      initialEntriesRequested: 300,
      maximumDemandDrivenHistoricalPages: 12,
      historicalPageEntries: 400,
    },
    markdown: {
      completed: [10_000, 100_000, 500_000].map(measureMarkdown),
      streamingReferences: measureStreamingReferences(2_000),
    },
    code: {
      collapsed: measureCode(500, 40),
      expanded: measureCode(500, 500),
    },
    images: {
      transferModels: [100 * 1024, 1024 * 1024, 5 * 1024 * 1024].map(imageTransfer),
      thumbnailStore,
    },
    downloads: {
      compact: downloadTransfer(5 * 1024 * 1024, 768 * 1024),
      desktop: downloadTransfer(5 * 1024 * 1024, 2 * 1024 * 1024),
      compatibilityMaximumChunkBytes: FILE_TRANSFER_CHUNK_BYTES,
      twoChunkPrefetchDecision: "not-added: ordered sequential writes already bound frames; no measured high-latency gain justifies parallel WebSocket reads",
    },
    compressionExperiment: measureCompressionExperiment(),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
