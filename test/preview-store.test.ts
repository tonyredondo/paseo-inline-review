import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearPreview,
  getPreviewTarget,
  openFileTab,
  registerFileTabOpener,
  requestPreview,
  subscribe,
} from "../client/preview-store.ts";

test("preview targets retain their workspace and agent ownership", () => {
  let notifications = 0;
  const unsubscribe = subscribe(() => {
    notifications += 1;
  });
  const { panelId, target } = requestPreview(
    "/tmp/file.ts",
    "workspace-1",
    "agent-1",
    10,
    12,
  );
  assert.equal(target.workspaceId, "workspace-1");
  assert.equal(target.agentId, "agent-1");
  assert.equal(getPreviewTarget(panelId)?.path, "/tmp/file.ts");
  clearPreview(panelId);
  assert.equal(getPreviewTarget(panelId), null);
  assert.equal(notifications, 2);
  unsubscribe();
});

test("file-tab opener cleanup removes the retained client callback", () => {
  let calls = 0;
  const unregister = registerFileTabOpener(() => {
    calls += 1;
  });
  openFileTab("/tmp/a.ts", undefined, undefined, "workspace", "agent");
  unregister();
  openFileTab("/tmp/b.ts", undefined, undefined, "workspace", "agent");
  assert.equal(calls, 1);
});
