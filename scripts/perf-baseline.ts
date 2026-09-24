import { performance } from "node:perf_hooks";
import { gunzipSync, gzipSync } from "node:zlib";

import { createCommentSyncController } from "../client/comment-sync.ts";
import { createImagePreviewStore } from "../client/image-preview-store.ts";
import { createStableReferenceDefinitions } from "../client/markdown-stream.ts";
import { createStableParagraphs } from "../client/paragraph-stream.ts";
import {
  clearMarkdownCache,
  compileMarkdown,
  markdownCacheDiagnostics,
} from "../client/markdown-compile.ts";
import {
  clearSyntaxScannerCache,
  highlightCode,
  syntaxScannerCacheDiagnostics,
} from "../shared/syntax.ts";
import { FILE_TRANSFER_CHUNK_BYTES } from "../shared/review.ts";
import {
  disposeTurnIndexes,
  mountTurnFinalFragment,
  retainTurnIndex,
  subscribeTurnFinalFragments,
  subscribeTurnIndex,
} from "../client/turn-final-store.ts";
import { addComment, subscribeCommentsForSource } from "../client/review-store.ts";
import {
  classifyWideFrameMutations,
  lowestCommonAncestor,
  pruneDisconnectedNodes,
} from "../client/wide-frame-mutations.ts";

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

function measureStreamingParagraphs(size: number, updateCount: number): Measurement {
  const text = markdownFixture(size);
  const paragraphs = createStableParagraphs();
  let naiveInputCharacters = 0;
  let rendered: string[] = [];
  const started = performance.now();
  for (let update = 1; update <= updateCount; update += 1) {
    const end = Math.ceil((text.length * update) / updateCount);
    const snapshot = text.slice(0, end);
    naiveInputCharacters += snapshot.length;
    rendered = paragraphs.update(snapshot);
  }
  const diagnostics = paragraphs.diagnostics();
  return {
    updates: updateCount,
    finalInputCharacters: text.length,
    finalParagraphs: rendered.length,
    naiveFullScanCharacters: naiveInputCharacters,
    incrementalInspectedCharacters: diagnostics.inspectedCharacters,
    incrementalMaterializedCharacters: diagnostics.materializedCharacters,
    scanReduction: 1 - diagnostics.inspectedCharacters / naiveInputCharacters,
    fullRebuilds: diagnostics.fullRebuilds,
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

function measureSyntaxScannerCache(iterations: number): Measurement {
  const code = Array.from(
    { length: 40 },
    (_, index) => `const value${index}: string = String(${index});`,
  ).join("\n");
  clearSyntaxScannerCache();
  const coldStarted = performance.now();
  highlightCode(code, "typescript");
  const coldMs = performance.now() - coldStarted;
  const warmStarted = performance.now();
  for (let index = 0; index < iterations; index += 1) highlightCode(code, "ts");
  const warmMs = performance.now() - warmStarted;
  const cache = syntaxScannerCacheDiagnostics();
  clearSyntaxScannerCache();
  return {
    iterations,
    inputBytes: Buffer.byteLength(code),
    coldMs,
    warmTotalMs: warmMs,
    warmAverageMs: warmMs / iterations,
    cache,
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

function measureTurnFragmentNotifications(rowCount: number): Measurement {
  const agentId = `perf-fragments-${rowCount}`;
  let notifications = 0;
  const unsubscribers = Array.from({ length: rowCount }, (_, index) =>
    subscribeTurnFinalFragments(agentId, `source-${index}`, () => {
      notifications += 1;
    }),
  );
  const started = performance.now();
  const fragments = Array.from({ length: rowCount }, (_, index) =>
    mountTurnFinalFragment({
      agentId,
      sourceKey: `source-${index}`,
      messageId: `message-${index}`,
      text: `message ${index}`,
      timestamp: index,
      phase: "streaming",
    }),
  );
  const elapsedMs = performance.now() - started;
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  fragments.forEach((fragment) => fragment.release());
  disposeTurnIndexes();
  return {
    rows: rowCount,
    topologyChanges: rowCount,
    subscriberNotifications: notifications,
    elapsedMs,
  };
}

function measureGrowingTurnFragment(finalCharacters: number, updates: number): Measurement {
  const agentId = `perf-growing-fragment-${finalCharacters}`;
  const source = "streaming response ".repeat(Math.ceil(finalCharacters / 19)).slice(0, finalCharacters);
  const fragment = mountTurnFinalFragment({
    agentId,
    sourceKey: "stream",
    messageId: "message",
    text: "",
    timestamp: 1,
    phase: "streaming",
  });
  let naiveFullScanCharacters = 0;
  const started = performance.now();
  for (let update = 1; update <= updates; update += 1) {
    const end = Math.floor(source.length * update / updates);
    const text = source.slice(0, end);
    naiveFullScanCharacters += text.length;
    fragment.update({ messageId: "message", text, timestamp: 1, phase: "streaming" });
  }
  const elapsedMs = performance.now() - started;
  fragment.release();
  disposeTurnIndexes();
  return {
    updates,
    finalInputCharacters: source.length,
    naiveFullScanCharacters,
    appendOnlyCharacters: source.length,
    scanReduction: 1 - source.length / naiveFullScanCharacters,
    elapsedMs,
  };
}

async function measureIncrementalTimelineBurst(
  events: number,
  mode: "replacement" | "fragment" = "replacement",
): Promise<Measurement> {
  const agentId = `perf-incremental-timeline-${mode}-${events}`;
  let handler: ((message: unknown) => void) | null = null;
  let refetches = 0;
  const timeline = {
    subscribe(next: (message: unknown) => void): () => void {
      handler = next;
      return () => { handler = null; };
    },
    async refetch() {
      refetches += 1;
      return {
        entries: [{
          item: { type: "user_message", messageId: "user", text: "start" },
          turnId: "turn-1",
          seqEnd: 1,
        }],
        agent: { status: "running" },
        hasOlder: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
      };
    },
  };
  const release = retainTurnIndex(agentId, timeline, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let publications = 0;
  const unsubscribe = subscribeTurnIndex(agentId, () => { publications += 1; });
  const started = performance.now();
  for (let index = 0; index < events; index += 1) {
    (handler as unknown as (message: unknown) => void)({
      agentId,
      epoch: "epoch-1",
      seq: mode === "fragment" ? index + 2 : 2,
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "assistant_message",
          messageId: "tail",
          text: mode === "fragment" ? "x" : `stream ${index}`,
        },
      },
    });
  }
  (handler as unknown as (message: unknown) => void)({
    agentId,
    event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
  });
  const elapsedMs = performance.now() - started;
  unsubscribe();
  release();
  disposeTurnIndexes();
  return { mode, events, refetches, publications, elapsedMs };
}

function measureCommentNotificationFanout(rowCount: number): Measurement {
  const agentId = `perf-comments-${rowCount}`;
  let notifications = 0;
  const unsubscribers = Array.from({ length: rowCount }, (_, index) =>
    subscribeCommentsForSource(agentId, `message-${index}`, `source-${index}`, () => {
      notifications += 1;
    }),
  );
  const target = Math.floor(rowCount / 2);
  const started = performance.now();
  addComment({
    agentId,
    messageId: `message-${target}`,
    sourceKey: `source-${target}`,
    paragraphIndex: 0,
    paragraphText: "target paragraph",
    text: "benchmark comment",
  });
  const elapsedMs = performance.now() - started;
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  return {
    rows: rowCount,
    commentMutations: 1,
    subscriberNotifications: notifications,
    notificationReductionVsGlobal: 1 - notifications / rowCount,
    elapsedMs,
  };
}

type ObserverNode = {
  parentElement: ObserverNode | null;
  children: ObserverNode[];
};

function observerNode(parentElement: ObserverNode | null = null): ObserverNode {
  const node = { parentElement, children: [] as ObserverNode[] };
  parentElement?.children.push(node);
  return node;
}

function descendantCount(node: ObserverNode): number {
  let count = 0;
  const pending = [...node.children];
  while (pending.length > 0) {
    const current = pending.pop()!;
    count += 1;
    pending.push(...current.children);
  }
  return count;
}

function measureWideFrameObserverScope(): Measurement {
  // Mirrors the live desktop sample used for the optimization: 6,037 body
  // descendants, 441 timeline descendants and 34 widened rows.
  const body = observerNode();
  const unrelated = observerNode(body);
  for (let index = 0; index < 5_594; index += 1) observerNode(unrelated);
  const timeline = observerNode(body);
  const timelineNodes = Array.from({ length: 441 }, () => observerNode(timeline));
  const widenedRows = timelineNodes.slice(0, 34);
  const started = performance.now();
  const observerRoot = lowestCommonAncestor(widenedRows);
  const selectionMs = performance.now() - started;
  if (observerRoot !== timeline) throw new Error("observer benchmark selected the wrong root");
  const bodyDescendants = descendantCount(body);
  const observedDescendants = descendantCount(observerRoot);
  return {
    widenedRows: widenedRows.length,
    bodyDescendants,
    observedDescendants,
    subtreeReduction: 1 - observedDescendants / bodyDescendants,
    bodyToTimelineRatio: bodyDescendants / observedDescendants,
    shallowReplacementSentinels: 1,
    selectionMs,
  };
}

function measureWideFrameRetention(staleRows: number, liveRows: number): Measurement {
  const body = observerNode();
  const staleTimeline = observerNode(body);
  const stale = Array.from({ length: staleRows }, () => observerNode(staleTimeline));
  const liveTimeline = observerNode(body);
  const live = Array.from({ length: liveRows }, () => observerNode(liveTimeline));
  const retained = new Set([...stale, ...live]);
  body.children.splice(body.children.indexOf(staleTimeline), 1);
  staleTimeline.parentElement = null;

  const started = performance.now();
  const prunedRows = pruneDisconnectedNodes(retained, body);
  const elapsedMs = performance.now() - started;
  return {
    staleRows,
    liveRows,
    prunedRows,
    retainedRows: retained.size,
    retainedReductionVsUnpruned: 1 - retained.size / (staleRows + liveRows),
    elapsedMs,
  };
}

function measureWideFrameMutationRouting(updates: number): Measurement {
  type Node = {
    parentElement: Node | null;
    style: Record<string, string>;
    dataset: Record<string, string>;
  };
  const agentCard: Node = { parentElement: null, style: {}, dataset: {} };
  const streamingChild: Node = { parentElement: agentCard, style: {}, dataset: {} };
  let repairWakeups = 0;
  const started = performance.now();
  for (let index = 0; index < updates; index += 1) {
    const work = classifyWideFrameMutations<Node>({
      mutations: [{ target: streamingChild, attributeName: "style", addedNodes: [] }],
      markerSelector: '[data-testid="inline-review-root"]',
    });
    if (work.repairWidenedStyles || work.scopes.length > 0) repairWakeups += 1;
  }
  return {
    streamingStyleUpdates: updates,
    legacyRepairWakeups: updates,
    repairWakeups,
    repairWakeupReduction: 1 - repairWakeups / updates,
    elapsedMs: performance.now() - started,
  };
}

const commentSync = await Promise.all([1, 9, 100].map(measureCommentSync));
const thumbnailStore = await measureThumbnailStore();
const incrementalTimeline = await measureIncrementalTimelineBurst(10_000);
const fragmentedTimeline = await measureIncrementalTimelineBurst(10_000, "fragment");
const report = {
  schemaVersion: 9,
  scenarios: {
    commentSync,
    commentNotifications: measureCommentNotificationFanout(300),
    turnHistory: {
      initialTailRequests: 1,
      initialHistoricalRequests: 0,
      initialEntriesRequested: 100,
      maximumDemandDrivenHistoricalPages: 12,
      historicalPageEntries: 200,
      incrementalTimeline,
      fragmentedTimeline,
    },
    turnFragments: {
      mounts: measureTurnFragmentNotifications(300),
      growingText: [10_000, 100_000, 500_000]
        .map((size) => measureGrowingTurnFragment(size, 200)),
    },
    wideFrameObserverScope: measureWideFrameObserverScope(),
    wideFrameRetention: measureWideFrameRetention(10_000, 34),
    wideFrameMutationRouting: measureWideFrameMutationRouting(10_000),
    markdown: {
      completed: [10_000, 100_000, 500_000].map(measureMarkdown),
      streamingReferences: measureStreamingReferences(2_000),
      streamingParagraphs: [10_000, 100_000, 500_000]
        .map((size) => measureStreamingParagraphs(size, 200)),
    },
    code: {
      collapsed: measureCode(500, 40),
      expanded: measureCode(500, 500),
      scannerCache: measureSyntaxScannerCache(1_000),
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
