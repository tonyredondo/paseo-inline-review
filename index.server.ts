import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  draftSearchRpc,
  loadCommentsRpc,
  openInBrowserRpc,
  saveCommentsRpc,
  setActiveAgentRpc,
} from "./shared/review";
import {
  loadComments,
  openInBrowser,
  saveComments,
  searchDrafts,
  setActiveAgentHandler,
} from "./server/review";

export default function contribute(server: PluginServerContext) {
  server.handle(loadCommentsRpc, loadComments);
  server.handle(saveCommentsRpc, saveComments);
  server.handle(draftSearchRpc, searchDrafts);
  server.handle(openInBrowserRpc, openInBrowser);
  server.handle(setActiveAgentRpc, setActiveAgentHandler);
  return () => {};
}
