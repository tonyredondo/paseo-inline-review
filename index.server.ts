import type { PluginServerContext } from "@getpaseo/plugin/server";
import { wideFrameSettings } from "./shared/wide-frame-settings";
import {
  loadCommentsRpc,
  openInBrowserRpc,
  openLocalFileRpc,
  saveCommentsRpc,
} from "./shared/review";
import {
  loadComments,
  openInBrowser,
  openLocalFile,
  saveComments,
} from "./server/review";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(wideFrameSettings);
  server.handle(loadCommentsRpc, loadComments);
  server.handle(saveCommentsRpc, saveComments);
  server.handle(openInBrowserRpc, openInBrowser);
  server.handle(openLocalFileRpc, openLocalFile);
  return () => {};
}
