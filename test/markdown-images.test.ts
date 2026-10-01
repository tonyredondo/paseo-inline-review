import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

import { classifyLocalFileLink } from "../shared/markdown-parse.ts";
import { COMPACT_IMAGE_VIEWER_MAX_BYTES, FILE_TRANSFER_CHUNK_BYTES } from "../shared/review.ts";

// Execute the real renderer with host primitives and synchronous hooks. Image
// loading and cache lifetimes are exercised separately by the preview tests.
const hostModules: Record<string, string> = {
  react: `
    export const Fragment = "Fragment";
    export const useMemo = (factory, deps) => __hooks.current ? __hooks.current.memo(factory, deps) : factory();
    export const useRef = current => __hooks.current ? __hooks.current.memo(() => ({ current }), []) : ({ current });
    export const useState = initial => __hooks.current ? __hooks.current.state(initial) : [typeof initial === "function" ? initial() : initial, () => {}];
    export const useEffect = (effect, deps) => __hooks.current?.effect(effect, deps);
  `,
  "react/jsx-runtime": `
    export const Fragment = "Fragment";
    export const jsx = (type, props, key) => ({ type, props, key });
    export const jsxs = jsx;
  `,
  "react-native": `
    export const Image = Object.assign(props => ({type: "Image", props}), {getSize: (uri, success, failure) => __hooks.imageSize(uri, success, failure)});
    export const Text = "Text", View = "View", Pressable = "Pressable", ScrollView = "ScrollView", Modal = "Modal", SafeAreaView = "SafeAreaView", ActivityIndicator = "ActivityIndicator";
    export const PanResponder = { create: callbacks => ({ panHandlers: callbacks }) };
    export const Platform = __hooks.platform;
    export const StyleSheet = { hairlineWidth: 1, create: value => value };
    export const Linking = { openURL: () => {} };
  `,
  "@getpaseo/plugin": "export const defineRpc = contract => contract;",
  "@getpaseo/plugin/client": "export const useRpc = contract => __hooks.rpc(contract.name);",
  "@getpaseo/plugin/client/react-native": "export const copyText = () => {}; export const Icon = 'Icon'; export const FlatList = props => props.data.slice(0, props.initialNumToRender).map((item, index) => props.renderItem({ item, index }));",
};

const bundle = await build({
  stdin: {
    contents: 'export { MarkdownText } from "./client/markdown"; export { ImageGallery } from "./client/image-gallery"; export { ZoomableImage } from "./client/image-zoom"; export { disposeImagePreviews } from "./client/image-preview-store";',
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  plugins: [{
    name: "paseo-host-primitives",
    setup(builder) {
      builder.onResolve({ filter: /^(react|react-native|@getpaseo\/plugin)(\/.*)?$/ }, (args) => ({
        path: args.path, namespace: "host",
      }));
      builder.onLoad({ filter: /.*/, namespace: "host" }, (args) => ({
        contents: hostModules[args.path], loader: "js",
      }));
    },
  }],
});
type Component = (props: Record<string, unknown>) => unknown;
const module = { exports: {} as { MarkdownText: Component; ImageGallery: Component; ZoomableImage: Component; disposeImagePreviews(): void } };
const openedUrls: string[] = [];
const keys = new Set<(event: Record<string, unknown>) => void>();
const hooks = {
  platform: { OS: "web" },
  current: null as HookScope | null,
  imageSize: (_uri: string, success: (width: number, height: number) => void, _failure: () => void) => success(800, 400),
  rpc: (_name: string): ((input: Record<string, unknown>) => Promise<unknown>) => {
    return () => { throw new Error("Unexpected image RPC during render"); };
  },
};
runInNewContext(`(function(module, exports) {\n${bundle.outputFiles[0].text}\n})(module, exports);`, {
  module, exports: module.exports, setTimeout, clearTimeout, URL,
  __hooks: hooks,
  addEventListener: (_name: string, listener: (event: Record<string, unknown>) => void) => keys.add(listener),
  removeEventListener: (_name: string, listener: (event: Record<string, unknown>) => void) => keys.delete(listener),
  open: (url: string) => openedUrls.push(url),
});
const theme = { colors: new Proxy({}, { get: () => "#aaaaaa" }) };

type Element = { type: string | Component; props: Record<string, unknown>; key?: string };

function render(text: string, props: Record<string, unknown> = {}) {
  const images: string[] = [];
  const elements: Element[] = [];
  const parts: string[] = [];
  function visit(node: unknown, insideText = false): void {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((child) => visit(child, insideText)); return; }
    if (typeof node === "string" || typeof node === "number") { parts.push(String(node)); return; }
    const element = node as Element;
    elements.push(element);
    if (typeof element.type === "function") { visit(element.type(element.props), insideText); return; }
    if (["View", "Pressable", "Image"].includes(element.type)) {
      assert.equal(insideText, false, `${element.type} cannot be nested inside native Text`);
    }
    if (element.type === "Image") {
      const uri = (element.props.source as { uri: string }).uri;
      images.push(uri);
      parts.push(`<image:${uri}>`);
    }
    visit(element.props.children, insideText || element.type === "Text");
  }
  visit(module.exports.MarkdownText({ text, theme, compact: false, ...props }));
  return { images, elements, text: parts.join("") };
}

const urls = ["one", "two", "three"].map((name) => `https://example.com/${name}.png`);
const markdown = urls.map((url) => `![Image](${url})`);

test("adjacent provider image outputs render all images instead of [Image][Image][Image]", () => {
  const output = render(markdown.join(""));
  assert.deepEqual([...new Set(output.images)], urls, output.text);
  assert.equal(output.elements.filter((element) => typeof element.type === "function" && element.type.name === "ImageGallery").length, 1);
  assert.doesNotMatch(output.text, /\[Image\]/);
});

test("images on consecutive lines and separated by spaces keep their order", () => {
  for (const separator of ["\n", " ", "\n\n"]) {
    assert.deepEqual([...new Set(render(markdown.join(separator)).images)], urls);
  }
});

test("text and formatting surrounding paragraph images remain in order", () => {
  const output = render(`Before **bold** ${markdown[0]} between ${markdown[1]} after`);
  assert.deepEqual(output.images, urls.slice(0, 2));
  assert.ok(output.text.indexOf("Before bold") < output.text.indexOf(" between "));
  assert.ok(output.text.indexOf(" between ") < output.text.indexOf(" after"));
});

test("grouped local images retain thumbnail and full-image targets", () => {
  const paths = ["/tmp/one.png", "/tmp/two.png", "/tmp/three.png"];
  const opened: string[] = [];
  const output = render(paths.map((path) => `![Image](${path})`).join(""), {
    localFileResolver: (href: string) => classifyLocalFileLink(href),
    onLocalFilePress: (target: { path: string }) => opened.push(target.path),
  });
  const previews = output.elements.filter((element) =>
    typeof element.type === "function" && element.type.name === "ImagePreview" && element.props.thumbnail,
  );
  assert.equal(previews.length, 3, output.text);
  const gallery = output.elements.find((element) => typeof element.type === "function" && element.type.name === "ImageGallery")!;
  for (const preview of previews) (gallery.props.onLocalFilePress as (target: unknown) => void)(preview.props.target);
  assert.deepEqual(opened, paths);
  assert.doesNotMatch(output.text, /\[Image\]/);
});

test("compact grouped remote images keep explicit loading controls", () => {
  const output = render(markdown.join(""), { compact: true });
  assert.equal(output.images.length, 0);
  assert.equal(output.elements.filter((element) =>
    element.type === "Pressable" && element.props.accessibilityLabel === "Load image previews",
  ).length, 1);
  assert.equal(output.elements.filter((element) => element.type === "Pressable" && /^Show image /.test(String(element.props.accessibilityLabel))).length, 3);
});

test("single images and reference links surrounding images still render", () => {
  assert.deepEqual(render(markdown[0]).images, [urls[0]]);
  const output = render(`${markdown[0]}[reference][two]${markdown[1]}`, {
    refs: new Map([["two", urls[1]]]),
  });
  assert.deepEqual(output.images, urls.slice(0, 2));
  assert.match(output.text, /reference/);
});

test("table cells and structured text expose precise comment targets on native and web", () => {
  const events: unknown[] = [];
  for (const OS of ["web", "ios", "android"]) {
    hooks.platform.OS = OS;
    const output = render("## Heading\n\n| Name | Value |\n| --- | --- |\n| Phone | 20 |\n| Tablet | 20 |\n\n> Quote\n\n> [!NOTE]\n> Callout\n\n[^1]: Footnote", {
      onTargetPress: (target: unknown) => events.push(target),
    });
    const cell = output.elements.find(element => element.props.accessibilityLabel === "Comment on table row 2, Value: 20");
    assert.ok(cell);
    (cell.props.onPress as (event: unknown) => void)({ nativeEvent: {} });
    const target = events.pop() as { kind: string; row: number; column: number; rowText: string[] };
    assert.equal(target.kind, "table-cell");
    assert.equal(target.row, 1);
    assert.equal(target.column, 1);
    assert.deepEqual([...target.rowText], ["Tablet", "20"]);
    (cell.props.onAccessibilityAction as () => void)();
    assert.equal((events.pop() as { kind: string }).kind, "table-cell");
    if (OS === "web") {
      (cell.props.onPress as (event: unknown) => void)({ nativeEvent: { detail: 0 } });
      assert.equal((events.pop() as { kind: string }).kind, "table-cell");
    } else {
      (cell.props.onLongPress as () => void)();
      assert.equal((events.pop() as { kind: string }).kind, "table-cell");
    }
    for (const element of output.elements.filter(element => element.type === "Text" && typeof element.props.onPress === "function")) (element.props.onPress as () => void)();
    for (const blockKind of ["heading", "quote", "alert", "footnote"]) {
      assert.ok(events.some(target => (target as { kind: string; blockKind?: string }).kind === "block" && (target as { blockKind: string }).blockKind === blockKind), blockKind);
    }
    events.length = 0;
  }
  hooks.platform.OS = "web";
});

test("image comment buttons identify the selected image and distinct gallery runs", () => {
  const targets: Array<{ kind: string; imageIndex: number; url: string }> = [];
  const output = render(`${markdown[0]}${markdown[1]} intervening text ${markdown[2]}`, {
    onTargetPress: (target: { kind: string; imageIndex: number; url: string }) => targets.push(target),
  });
  const galleries = output.elements.filter(element => typeof element.type === "function" && element.type.name === "ImageGallery");
  assert.equal(galleries.length, 2);
  (galleries[0].props.onImageComment as (image: unknown, index: number) => void)((galleries[0].props.images as unknown[])[1], 1);
  (galleries[1].props.onImageComment as (image: unknown, index: number) => void)((galleries[1].props.images as unknown[])[0], 0);
  assert.deepEqual(targets.map(target => target.imageIndex), [1, 2]);
  assert.deepEqual(targets.map(target => target.url), urls.slice(1));
  assert.equal(output.elements.filter(element => element.props.accessibilityLabel === "Comment on image").length, 2);
});

test("generated hash and UUID filenames use a concise label without hiding descriptive alt text", () => {
  for (const name of ["63f90dd19679348dc002f2b73b0e3f385b906b02e1947323b56e954c38b2406e.png", "AEAC0436-098C-4469-B1FF-9DF5D44530C9.jpg"]) {
    for (const alt of ["Image", name]) {
      const output = render(`![${alt}](/tmp/${name})`);
      assert.ok(output.elements.some((element) => element.type === "Text" && element.props.children === "Image"));
      assert.equal(output.elements.some((element) => element.type === "Text" && element.props.children === name), false);
      assert.ok(output.images.includes(`/tmp/${name}`));
    }
    assert.match(render(`![Home screen](/tmp/${name})`).text, /Home screen/);
  }
});

test("long filenames keep their extension and full accessible name in desktop and compact captions", () => {
  const name = "Screenshot-of-the-home-screen-with-a-very-long-descriptive-file-name.png";
  for (const compact of [false, true]) {
    const output = render(`![Image](/tmp/${name})`, { compact });
    const caption = output.elements.find((element) => element.type === "Text" && element.props.accessibilityLabel === name)!;
    assert.ok(caption);
    assert.ok(output.text.endsWith(name), output.text);
    assert.ok(output.elements.some((element) => element.type === "Text" && element.props.children === ".png"));
  }
});

test("literal placeholders and inline code never become image requests", () => {
  const output = render(`[Image][Image] \`${markdown[0]}\``);
  assert.equal(output.images.length, 0);
  assert.equal(output.text, `[Image][Image] ${markdown[0]}`);
});

test("paragraph image links retain their remote destinations", () => {
  const destination = "https://example.com/gallery";
  const output = render(`Before [${markdown[0]}](${destination}) after`);
  assert.deepEqual(output.images, [urls[0]]);
  const link = output.elements.find((element) =>
    element.type === "Pressable" && element.props.accessibilityLabel === "Open image link",
  );
  assert.ok(link);
  (link.props.onPress as () => void)();
  assert.equal(openedUrls.at(-1), destination);
});

test("linked local thumbnails open the link target instead of the image path", () => {
  const opened: string[] = [];
  const output = render("Before [![Image](/tmp/image.png)](/tmp/report.md) after", {
    localFileResolver: (href: string) => classifyLocalFileLink(href),
    onLocalFilePress: (target: { path: string }) => opened.push(target.path),
  });
  const preview = output.elements.find((element) =>
    element.type === "Pressable" && element.props.accessibilityLabel === "Open image link",
  );
  assert.ok(preview);
  (preview.props.onPress as () => void)();
  assert.deepEqual(opened, ["/tmp/report.md"]);
});

type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
function sameDeps(previous: unknown[] | undefined, next: unknown[]): boolean {
  return !!previous && previous.length === next.length && next.every((value, index) => Object.is(value, previous[index]));
}

// Drive the actual components through state changes and effect cleanup without
// adding a DOM or native renderer dependency to the plugin's test environment.
class HookScope {
  slots: Slot[] = [];
  cursor = 0;
  dirty = false;
  active = true;
  pending: (() => void)[] = [];
  state(initial: unknown): [unknown, (next: unknown) => void] {
    const index = this.cursor++;
    const slot = this.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
    return [slot.value, (next) => {
      if (!this.active) return;
      const value = typeof next === "function" ? next(slot.value) : next;
      if (!Object.is(value, slot.value)) { slot.value = value; this.dirty = true; }
    }];
  }
  memo(factory: () => unknown, deps: unknown[]): unknown {
    const slot = this.slots[this.cursor++] ??= {};
    if (!sameDeps(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; }
    return slot.value;
  }
  effect(effect: () => (() => void) | undefined, deps: unknown[]): void {
    const slot = this.slots[this.cursor++] ??= {};
    if (sameDeps(slot.deps, deps)) return;
    slot.deps = deps;
    this.pending.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
  }
  render(component: Component, props: Record<string, unknown>): unknown {
    let output: unknown;
    for (let pass = 0; pass < 20; pass++) {
      this.cursor = 0; this.dirty = false; this.pending = [];
      hooks.current = this;
      try { output = component(props); } finally { hooks.current = null; }
      this.pending.forEach((effect) => effect());
      if (!this.dirty) return output;
    }
    throw new Error("Component did not settle");
  }
  dispose(): void {
    this.active = false;
    this.slots.forEach((slot) => slot.cleanup?.());
  }
}

function descendants(tree: unknown): Element[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(descendants);
  const node = tree as Element;
  return [node, ...descendants(node.props.children)];
}

class GalleryFixture {
  scope = new HookScope();
  fullScope?: HookScope;
  fullKey?: string;
  tree: unknown;
  fullTree: unknown;
  requests: { path: string; optimizeImage: unknown; imageMaxBytes: unknown; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  openedFiles: string[] = [];
  props: Record<string, unknown>;
  constructor(compact = false) {
    const fullLoader = (input: Record<string, unknown>) => new Promise((resolve, reject) => {
      this.requests.push({ path: String(input.path), optimizeImage: input.optimizeImage, imageMaxBytes: input.imageMaxBytes, resolve, reject });
    });
    hooks.rpc = () => fullLoader;
    this.props = {
      images: ["one", "two", "three"].map((name) => ({ type: "image", alt: name, url: `/tmp/${name}.png` })),
      compact, theme, resolveFile: classifyLocalFileLink,
      onLocalFilePress: (target: { path: string }) => this.openedFiles.push(target.path),
    };
    this.render();
  }
  render(): void {
    this.tree = this.scope.render(module.exports.ImageGallery, this.props);
    const full = descendants(this.tree).find((element) => typeof element.type === "function" && element.type.name === "FullImage");
    if (this.fullKey !== full?.key || !full) { this.fullScope?.dispose(); this.fullScope = undefined; this.fullKey = full?.key; }
    this.fullTree = full ? (this.fullScope ??= new HookScope()).render(full.type as Component, full.props) : null;
  }
  press(label: string, tree = this.tree): void {
    const button = descendants(tree).find((element) => element.type === "Pressable" && element.props.accessibilityLabel === label);
    assert.ok(button, `Missing ${label}`);
    assert.ok(!button.props.disabled, `${label} is disabled`);
    (button.props.onPress as () => void)();
    this.render();
  }
  key(key: string, target?: { tagName: string }): boolean {
    let prevented = false;
    [...keys].forEach((listener) => listener({ key, target, preventDefault: () => { prevented = true; } }));
    this.render();
    return prevented;
  }
  async settle(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); this.render(); }
  dispose(): void { this.scope.dispose(); this.fullScope?.dispose(); module.exports.disposeImagePreviews(); }
}

function visibleText(tree: unknown): string {
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  if (typeof tree !== "object") return String(tree);
  if (Array.isArray(tree)) return tree.map(visibleText).join("");
  return visibleText((tree as Element).props.children);
}

test("carousel selection, thumbnails and shrinking streamed groups retain a valid current image", () => {
  const fixture = new GalleryFixture(true);
  try {
    assert.equal(fixture.requests.length, 0);
    assert.match(visibleText(fixture.tree), /1 \/ 3/);
    assert.equal(descendants(fixture.tree).find((element) => element.props.accessibilityLabel === "Previous image")?.props.disabled, true);
    fixture.press("Next image");
    assert.match(visibleText(fixture.tree), /2 \/ 3/);
    const list = descendants(fixture.tree).find((element) => typeof element.type === "function" && element.props.renderItem)!;
    const item = (list.props.renderItem as (input: unknown) => unknown)({ item: (fixture.props.images as unknown[])[2], index: 2 });
    fixture.press("Show image 3 of 3: three", item);
    assert.match(visibleText(fixture.tree), /3 \/ 3/);
    assert.equal(descendants(fixture.tree).find((element) => element.props.accessibilityLabel === "Next image")?.props.disabled, true);
    fixture.props.images = (fixture.props.images as unknown[]).slice(0, 2);
    fixture.render();
    assert.match(visibleText(fixture.tree), /2 \/ 2/);
    assert.equal(fixture.requests.length, 0);
    fixture.props.images = [];
    fixture.render();
    assert.equal(fixture.tree, null);
  } finally { fixture.dispose(); }
});

test("full images load only on expand, ignore late navigation replies, and close on Escape", async () => {
  const fixture = new GalleryFixture();
  try {
    fixture.press("Next image");
    assert.equal(fixture.requests.length, 0);
    fixture.press("Enlarge image");
    assert.equal(fixture.requests[0].path, "/tmp/two.png");
    assert.equal(fixture.requests[0].optimizeImage, true);
    assert.match(visibleText(fixture.fullTree), /Loading image/);
    assert.equal(fixture.key("ArrowRight"), true);
    fixture.requests[1].resolve({ ok: true, mimeType: "image/png", base64: "CURRENT" });
    await fixture.settle();
    fixture.requests[0].resolve({ ok: true, mimeType: "image/png", base64: "OLD" });
    await fixture.settle();
    assert.equal(descendants(fixture.fullTree)[0].props.uri, "data:image/png;base64,CURRENT");
    assert.equal(fixture.key("ArrowLeft", { tagName: "INPUT" }), false);
    assert.match(visibleText(fixture.tree), /3 \/ 3/);
    assert.equal(fixture.key("Escape"), true);
    assert.equal(descendants(fixture.tree).some((element) => element.type === "Modal"), false);
    assert.equal(keys.size, 0);
    assert.match(visibleText(fixture.tree), /3 \/ 3/);
  } finally { fixture.dispose(); }
});

test("expanded images request 3 MiB on mobile/compact layouts and discard stale desktop replies", async () => {
  const fixture = new GalleryFixture();
  try {
    fixture.press("Enlarge image");
    assert.equal(fixture.requests[0].imageMaxBytes, FILE_TRANSFER_CHUNK_BYTES);
    fixture.props.compact = true;
    fixture.render();
    assert.equal(fixture.requests[1].imageMaxBytes, COMPACT_IMAGE_VIEWER_MAX_BYTES);
    fixture.requests[1].resolve({ ok: true, mimeType: "image/png", base64: "COMPACT" });
    await fixture.settle();
    fixture.requests[0].resolve({ ok: true, mimeType: "image/png", base64: "DESKTOP" });
    await fixture.settle();
    assert.equal(descendants(fixture.fullTree)[0].props.uri, "data:image/png;base64,COMPACT");
  } finally { fixture.dispose(); }
  for (const platform of ["ios", "android"]) {
    hooks.platform.OS = platform;
    const mobile = new GalleryFixture(false);
    try {
      mobile.press("Enlarge image");
      assert.equal(mobile.requests[0].imageMaxBytes, COMPACT_IMAGE_VIEWER_MAX_BYTES);
    } finally { mobile.dispose(); hooks.platform.OS = "web"; }
  }
});

test("closing and reopening the same image shares its pending request", async () => {
  const fixture = new GalleryFixture();
  try {
    fixture.press("Enlarge image");
    fixture.press("Close image viewer");
    fixture.press("Enlarge image");
    assert.equal(fixture.requests.length, 1);
    fixture.requests[0].resolve({ ok: true, mimeType: "image/png", base64: "REOPENED" });
    await fixture.settle();
    assert.equal(descendants(fixture.fullTree)[0].props.uri, "data:image/png;base64,REOPENED");
  } finally { fixture.dispose(); }
});

test("returning to a loaded full image and reopening it reuses the cached payload", async () => {
  const fixture = new GalleryFixture(true);
  try {
    fixture.press("Enlarge image");
    fixture.requests[0].resolve({ ok: true, mimeType: "image/png", base64: "FIRST" });
    await fixture.settle();
    fixture.press("Next image");
    fixture.requests[1].resolve({ ok: true, mimeType: "image/png", base64: "SECOND" });
    await fixture.settle();
    fixture.press("Previous image");
    assert.equal(fixture.requests.length, 2);
    assert.equal(descendants(fixture.fullTree)[0].props.uri, "data:image/png;base64,FIRST");
    fixture.press("Close image viewer");
    fixture.press("Enlarge image");
    assert.equal(fixture.requests.length, 2);
    assert.equal(descendants(fixture.fullTree)[0].props.uri, "data:image/png;base64,FIRST");
  } finally { fixture.dispose(); }
});

test("full-image errors support retry, decode errors, and the existing file-preview fallback", async () => {
  const fixture = new GalleryFixture();
  try {
    fixture.press("Enlarge image");
    fixture.requests[0].reject(new Error("Disconnected"));
    await fixture.settle();
    assert.match(visibleText(fixture.fullTree), /Could not load the full image/);
    fixture.press("Retry full image", fixture.fullTree);
    fixture.requests[1].resolve({ ok: false, error: "Image exceeds limit" });
    await fixture.settle();
    assert.match(visibleText(fixture.fullTree), /Image exceeds limit/);
    fixture.press("Retry full image", fixture.fullTree);
    fixture.requests[2].resolve({ ok: true, mimeType: "image/png", base64: "INVALID" });
    await fixture.settle();
    (descendants(fixture.fullTree)[0].props.onError as () => void)();
    fixture.render();
    assert.match(visibleText(fixture.fullTree), /Could not display the full image/);
    fixture.press("Open image in file preview", fixture.fullTree);
    assert.deepEqual(fixture.openedFiles, ["/tmp/one.png"]);
    assert.equal(fixture.fullTree, null);
  } finally { fixture.dispose(); }
});

test("horizontal swipes navigate without claiming vertical scroll or multiple touches", () => {
  const fixture = new GalleryFixture();
  try {
    const frame = descendants(fixture.tree).find((element) => element.props.onMoveShouldSetPanResponder)!;
    const shouldClaim = frame.props.onMoveShouldSetPanResponder as (event: unknown, gesture: unknown) => boolean;
    assert.equal(shouldClaim(null, { dx: -80, dy: 4, numberActiveTouches: 1 }), true);
    assert.equal(shouldClaim(null, { dx: 4, dy: -80, numberActiveTouches: 1 }), false);
    assert.equal(shouldClaim(null, { dx: -80, dy: 4, numberActiveTouches: 2 }), false);
    (frame.props.onPanResponderRelease as (event: unknown, gesture: unknown) => void)(null, { dx: -80, dy: 4 });
    fixture.render();
    assert.match(visibleText(fixture.tree), /2 \/ 3/);
  } finally { fixture.dispose(); }
});

test("changing a resolved file target or clearing an open gallery discards its full image and keyboard handler", async () => {
  const fixture = new GalleryFixture();
  try {
    fixture.press("Enlarge image");
    fixture.props.resolveFile = (href: string) => classifyLocalFileLink(href.replace("/tmp/", "/tmp/new-workspace/"));
    fixture.render();
    assert.equal(fixture.requests[1].path, "/tmp/new-workspace/one.png");
    fixture.requests[0].resolve({ ok: true, mimeType: "image/png", base64: "OLD_WORKSPACE" });
    await fixture.settle();
    assert.match(visibleText(fixture.fullTree), /Loading image/);
    fixture.props.images = [];
    fixture.render();
    assert.equal(fixture.tree, null);
    assert.equal(fixture.fullTree, null);
    assert.equal(keys.size, 0);
  } finally { fixture.dispose(); }
});

class ZoomFixture {
  scope = new HookScope();
  tree: unknown;
  navigation: number[] = [];
  props = { uri: "data:image/png;base64,IMAGE", label: "Screenshot", theme, onError: () => {}, onNavigate: (direction: number) => this.navigation.push(direction) };
  constructor() {
    this.render();
    this.call("onLayout", { nativeEvent: { layout: { width: 400, height: 300 } } });
  }
  render(): void { this.tree = this.scope.render(module.exports.ZoomableImage, this.props); }
  call(name: string, ...args: unknown[]): unknown {
    const element = descendants(this.tree).find((node) => typeof node.props[name] === "function");
    assert.ok(element, `Missing ${name}`);
    const result = (element.props[name] as (...args: unknown[]) => unknown)(...args);
    this.render();
    return result;
  }
  press(label: string): void {
    const node = descendants(this.tree).find((element) => element.props.accessibilityLabel === label)!;
    assert.ok(node && !node.props.disabled);
    (node.props.onPress as () => void)();
    this.render();
  }
  transform(): Array<{ translateX?: number; translateY?: number; scale?: number }> {
    return (descendants(this.tree).find((node) => (node.props.style as { pointerEvents?: string })?.pointerEvents === "none")!.props.style as { transform: Array<{ translateX?: number; translateY?: number; scale?: number }> }).transform;
  }
}
const touch = (...points: [number, number][]) => ({ nativeEvent: { touches: points.map(([locationX, locationY]) => ({ locationX, locationY })) } });

test("pinch owns the first finger at fit scale and responds as soon as the second finger moves", () => {
  const fixture = new ZoomFixture();
  try {
    const pinch = (): void => {
      // If an ancestor owns the first contact, responder negotiation for later
      // fingers starts at that ancestor and never reaches the image again.
      assert.equal(fixture.call("onStartShouldSetPanResponder", touch([150, 150])), true);
      fixture.call("onPanResponderGrant", touch([150, 150]));
      fixture.call("onPanResponderStart", touch([150, 150]));
      fixture.call("onPanResponderStart", touch([150, 150], [250, 150]));
      fixture.call("onPanResponderMove", touch([100, 150], [300, 150]));
      assert.match(visibleText(fixture.tree), /200%/);
      fixture.call("onPanResponderMove", touch([175, 150], [225, 150]));
      assert.match(visibleText(fixture.tree), /100%/);
      fixture.call("onPanResponderRelease", touch(), { dx: -900, dy: 0 });
      assert.deepEqual(fixture.navigation, []);
    };
    pinch();
    // Reacquire the gesture after pinching back to fit and after button reset.
    pinch();
    fixture.press("Zoom in");
    fixture.press("Reset zoom");
    pinch();
  } finally { fixture.scope.dispose(); }
});

test("pinch zoom anchors the midpoint, clamps scale and pan, and never changes images", () => {
  const fixture = new ZoomFixture();
  try {
    assert.equal(fixture.call("onStartShouldSetPanResponder", touch([150, 150], [250, 150])), true);
    fixture.call("onPanResponderGrant", touch([150, 150], [250, 150]));
    fixture.call("onPanResponderMove", touch([100, 150], [300, 150]));
    assert.match(visibleText(fixture.tree), /200%/);
    fixture.call("onPanResponderMove", touch([-1000, 150], [1400, 150]));
    assert.match(visibleText(fixture.tree), /500%/);
    fixture.call("onPanResponderMove", touch([100, 150]));
    fixture.call("onPanResponderMove", touch([10000, 10000]));
    assert.equal(fixture.transform()[0].translateX, 800);
    fixture.call("onPanResponderRelease", touch(), { dx: -900, dy: 0 });
    assert.deepEqual(fixture.navigation, []);
    fixture.press("Reset zoom");
    assert.match(visibleText(fixture.tree), /100%/);
    fixture.call("onPanResponderGrant", touch([150, 150], [250, 150]));
    fixture.call("onPanResponderMove", touch([195, 150], [205, 150]));
    fixture.call("onPanResponderRelease", touch(), { dx: -900, dy: 0 });
    assert.match(visibleText(fixture.tree), /100%/);
    assert.deepEqual(fixture.navigation, []);
  } finally { fixture.scope.dispose(); }
});

test("lifting one finger starts panning without losing its first movement or navigating", () => {
  const fixture = new ZoomFixture();
  try {
    fixture.call("onPanResponderGrant", touch([150, 150], [250, 150]));
    fixture.call("onPanResponderMove", touch([100, 150], [300, 150]));
    fixture.call("onPanResponderEnd", touch([300, 150]));
    fixture.call("onPanResponderMove", touch([350, 150]));
    assert.equal(fixture.transform()[0].translateX, 50);
    assert.match(visibleText(fixture.tree), /200%/);
    fixture.call("onPanResponderEnd", touch());
    fixture.call("onPanResponderRelease", touch(), { dx: -900, dy: 0 });
    assert.deepEqual(fixture.navigation, []);
  } finally { fixture.scope.dispose(); }
});

test("pinch reverses immediately after reaching either zoom limit without lifting fingers", () => {
  const fixture = new ZoomFixture();
  try {
    fixture.call("onPanResponderGrant", touch([150, 150], [250, 150]));
    fixture.call("onPanResponderMove", touch([100, 150], [300, 150]));
    fixture.call("onPanResponderMove", touch([190, 150], [210, 150]));
    assert.match(visibleText(fixture.tree), /100%/);
    fixture.call("onPanResponderMove", touch([180, 150], [220, 150]));
    assert.match(visibleText(fixture.tree), /200%/);
    fixture.call("onPanResponderMove", touch([-800, 150], [1200, 150]));
    assert.match(visibleText(fixture.tree), /500%/);
    fixture.call("onPanResponderMove", touch([-300, 150], [700, 150]));
    assert.match(visibleText(fixture.tree), /250%/);
    fixture.call("onPanResponderRelease", touch(), { dx: -900, dy: 0 });
    assert.deepEqual(fixture.navigation, []);
  } finally { fixture.scope.dispose(); }
});

test("zoom controls and dragging preserve carousel navigation only at fit scale", () => {
  const fixture = new ZoomFixture();
  try {
    fixture.press("Zoom in");
    fixture.call("onPanResponderGrant", touch([200, 150]));
    fixture.call("onPanResponderMove", touch([10000, -10000]));
    assert.equal(fixture.transform()[0].translateX, 200);
    assert.equal(fixture.transform()[1].translateY, -50);
    fixture.call("onPanResponderRelease", touch(), { dx: -900, dy: 0 });
    assert.deepEqual(fixture.navigation, []);
    fixture.press("Zoom out");
    assert.match(visibleText(fixture.tree), /100%/);
    fixture.call("onPanResponderGrant", touch([200, 150]));
    fixture.call("onPanResponderRelease", touch(), { dx: -80, dy: 4 });
    assert.deepEqual(fixture.navigation, [1]);
    fixture.press("Zoom in");
    fixture.call("onLayout", { nativeEvent: { layout: { width: 300, height: 400 } } });
    assert.match(visibleText(fixture.tree), /100%/);
    assert.equal(fixture.transform()[0].translateX, 0);
  } finally { fixture.scope.dispose(); }
});

test("an off-center pinch keeps the same image point under the fingers", () => {
  const fixture = new ZoomFixture();
  try {
    fixture.call("onPanResponderGrant", touch([100, 150], [200, 150]));
    fixture.call("onPanResponderMove", touch([50, 150], [250, 150]));
    assert.match(visibleText(fixture.tree), /200%/);
    assert.equal(fixture.transform()[0].translateX, 50);
    assert.equal(fixture.transform()[1].translateY, 0);
  } finally { fixture.scope.dispose(); }
});
