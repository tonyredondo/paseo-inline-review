import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

type Element = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> };
type Slot = { value?: unknown; cleanup?: () => void };
const timers = new Map<number, { callback(): void; delay: number }>();
let nextTimer = 0;
const bridge = {
  current: null as Fixture | null,
  platform: { OS: "ios" },
  errors: [] as string[],
  copy: (_text: string): Promise<void> => Promise.reject(new Error("Missing fixture")),
};
const hostModules: Record<string, string> = {
  react: `export const Fragment='Fragment', memo=fn=>fn, useMemo=fn=>fn(), useCallback=fn=>fn;
    export const useState=value=>__bridge.current.state(value), useRef=value=>__bridge.current.ref(value);
    export const useEffect=effect=>__bridge.current.effect(effect), useLayoutEffect=useEffect;
    export const useSyncExternalStore=(_subscribe,snapshot)=>snapshot();`,
  "react/jsx-runtime": "export const Fragment='Fragment', jsx=(type,props)=>({type,props}), jsxs=jsx;",
  "react-native": `export const View='View', Text='Text', Pressable='Pressable', Image='Image', ScrollView='ScrollView', Modal='Modal', SafeAreaView='SafeAreaView', ActivityIndicator='ActivityIndicator';
    export const Platform=__bridge.platform, StyleSheet={hairlineWidth:1,create:v=>v}, PanResponder={create:v=>({panHandlers:v})}, Linking={openURL:()=>{}};`,
  "@getpaseo/plugin": "export const defineRpc=v=>v, defineSettings=v=>v;",
  "@getpaseo/plugin/client": "export const useRpc=()=>{}, usePaseo=()=>{}, useAgent=()=>{}, useSettings=()=>{};",
  "@getpaseo/plugin/client/react-native": `export const copyText=text=>__bridge.copy(text), useToast=()=>({error:message=>__bridge.errors.push(message)});
    export const Icon='Icon', Modal='Modal', TextInput='TextInput', FlatList='FlatList', useRevealedText=text=>text;`,
};
const bundle = await build({
  stdin: { contents: 'export { UserMessageCard } from "./client/timeline";', resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  plugins: [{ name: "user-copy-host", setup(builder) {
    // Export the private component only in this test bundle.
    builder.onLoad({ filter: /client\/timeline\.tsx$/ }, args => ({
      contents: readFileSync(args.path, "utf8").replace("function UserMessageCard(", "export function UserMessageCard("), loader: "tsx",
    }));
    builder.onResolve({ filter: /^(react|react-native|@getpaseo\/plugin)(\/.*)?$/ }, args => ({ path: args.path, namespace: "host" }));
    builder.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: hostModules[args.path], loader: "js" }));
  } }],
});
const module = { exports: {} as { UserMessageCard(props: Record<string, unknown>): unknown } };
runInNewContext(`(function(module,exports){${bundle.outputFiles[0].text}})(module,module.exports);`, {
  module, __bridge: bridge, URL,
  setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id: number) { timers.delete(id); },
});
function descendants(tree: unknown): Element[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(descendants);
  const node = tree as Element;
  return [node, ...descendants(node.props.children)];
}
class Fixture {
  slots: Slot[] = [];
  cursor = 0;
  tree: unknown;
  requests: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  props: Record<string, unknown>;
  constructor(text: string, compact = true) {
    bridge.errors = []; timers.clear();
    bridge.copy = text => new Promise<void>((resolve, reject) => this.requests.push({ text, resolve, reject }));
    this.props = { item: { data: { messageId: "m", text } }, timestamp: new Date(0), layout: { platform: bridge.platform.OS, compact }, theme: { colors: new Proxy({}, { get: () => "#aaaaaa" }) } };
    this.render();
  }
  state(initial: unknown): [unknown, (value: unknown) => void] {
    const slot = this.slots[this.cursor++] ??= { value: initial };
    return [slot.value, value => { slot.value = value; }];
  }
  ref(initial: unknown): unknown { return (this.slots[this.cursor++] ??= { value: { current: initial } }).value; }
  effect(effect: () => () => void): void {
    const index = this.cursor++;
    if (!this.slots[index]) this.slots[index] = { cleanup: effect() };
  }
  render(): void {
    this.cursor = 0; bridge.current = this;
    try { this.tree = module.exports.UserMessageCard(this.props); } finally { bridge.current = null; }
  }
  button(): Element { return descendants(this.tree).find(node => node.props.accessibilityLabel === "Copy user message")!; }
  copied(): boolean { return descendants(this.tree).some(node => node.props.children === "Copied"); }
  press(): void { (this.button().props.onPress as () => void)(); }
  async settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); this.render(); }
  dispose(): void { this.slots.forEach(slot => slot.cleanup?.()); }
}

test("phone and tablet user cards copy the original Markdown and confirm only clipboard success", async () => {
  const text = '**Hola**\n\n```ts\nconst price = "20 €";\n```';
  for (const OS of ["ios", "android"]) for (const compact of [true, false]) {
    bridge.platform.OS = OS;
    const fixture = new Fixture(text, compact);
    try {
      assert.ok(fixture.button());
      assert.equal((fixture.button().props.style as { minHeight: number }).minHeight, 44);
      fixture.press();
      assert.equal(fixture.requests[0].text, text);
      assert.equal(fixture.copied(), false);
      fixture.requests[0].resolve(); await fixture.settle();
      assert.equal(fixture.copied(), true);
      assert.equal(timers.values().next().value?.delay, 1600);
      for (const [id, timer] of timers) { timers.delete(id); timer.callback(); }
      fixture.render();
      assert.equal(fixture.copied(), false);
    } finally { fixture.dispose(); }
  }
});

test("clipboard rejection keeps the copy action available and reports the failure", async () => {
  const fixture = new Fixture("Message");
  try {
    fixture.press(); fixture.requests[0].reject(new Error("Clipboard denied")); await fixture.settle();
    assert.equal(fixture.copied(), false);
    assert.deepEqual(bridge.errors, ["Could not copy the message."]);
    assert.equal(timers.size, 0);
    fixture.press(); fixture.requests[1].resolve(); await fixture.settle();
    assert.equal(fixture.copied(), true);
  } finally { fixture.dispose(); }
});

test("repeated copies reset feedback and unmount cancels timers and late clipboard feedback", async () => {
  const fixture = new Fixture("First");
  fixture.press(); fixture.requests[0].resolve(); await fixture.settle();
  const firstTimer = timers.keys().next().value;
  fixture.props.item = { data: { messageId: "m", text: "Edited" } }; fixture.render();
  fixture.press(); fixture.requests[1].resolve(); await fixture.settle();
  assert.equal(fixture.requests[1].text, "Edited");
  assert.equal(timers.has(firstTimer!), false);
  assert.equal(timers.size, 1);
  fixture.press(); fixture.dispose();
  assert.equal(timers.size, 0);
  fixture.requests[2].resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
});
