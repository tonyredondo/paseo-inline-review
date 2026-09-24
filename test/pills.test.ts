import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import { test } from "node:test";

import { build } from "esbuild";

async function loadRegisterPills(): Promise<(client: any) => () => Promise<void>> {
  const result = await build({
    absWorkingDir: path.resolve("."),
    bundle: true,
    entryPoints: ["client/pills.tsx"],
    format: "esm",
    jsx: "automatic",
    platform: "node",
    write: false,
    plugins: [{
      name: "react-native-test-stub",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^react-native$/ }, () => ({
          path: "react-native",
          namespace: "pills-test",
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "pills-test" }, () => ({
          contents: `export const AppState = {
            currentState: "active",
            addEventListener() { return { remove() {} }; },
          };`,
          loader: "js",
        }));
      },
    }],
  });
  const source = result.outputFiles?.[0]?.contents;
  if (!source) throw new Error("Could not build pills test module");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return module.registerPills;
}

test("a delayed agent list cannot register pills after plugin cleanup", async () => {
  const registerPills = await loadRegisterPills();
  let resolveList: ((result: unknown) => void) | null = null;
  let notifyAgent: ((update: any) => void) | null = null;
  let added = 0;
  let removed = 0;
  const list = new Promise((resolve) => { resolveList = resolve; });
  const client = {
    addComposerPill() {
      added += 1;
      return { remove() { removed += 1; }, update() {} };
    },
    openPanel() {},
    rpc: async () => ({ epoch: "epoch", buckets: [] }),
    paseo: {
      agents: {
        list: () => list,
        ref: () => ({ send: async () => {} }),
        subscribe: (handler: (update: any) => void) => {
          notifyAgent = handler;
          return () => {};
        },
      },
    },
  };

  const cleanup = registerPills(client);
  await cleanup();
  (resolveList as unknown as (result: unknown) => void)({
    entries: [{ agent: { id: "late-agent", workspaceId: "workspace" } }],
  });
  (notifyAgent as unknown as (update: unknown) => void)({
    kind: "upsert",
    agent: { id: "late-subscription-agent", workspaceId: "workspace" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(added, 0);
  assert.equal(removed, 0);
});
