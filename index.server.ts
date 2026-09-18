import type { PluginServerContext } from "@getpaseo/plugin/server";
import { openInBrowserRpc } from "./shared/review";
import { openInBrowser } from "./server/review";

export default function contribute(server: PluginServerContext) {
  server.handle(openInBrowserRpc, openInBrowser);
  return () => {};
}
