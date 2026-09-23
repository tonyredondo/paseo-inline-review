import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { classifyWideFrameMutations } from "../client/wide-frame-mutations.ts";

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
  setAttribute(name: string, value: string): void;
  insertBefore(node: FakeElement, before: FakeElement | null): void;
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
}: {
  width?: number;
  height?: number;
  maxWidth?: string;
  backgroundColor?: string;
  attributes?: Record<string, string>;
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
    .replace(/import \{ ensureWideFrame, undoWideFrame \}[^;]+;/, `
      const ensureWideFrame = () => { globalThis.__wideFrameEnsureCalls += 1; };
      const undoWideFrame = () => {};
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
    .replace(/import \{ ensureWideFrame, undoWideFrame \}[^;]+;/, `
      const ensureWideFrame = () => { globalThis.__wideFrameEnsureCalls += 1; };
      const undoWideFrame = () => { globalThis.__wideFrameUndoCalls += 1; };
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
  const pane = fakeElement({ width: 1200 });
  const capped = fakeElement({ width: 820, maxWidth: "820px" });
  const message = fakeElement({ attributes: { "data-testid": "user-message" } });
  const bubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  const images = fakeElement({ height: 90 });
  const imageOne = fakeElement({ attributes: { "aria-label": "Open image attachment" } });
  const imageTwo = fakeElement({ attributes: { "aria-label": "Open image attachment" } });
  const trail = fakeElement({ attributes: { "data-testid": "user-message-trailing-row" } });
  append(images, imageOne, imageTwo);
  append(bubble, images, trail);
  append(message, bubble);
  append(capped, message);
  append(pane, capped);

  const resizeListeners = new Set<() => void>();
  const frames = new Map<number, () => void>();
  let observerConstructions = 0;
  let observerDisconnections = 0;
  let observerCallback: ((mutations: unknown) => void) | null = null;
  let observedRoot: FakeElement | null = null;
  let nextFrame = 1;
  const document = {
    body: pane,
    createElement: () => fakeElement(),
    querySelectorAll: (selector: string) => pane.querySelectorAll(selector),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__wideFramePlatform = { OS: "web" };
  globals.__wideFrameDocument = document;
  globals.__wideFrameClassify = classifyWideFrameMutations;
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
      observe(root: FakeElement) {
        observedRoot = root;
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
    .replace(/import \{ createAdaptiveSweep \}[^;]+;/, `
      const createAdaptiveSweep = () => ({ start() {}, stop() {}, wake() {} });
    `)
    .replace(/import \{ classifyWideFrameMutations[^;]+;/, `
      const classifyWideFrameMutations = globalThis.__wideFrameClassify;
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

  module.ensureWideFrame({ accent: "#58a6ff", raised: "#242636", border: "#30363d" });
  assert.equal(observerConstructions, 1);
  assert.equal(observedRoot, pane);
  assert.equal(capped.style.maxWidth, "1040px");
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
  assert.equal(frames.size, 1, "card decoration is deferred out of the observer callback");
  const imageDecorationFrame = [...frames.entries()][0];
  assert.ok(imageDecorationFrame);
  frames.delete(imageDecorationFrame[0]);
  imageDecorationFrame[1]();
  assert.equal(
    pluginStyleMutations.length,
    0,
    "redecorating an image card is idempotent across every styled node",
  );
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
  assert.equal(frames.size, 1, "new content is widened before its deferred decoration frame");

  const reenteredCapped = fakeElement({ width: 820, maxWidth: "820px" });
  const reenteredMessage = fakeElement({ attributes: { "data-testid": "user-message" } });
  const reenteredBubble = fakeElement({ backgroundColor: "rgb(36, 38, 54)" });
  append(reenteredMessage, reenteredBubble);
  append(reenteredCapped, reenteredMessage);
  append(pane, reenteredCapped);

  module.ensureWideFrame();
  assert.equal(observerConstructions, 1, "same-document refresh reuses the observer");
  assert.equal(observerDisconnections, 0);
  assert.equal(reenteredCapped.style.maxWidth, "1040px");
  assert.equal(reenteredMessage.style.backgroundColor, "#242636");
  assert.equal(message.querySelectorAll('[data-inline-review-user-backdrop="1"]').length, 1);
  assert.equal(resizeListeners.size, 1);

  const staleResize = [...resizeListeners][0];
  module.undoWideFrame();
  assert.equal(observerDisconnections, 1);
  assert.equal(resizeListeners.size, 0);
  assert.equal(capped.style.maxWidth, "");
  assert.equal(capped.dataset.inlineReviewWide, "");
  assert.equal(message.style.paddingBottom, "");
  assert.equal(bubble.style.paddingTop, "");
  assert.equal(images.style.overflowX, "");
  assert.equal(imageOne.style.flexShrink, "");
  assert.equal(trail.style.position, "");
  assert.equal(message.querySelectorAll('[data-inline-review-user-backdrop="1"]').length, 0);

  staleResize();
  for (const callback of frames.values()) callback();
  assert.equal(capped.style.maxWidth, "");

  delete globals.__wideFramePlatform;
  delete globals.__wideFrameDocument;
  delete globals.__wideFrameClassify;
  delete globals.__wideFrameWindow;
});
