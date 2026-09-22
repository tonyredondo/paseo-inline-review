import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const testDirectory = dirname(fileURLToPath(import.meta.url));

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
    .replace(/import \{ useEffect, useRef, useState \}[^;]+;/, `
      const useEffect = (effect: () => void | (() => void)) => {
        const cleanup = effect();
        if (typeof cleanup === "function") globalThis.__wideFrameCleanups.push(cleanup);
      };
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
