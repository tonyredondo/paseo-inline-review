import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  draftSearchRpc,
  loadCommentsRpc,
  openInBrowserRpc,
  saveCommentsRpc,
} from "./shared/review";
import {
  loadComments,
  openInBrowser,
  saveComments,
  searchDrafts,
} from "./server/review";

export default function contribute(server: PluginServerContext) {
  server.handle(loadCommentsRpc, loadComments);
  server.handle(saveCommentsRpc, saveComments);
  server.handle(draftSearchRpc, searchDrafts);
  server.handle(openInBrowserRpc, openInBrowser);
  return () => {};
}
