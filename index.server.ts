import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  loadCommentsRpc,
  openInBrowserRpc,
  saveCommentsRpc,
} from "./shared/review";
import {
  loadComments,
  openInBrowser,
  saveComments,
} from "./server/review";

export default function contribute(server: PluginServerContext) {
  server.handle(loadCommentsRpc, loadComments);
  server.handle(saveCommentsRpc, saveComments);
  server.handle(openInBrowserRpc, openInBrowser);
  return () => {};
}
