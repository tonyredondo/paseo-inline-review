import { gzipSync } from "node:zlib";

import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const baselineRawBytes = 216_783;
const baselineGzipBytes = 45_806;
const daemonUrl = process.env.PASEO_DAEMON_URL ?? "ws://127.0.0.1:6767/ws";
const client = new DaemonClient({
  url: daemonUrl,
  clientId: `inline-review-size-${process.pid}`,
  clientType: "cli",
  reconnect: { enabled: false },
});

try {
  await client.connect();
  const plugins = await client.getPluginCatalog();
  const plugin = plugins.find((candidate) => candidate.id === "inline-review");
  if (!plugin || typeof plugin.clientBundle !== "string") {
    throw new Error("The installed inline-review client bundle is unavailable");
  }
  const rawBytes = Buffer.byteLength(plugin.clientBundle);
  const gzipBytes = gzipSync(plugin.clientBundle).byteLength;
  const rawGrowthPercent = ((rawBytes / baselineRawBytes) - 1) * 100;
  const gzipGrowthPercent = ((gzipBytes / baselineGzipBytes) - 1) * 100;
  process.stdout.write(`${JSON.stringify({
    kind: "installed-client-bundle-size",
    rawBytes,
    gzipBytes,
    baselineRawBytes,
    baselineGzipBytes,
    rawGrowthPercent,
    gzipGrowthPercent,
    warning: rawGrowthPercent > 10 || gzipGrowthPercent > 10,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
