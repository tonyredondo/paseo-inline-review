import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import {
  classifyWideFrameMutations,
  pruneDisconnectedNodes,
} from "../client/wide-frame-mutations.ts";
import { parseInline } from "../shared/markdown-parse.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));

type FakeElement = {
  clientHeight: number;
  clientWidth: number;
  children: FakeElement[];
  parentElement: FakeElement | null;
  previousElementSibling: FakeElement | null;
  nextElementSibling: FakeElement | null;
  childElementCount: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  computedMaxWidth: string;
  computedBackgroundColor: string;
  textContent: string;
  setAttribute(name: string, value: string): void;
  insertBefore(node: FakeElement, before: FakeElement | null): void;
  cloneNode(deep?: boolean): FakeElement;
  remove(): void;
  matches(selector: string): boolean;
  querySelectorAll(selector: string): FakeElement[];
};

function dataKey(name: string): string {
  return name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function matches(node: FakeElement, selector: string): boolean {
  if (selector === "*") return true;
  const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
  if (!attribute) return false;
  const [, name, expected] = attribute;
  const actual = name.startsWith("data-") ? node.dataset[dataKey(name)] : node.attributes[name];
  return actual === expected;
}

function fakeElement({
  width = 0,
  height = 0,
  maxWidth = "none",
  backgroundColor = "transparent",
  attributes = {},
  text = "",
}: {
  width?: number;
  height?: number;
  maxWidth?: string;
  backgroundColor?: string;
  attributes?: Record<string, string>;
  text?: string;
} = {}): FakeElement {
  const node: FakeElement = {
    clientHeight: height,
    clientWidth: width,
    children: [],
    parentElement: null,
    previousElementSibling: null,
    nextElementSibling: null,
    childElementCount: 0,
    style: {},
    dataset: {},
    attributes: { ...attributes },
    computedMaxWidth: maxWidth,
    computedBackgroundColor: backgroundColor,
    textContent: text,
    setAttribute(name, value) {
      if (name.startsWith("data-")) this.dataset[dataKey(name)] = value;
      else this.attributes[name] = value;
    },
    insertBefore(child, before) {
      child.remove();
      const index = before ? this.children.indexOf(before) : -1;
      if (index >= 0) this.children.splice(index, 0, child);
      else this.children.push(child);
      child.parentElement = this;
      relink(this);
    },
    cloneNode(deep = false) {
      const clone = fakeElement({
        width: this.clientWidth,
        height: this.clientHeight,
        maxWidth: this.computedMaxWidth,
        backgroundColor: this.computedBackgroundColor,
        attributes: this.attributes,
        text: deep ? this.textContent : "",
      });
      clone.style = { ...this.style };
      clone.dataset = { ...this.dataset };
      if (deep) {
        for (const child of this.children) clone.insertBefore(child.cloneNode(true), null);
      }
      return clone;
    },
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentElement = null;
      relink(parent);
    },
    matches(selector) {
      return selector.split(",").some((candidate) => matches(this, candidate.trim()));
    },
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((value) => value.trim());
      const result: FakeElement[] = [];
      const visit = (current: FakeElement): void => {
        for (const child of current.children) {
          if (selectors.some((candidate) => matches(child, candidate))) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    },
  };
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function relink(parent: FakeElement): void {
  parent.childElementCount = parent.children.length;
  parent.children.forEach((child, index) => {
    child.parentElement = parent;
    child.previousElementSibling = parent.children[index - 1] ?? null;
    child.nextElementSibling = parent.children[index + 1] ?? null;
  });
}

function append(parent: FakeElement, ...children: FakeElement[]): void {
  for (const child of children) parent.insertBefore(child, null);
}

test("the wide-frame controller installs during the pre-paint layout phase", async () => {
  const sourcePath = resolve(testDirectory, "../client/wide-frame-controller.tsx");
  const layoutEffects: Array<() => void | (() => void)> = [];
  const passiveEffects: Array<() => void | (() => void)> = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__wideFrameLayoutEffects = layoutEffects;
  globals.__wideFramePassiveEffects = passiveEffects;
  globals.__wideFrameEnsureCalls = 0;
  globals.__wideFrameSettings = {
    status: "ready",
    values: { wideFrame: true },
    reload: async () => {},
  };
  const source = readFileSync(sourcePath, "utf8")
    .replace(/import type \{ PluginHostProps \}[^;]+;/, "type PluginHostProps = any;")
    .replace(/import \{ useSettings \}[^;]+;/, `
      const useSettings = () => globalThis.__wideFrameSettings;
    `)
    .replace(/import \{[^}]*useEffect[^}]*useRef[^}]*useState[^}]*\}[^;]+;/, `
      const useEffect = (effect: () => void | (() => void)) => {
        globalThis.__wideFramePassiveEffects.push(effect);
      };
      const useLayoutEffect = (effect: () => void | (() => void)) => {
        globalThis.__wideFrameLayoutEffects.push(effect);
      };
      const useRef = (value: unknown) => ({ current: value });
      const useState = (value: unknown) => [value, () => {}];
    `)
    .replace(/import \{\s*configureWideFrameLease,[^;]+;/, `
      const configureWideFrameLease = (_lease, _hostId, enabled) => {
        if (enabled) globalThis.__wideFrameEnsureCalls += 1;
      };
    `)
    .replace(/import \{ wideFrameSettings \}[^;]+;/, "const wideFrameSettings = {};");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const controller = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#wide-frame-layout-${Date.now()}`
  );

  controller.WideFrameController({
    theme: { colors: { accent: "#123456", foreground: "#ffffff", surface2: "#222222", border: "#333333" } },
    layout: { platform: "web", compact: false },
    host: { id: "M5", label: "M5" },
    wideFrameLease: Symbol("test"),
  });
  assert.equal(globals.__wideFrameEnsureCalls, 0);
  for (const effect of layoutEffects) effect();
  assert.equal(globals.__wideFrameEnsureCalls, 1);

  delete globals.__wideFrameLayoutEffects;
  delete globals.__wideFramePassiveEffects;
  delete globals.__wideFrameEnsureCalls;
  delete globals.__wideFrameSettings;
});

test("a virtualized timeline controller unmount cannot tear down the host-wide frame", async () => {
  const sourcePath = resolve(testDirectory, "../client/wide-frame-controller.tsx");
  const cleanups: Array<() => void> = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__wideFrameCleanups = cleanups;
  globals.__wideFrameEnsureCalls = 0;
  globals.__wideFrameUndoCalls = 0;
  globals.__wideFrameSettings = {
    status: "ready",
    values: { wideFrame: true },
    reload: async () => {},
  };
  const source = readFileSync(sourcePath, "utf8")
    .replace(/import type \{ PluginHostProps \}[^;]+;/, "type PluginHostProps = any;")
    .replace(/import \{ useSettings \}[^;]+;/, `
      const useSettings = () => globalThis.__wideFrameSettings;
    `)
    .replace(/import \{[^}]*useEffect[^}]*useRef[^}]*useState[^}]*\}[^;]+;/, `
      const useEffect = (effect: () => void | (() => void)) => {
        const cleanup = effect();
        if (typeof cleanup === "function") globalThis.__wideFrameCleanups.push(cleanup);
      };
      const useLayoutEffect = useEffect;
      const useRef = (value: unknown) => ({ current: value });
      const useState = (value: unknown) => [value, () => {}];
    `)
    .replace(/import \{\s*configureWideFrameLease,[^;]+;/, `
      const configureWideFrameLease = (_lease, _hostId, enabled) => {
        if (enabled) globalThis.__wideFrameEnsureCalls += 1;
        else globalThis.__wideFrameUndoCalls += 1;
      };
    `)
    .replace(/import \{ wideFrameSettings \}[^;]+;/, "const wideFrameSettings = {};");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const url = `${pathToFileURL(sourcePath).href}?wide-frame-controller-test=${Date.now()}`;
  const controller = await import(
    `data:text/javascript;base64,${Buffer.from(`${output}\n//# sourceURL=${url}`).toString("base64")}`
  );

  controller.WideFrameController({
    theme: { colors: { accent: "#123456", foreground: "#ffffff", surface2: "#222222", border: "#333333" } },
    layout: { platform: "web", compact: false },
    host: { id: "M5", label: "M5" },
    wideFrameLease: Symbol("test"),
  });
  assert.equal(globals.__wideFrameEnsureCalls, 1);

  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(globals.__wideFrameUndoCalls, 0);

  cleanups.length = 0;
  globals.__wideFrameEnsureCalls = 0;
  globals.__wideFrameUndoCalls = 0;
  globals.__wideFrameSettings = {
    status: "loading",
    reload: async () => {},
  };
  controller.WideFrameController({
    theme: { colors: { accent: "#123456", foreground: "#ffffff", surface2: "#222222", border: "#333333" } },
    layout: { platform: "web", compact: false },
    host: { id: "M5", label: "M5" },
    wideFrameLease: Symbol("test"),
  });
  assert.equal(globals.__wideFrameEnsureCalls, 0);
  assert.equal(globals.__wideFrameUndoCalls, 0);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(globals.__wideFrameUndoCalls, 0);

  cleanups.length = 0;
  globals.__wideFrameEnsureCalls = 0;
  globals.__wideFrameUndoCalls = 0;
  globals.__wideFrameSettings = {
    status: "ready",
    values: { wideFrame: false },
    reload: async () => {},
  };
  controller.WideFrameController({
    theme: { colors: { accent: "#123456", foreground: "#ffffff", surface2: "#222222", border: "#333333" } },
    layout: { platform: "web", compact: false },
    host: { id: "M5", label: "M5" },
    wideFrameLease: Symbol("test"),
  });
  assert.equal(globals.__wideFrameEnsureCalls, 0);
  assert.equal(globals.__wideFrameUndoCalls, 1);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(globals.__wideFrameUndoCalls, 1);

  delete globals.__wideFrameCleanups;
  delete globals.__wideFrameEnsureCalls;
  delete globals.__wideFrameUndoCalls;
  delete globals.__wideFrameSettings;
});

test("wide-frame styling is idempotent, bounded, and completely reversible", async () => {
  const body = fakeElement({ width: 1440 });
  const sidebar = fakeElement({ width: 200 });
  const pane = fakeElement({
    width: 1200,
    attributes: { "data-testid": "agent-chat-scroll" },
  });
  const staleCapped = fakeElement({ width: 1040, maxWidth: "1240px" });
  const staleToolCall = fakeElement({ attributes: { "data-testid": "tool-call-group" } });
  staleCapped.dataset.inlineReviewWide = "1";
  staleCapped.style.maxWidth = "1240px";
  append(staleCapped, staleToolCall);
  const capped = fakeElement({ width: 820, maxWidth: "820px" });
  const message = fakeElement({ attributes: { "data-testid": "user-message" } });
  const bubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  const images = fakeElement({ height: 90 });
  const imageOne = fakeElement({ attributes: { "aria-label": "Open image attachment" } });
  const imageTwo = fakeElement({ attributes: { "aria-label": "Open image attachment" } });
  const messageText = fakeElement({
    text: "tampoco estiramos `Context compacted` y **ancho**.",
  });
  const trail = fakeElement({ attributes: { "data-testid": "user-message-trailing-row" } });
  append(images, imageOne, imageTwo);
  append(bubble, images, messageText, trail);
  append(message, bubble);
  append(capped, message);
  const reviewCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const sentReview = fakeElement({ attributes: { "data-testid": "inline-review-sent" } });
  append(reviewCapped, sentReview);
  const compactionCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const compactionDivider = fakeElement({ attributes: { "data-testid": "inline-review-root" } });
  append(compactionCapped, compactionDivider);
  // Production virtualizes each timeline item inside its own row. The anchor
  // therefore sits one level below the common chat root; selecting its first
  // 820px wrapper would scope the runtime to this row and miss every sibling.
  const anchorRow = fakeElement();
  append(anchorRow, compactionCapped);
  append(pane, staleCapped, capped, reviewCapped, anchorRow);
  const foreignPane = fakeElement({ width: 1200 });
  const foreignCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const foreignMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  append(foreignCapped, foreignMessage);
  append(foreignPane, foreignCapped);
  append(body, sidebar, pane, foreignPane);

  const resizeListeners = new Set<() => void>();
  const frames = new Map<number, () => void>();
  let observerConstructions = 0;
  let observerDisconnections = 0;
  let observerCallback: ((mutations: unknown) => void) | null = null;
  const observations: Array<{
    root: FakeElement;
    options: { childList: boolean; subtree: boolean; attributes?: boolean; attributeFilter?: string[] };
  }> = [];
  let nextFrame = 1;
  const document = {
    body,
    createElement: () => fakeElement(),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__wideFramePlatform = { OS: "web" };
  globals.__wideFrameDocument = document;
  globals.__wideFrameClassify = classifyWideFrameMutations;
  globals.__wideFramePrune = pruneDisconnectedNodes;
  globals.__wideFrameAdaptiveRun = null;
  let parseInlineCalls = 0;
  globals.__wideFrameParseInline = (text: string) => {
    parseInlineCalls += 1;
    return parseInline(text);
  };
  globals.__wideFrameScheduledRestore = null;
  globals.__wideFrameWindow = {
    document,
    innerWidth: 1200,
    getComputedStyle: (node: FakeElement) => ({
      maxWidth: node.computedMaxWidth,
      backgroundColor: node.computedBackgroundColor,
    }),
    requestAnimationFrame(callback: () => void) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    MutationObserver: class {
      constructor(callback: (mutations: unknown) => void) {
        observerConstructions += 1;
        observerCallback = callback;
      }
      observe(
        root: FakeElement,
        options: { childList: boolean; subtree: boolean; attributes?: boolean; attributeFilter?: string[] },
      ) {
        observations.push({ root, options });
      }
      disconnect() {
        observerDisconnections += 1;
      }
    },
    addEventListener(type: string, listener: () => void) {
      if (type === "resize") resizeListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "resize") resizeListeners.delete(listener);
    },
  };

  const sourcePath = resolve(testDirectory, "../client/wide-frame.ts");
  const source = readFileSync(sourcePath, "utf8")
    .replace('import { Platform } from "react-native";', "const Platform = globalThis.__wideFramePlatform;")
    .replace(/import \{ wideFrameSettings \}[^;]+;/, "const wideFrameSettings = {};")
    .replace(/import \{ parseInline[^;]+;/, "const parseInline = globalThis.__wideFrameParseInline;")
    .replace(/import \{\s*acquireWideFrameLease,[\s\S]*?\} from "\.\/wide-frame-lease";/, `
      const WIDE_FRAME_CLEANUP_GRACE_MS = 5000;
      const acquireWideFrameLease = () => Symbol("test-wide-frame-lease");
      const cancelPendingWideFrameCleanup = () => {};
      const updateWideFrameLease = (_lease, options) => {
        if (options.enabled) return options.activate();
        options.deactivate();
        return true;
      };
      const releaseWideFrameCleanupLease = (_lease, cleanup, options) => {
        options?.prepareCleanup?.();
        globalThis.__wideFrameScheduledRestore = cleanup;
        return true;
      };
    `)
    .replace(/import \{ createAdaptiveSweep \}[^;]+;/, `
      const createAdaptiveSweep = ({ run }) => {
        globalThis.__wideFrameAdaptiveRun = run;
        return { start() {}, stop() {}, wake() {} };
      };
    `)
    .replace(/import \{[\s\S]*?classifyWideFrameMutations[\s\S]*?\} from "\.\/wide-frame-mutations";/, `
      const classifyWideFrameMutations = globalThis.__wideFrameClassify;
      const pruneDisconnectedNodes = globalThis.__wideFramePrune;
      const lowestCommonAncestor = (nodes) => {
        if (nodes.length === 0) return null;
        for (let candidate = nodes[0]; candidate; candidate = candidate.parentElement) {
          if (nodes.every((node) => {
            for (let current = node; current; current = current.parentElement) {
              if (current === candidate) return true;
            }
            return false;
          })) return candidate;
        }
        return null;
      };
    `)
    .replace(
      "const g = globalThis as unknown as WWin & { document?: WDoc };",
      "const g = globalThis.__wideFrameWindow as WWin & { document?: WDoc };",
    );
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#wide-frame-dom-${Date.now()}`
  );

  const anchorRef = { current: compactionDivider };
  const lease = module.retainWideFrameLease();
  module.configureWideFrameLease(
    lease,
    "M5",
    true,
    { accent: "#58a6ff", raised: "#242636", border: "#30363d" },
    anchorRef,
  );
  assert.equal(observerConstructions, 1);
  assert.equal(foreignCapped.style.maxWidth, undefined, "another workspace stays untouched");
  compactionDivider.clientWidth = 1040;
  const disconnectionsBeforeHandoff = observerDisconnections;
  const secondModule = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#wide-frame-dom-peer-${Date.now()}`
  );
  const replacementLease = secondModule.retainWideFrameLease();
  secondModule.configureWideFrameLease(
    replacementLease,
    "M5",
    true,
    { accent: "#58a6ff", raised: "#242636", border: "#30363d" },
  );
  assert.equal(
    observerConstructions,
    1,
    "a bundle without a mounted timeline cannot replace the active runtime",
  );
  assert.equal(observerDisconnections, disconnectionsBeforeHandoff);
  secondModule.configureWideFrameLease(
    replacementLease,
    "M5",
    true,
    { accent: "#58a6ff", raised: "#242636", border: "#30363d" },
    anchorRef,
  );
  assert.equal(
    observerConstructions,
    2,
    "a replacement bundle installs its own observer implementation",
  );
  assert.ok(
    observerDisconnections > disconnectionsBeforeHandoff,
    "the replacement bundle stops the previous observer",
  );
  assert.equal(observations[0].root, pane, "the subtree observer must be scoped to the timeline root");
  assert.equal(observations[0].options.subtree, true);
  assert.deepEqual(observations[0].options.attributeFilter, ["style", "data-testid"]);
  assert.equal(
    observations[1].root,
    body,
    "a shallow parent sentinel may observe replacement of the timeline root",
  );
  assert.equal(observations[1].options.subtree, false);
  assert.equal(observations[1].options.attributes, undefined);
  assert.equal(
    staleCapped.style.maxWidth,
    "1040px",
    "a new plugin instance must adopt and normalize wrappers marked by the previous instance",
  );
  assert.equal(capped.style.maxWidth, "1040px");
  assert.equal(
    reviewCapped.style.maxWidth,
    "1040px",
    "the compact sent-review widget must share the widened timeline frame",
  );
  assert.equal(
    compactionCapped.style.maxWidth,
    "1040px",
    "the context-compaction divider must share the widened timeline frame",
  );
  assert.equal(message.style.maxWidth, "100%");
  assert.equal(message.style.paddingBottom, "8px");
  assert.equal(bubble.style.paddingTop, "5px");
  assert.equal(bubble.style.paddingBottom, "5px");
  assert.equal(images.style.display, "flex");
  assert.equal(images.style.flexWrap, "nowrap");
  assert.equal(images.style.overflowX, "auto");
  assert.equal(images.style.maxWidth, "100%");
  assert.equal(images.style.paddingTop, "5px");
  assert.equal(images.style.marginBottom, "4px");
  assert.equal(imageOne.style.flexShrink, "0");
  assert.equal(trail.style.position, "relative");
  assert.equal(message.querySelectorAll('[data-inline-review-user-backdrop="1"]').length, 1);
  assert.equal(messageText.textContent, "tampoco estiramos `Context compacted` y **ancho**.");
  assert.equal(imageOne.parentElement, images, "Markdown must not move host-owned attachments");
  assert.equal(images.parentElement, bubble);
  assert.equal(messageText.style.display, "none", "the untouched host text is hidden, not rewritten");
  const renderedMarkdown = message.querySelectorAll('[data-inline-review-user-markdown="1"]');
  assert.equal(renderedMarkdown.length, 1, "a formatted message gets one visual Markdown clone");
  assert.ok(renderedMarkdown[0].children.length > 0, "formatting is composed from safe child nodes");
  const code = renderedMarkdown[0].querySelectorAll('[data-inline-review-markdown-kind="code"]');
  assert.equal(code.length, 1);
  assert.equal(code[0].textContent, "Context compacted");
  assert.equal(code[0].style.fontFamily.includes("monospace"), true);
  const strong = renderedMarkdown[0].querySelectorAll('[data-inline-review-markdown-kind="bold"]');
  assert.equal(strong.length, 1);
  assert.equal(strong[0].children[0]?.textContent, "ancho");
  assert.equal(strong[0].style.fontWeight, "700");
  assert.equal(parseInlineCalls, 1);

  const adaptiveRun = globals.__wideFrameAdaptiveRun as (() => void) | null;
  assert.equal(typeof adaptiveRun, "function");
  adaptiveRun?.();
  assert.equal(frames.size, 0, "a fully decorated timeline schedules no fallback work");

  // CSSOM writes made by the plugin are themselves observed. A synchronous
  // decoration pass must not clear and rebuild the image rail from inside the
  // observer callback: that creates another style mutation batch before the
  // browser can paint, and repeats until the renderer becomes unresponsive.
  const pluginStyleMutations: Array<{
    target: FakeElement;
    attributeName: string;
    addedNodes: FakeElement[];
  }> = [];
  const trackedNodes = [
    message,
    bubble,
    images,
    imageOne,
    imageTwo,
    trail,
    ...message.querySelectorAll('[data-inline-review-user-backdrop="1"]'),
    ...message.querySelectorAll('[data-inline-review-user-markdown="1"]'),
    messageText,
  ];
  for (const node of trackedNodes) {
    node.style = new Proxy(node.style, {
      set(target, property: string, value: string) {
        if (target[property] !== value) {
          target[property] = value;
          pluginStyleMutations.push({
            target: node,
            attributeName: "style",
            addedNodes: [],
          });
        }
        return true;
      },
    });
  }

  // React can rewrite an already widened host wrapper after the current frame
  // has started. Waiting for another animation frame leaves one visible paint
  // at the native 820px width; the observer must repair it synchronously.
  capped.style.maxWidth = "820px";
  const deliverMutations = observerCallback as unknown as (mutations: unknown) => void;
  assert.equal(typeof deliverMutations, "function");
  deliverMutations([{
    target: images,
    attributeName: "style",
    addedNodes: [],
  }]);
  assert.equal(
    pluginStyleMutations.length,
    0,
    "an observed image style change cannot synchronously generate another image style batch",
  );
  assert.equal(frames.size, 0, "card repair completes while the observer is paused");
  assert.equal(
    pluginStyleMutations.length,
    0,
    "redecorating an image card is idempotent across every styled node",
  );
  assert.equal(parseInlineCalls, 1, "unchanged Markdown is not reparsed during style repair");
  deliverMutations([{
    target: capped,
    attributeName: "style",
    addedNodes: [],
  }]);
  assert.equal(capped.style.maxWidth, "1040px");

  const liveCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const liveMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  append(liveCapped, liveMessage);
  append(pane, liveCapped);
  deliverMutations([{
    target: pane,
    addedNodes: [liveCapped],
  }]);
  assert.equal(liveCapped.style.maxWidth, "1040px");
  assert.equal(liveMessage.style.backgroundColor, "#242636");
  assert.equal(frames.size, 0, "new content is fully decorated before the next paint");

  const liveReviewCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const liveSentReview = fakeElement({ attributes: { "data-testid": "inline-review-sent" } });
  append(liveReviewCapped, liveSentReview);
  append(pane, liveReviewCapped);
  deliverMutations([{
    target: pane,
    addedNodes: [liveReviewCapped],
  }]);
  assert.equal(
    liveReviewCapped.style.maxWidth,
    "1040px",
    "a sent-review widget mounted after startup must widen before paint",
  );

  const reenteredCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const reenteredMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  const reenteredBubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  const reenteredText = fakeElement({
    attributes: { "data-message-text": "true" },
    text: "an unmatched ` stays literal",
  });
  append(reenteredBubble, reenteredText);
  append(reenteredMessage, reenteredBubble);
  append(reenteredCapped, reenteredMessage);
  append(pane, reenteredCapped);

  const disconnectionsBeforeRefresh = observerDisconnections;
  secondModule.configureWideFrameLease(replacementLease, "M5", true, undefined, anchorRef);
  assert.equal(observerConstructions, 2, "same-generation refresh reuses the observer");
  assert.equal(observerDisconnections, disconnectionsBeforeRefresh);
  assert.equal(reenteredCapped.style.maxWidth, "1040px");
  assert.equal(reenteredMessage.style.backgroundColor, "#242636");
  assert.equal(reenteredText.style.display, undefined, "plain or incomplete Markdown stays native");
  assert.equal(
    reenteredMessage.querySelectorAll('[data-inline-review-user-markdown="1"]').length,
    0,
  );
  const parseCallsAfterPlainMessage = parseInlineCalls;
  secondModule.configureWideFrameLease(replacementLease, "M5", true, undefined, anchorRef);
  assert.equal(
    parseInlineCalls,
    parseCallsAfterPlainMessage,
    "unchanged plain messages are cached without creating a clone",
  );
  assert.equal(message.querySelectorAll('[data-inline-review-user-backdrop="1"]').length, 1);
  assert.equal(resizeListeners.size, 1);

  // Paseo can replace the complete timeline subtree during navigation or
  // re-entry. The shallow parent sentinel must discover the replacement and
  // move the detailed observer without falling back to a body-wide subtree.
  pane.remove();
  const unrelatedPane = fakeElement({ width: 1200 });
  const unrelatedCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const unrelatedMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  append(unrelatedCapped, unrelatedMessage);
  append(unrelatedPane, unrelatedCapped);
  append(body, unrelatedPane);
  deliverMutations([{
    target: body,
    addedNodes: [unrelatedPane],
  }]);
  assert.equal(
    unrelatedCapped.style.maxWidth,
    undefined,
    "a disconnected timeline cannot adopt another workspace without its live anchor",
  );

  const replacementPane = fakeElement({ width: 1200 });
  const replacementCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const replacementMessage = fakeElement();
  const replacementBubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  append(replacementMessage, replacementBubble);
  append(replacementCapped, replacementMessage);
  append(replacementPane, replacementCapped);
  const concurrentPane = fakeElement({ width: 1200 });
  const concurrentCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const concurrentMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  append(concurrentCapped, concurrentMessage);
  append(concurrentPane, concurrentCapped);
  anchorRef.current = replacementMessage;
  append(body, concurrentPane);
  append(body, replacementPane);
  deliverMutations([{
    target: body,
    addedNodes: [concurrentPane, replacementPane],
  }]);
  assert.equal(
    replacementCapped.style.maxWidth,
    undefined,
    "a markerless replacement is adopted without styling unrelated wrappers",
  );
  assert.equal(
    concurrentCapped.style.maxWidth,
    undefined,
    "a replacement batch cannot widen a sibling workspace or fall back to body",
  );
  assert.equal(observations.at(-2)?.root, replacementPane);
  assert.equal(observations.at(-2)?.options.subtree, true);
  assert.equal(observations.at(-1)?.root, body);
  assert.equal(observations.at(-1)?.options.subtree, false);

  replacementMessage.setAttribute("data-testid", "user-message");
  deliverMutations([{
    target: replacementMessage,
    attributeName: "data-testid",
    addedNodes: [],
  }]);
  assert.equal(
    replacementCapped.style.maxWidth,
    "1040px",
    "a marker added after root replacement is observed and widened",
  );
  assert.equal(replacementMessage.style.backgroundColor, "#242636");
  assert.equal(
    concurrentCapped.style.maxWidth,
    undefined,
    "late marker handling remains scoped to the adopted timeline",
  );

  capped.style.maxWidth = "820px";
  deliverMutations([{
    target: replacementCapped,
    attributeName: "style",
    addedNodes: [],
  }]);
  assert.equal(
    capped.style.maxWidth,
    "820px",
    "detached wrappers are pruned instead of retained and repaired forever",
  );

  // React may append the row before assigning its test id. The attribute
  // transition itself must wake the card pass; otherwise the message keeps
  // Paseo's default bubble until some unrelated mutation happens later.
  for (const [frameId, callback] of [...frames]) {
    frames.delete(frameId);
    callback();
  }
  const lateCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const lateMessage = fakeElement();
  const lateBubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  append(lateMessage, lateBubble);
  append(lateCapped, lateMessage);
  append(replacementPane, lateCapped);
  deliverMutations([{ target: replacementPane, addedNodes: [lateCapped] }]);
  assert.equal(lateMessage.style.backgroundColor, undefined, "an unmarked row is ignored");
  lateMessage.setAttribute("data-testid", "user-message");
  deliverMutations([{
    target: lateMessage,
    attributeName: "data-testid",
    addedNodes: [],
  }]);
  assert.equal(lateCapped.style.maxWidth, "1040px");
  assert.equal(lateMessage.style.backgroundColor, "#242636");
  assert.equal(frames.size, 0, "a late marker cannot expose an unstyled card for one frame");

  // A narrow pane intentionally keeps Paseo's native frame width, but user
  // messages must still receive the review-card skin. Previously the width
  // guard returned before the card pass and left newly mounted rows as gray
  // host bubbles.
  replacementPane.clientWidth = 880;
  (globals.__wideFrameWindow as { innerWidth: number }).innerWidth = 880;
  for (const listener of resizeListeners) listener();
  for (const [frameId, callback] of [...frames]) {
    frames.delete(frameId);
    callback();
  }
  const narrowCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const narrowMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  const narrowBubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  append(narrowMessage, narrowBubble);
  append(narrowCapped, narrowMessage);
  append(replacementPane, narrowCapped);
  deliverMutations([{ target: replacementPane, addedNodes: [narrowCapped] }]);
  assert.equal(narrowCapped.style.maxWidth, undefined, "narrow panes retain the host frame width");
  assert.equal(
    narrowMessage.style.backgroundColor,
    "#242636",
    "a narrow-pane user message still receives the review-card skin",
  );
  assert.equal(narrowMessage.style.borderLeftWidth, "5px");

  // Reattach the detached fixture so cleanup can prove complete reversibility
  // for both the old and replacement subtrees.
  append(body, pane);

  const staleResize = [...resizeListeners][0];
  const disconnectionsBeforeRelease = observerDisconnections;
  secondModule.releaseWideFrameLease(replacementLease);
  assert.equal(
    observerDisconnections,
    disconnectionsBeforeRelease + 1,
    "plugin cleanup disconnects runtime work immediately",
  );
  assert.equal(resizeListeners.size, 0);
  assert.equal(capped.style.maxWidth, "820px", "visual rollback still waits for the grace period");
  const scheduledRestore = globals.__wideFrameScheduledRestore as (() => void) | null;
  assert.equal(typeof scheduledRestore, "function");
  scheduledRestore?.();
  assert.equal(capped.style.maxWidth, "");
  assert.equal(capped.dataset.inlineReviewWide, "");
  assert.equal(reviewCapped.style.maxWidth, "");
  assert.equal(compactionCapped.style.maxWidth, "");
  assert.equal(liveReviewCapped.style.maxWidth, "");
  assert.equal(message.style.paddingBottom, "");
  assert.equal(bubble.style.paddingTop, "");
  assert.equal(images.style.overflowX, "");
  assert.equal(imageOne.style.flexShrink, "");
  assert.equal(trail.style.position, "");
  assert.equal(message.querySelectorAll('[data-inline-review-user-backdrop="1"]').length, 0);
  assert.equal(message.querySelectorAll('[data-inline-review-user-markdown="1"]').length, 0);
  assert.equal(messageText.style.display, "", "cleanup restores the host text node");

  staleResize();
  for (const callback of frames.values()) callback();
  assert.equal(capped.style.maxWidth, "");

  delete globals.__wideFramePlatform;
  delete globals.__wideFrameDocument;
  delete globals.__wideFrameClassify;
  delete globals.__wideFramePrune;
  delete globals.__wideFrameAdaptiveRun;
  delete globals.__wideFrameParseInline;
  delete globals.__wideFrameScheduledRestore;
  delete globals.__wideFrameWindow;
});
