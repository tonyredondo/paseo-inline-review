import type { PluginServerContext } from "@getpaseo/plugin/server";
import { wideFrameSettings } from "./shared/wide-frame-settings";
import {
  loadCommentsRpc,
  localImagePreviewRpc,
  openLocalFileRpc,
  saveCommentsRpc,
  saveCommentDeltaRpc,
  syncCommentsRpc,
} from "./shared/review";
import {
  loadComments,
  localImagePreview,
  openLocalFile,
  saveComments,
  saveCommentDelta,
  syncComments,
} from "./server/review";
import { imagePreviewService } from "./server/image-preview";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(wideFrameSettings);
  server.handle(loadCommentsRpc, loadComments);
  server.handle(saveCommentsRpc, saveComments);
  server.handle(saveCommentDeltaRpc, saveCommentDelta);
  server.handle(syncCommentsRpc, syncComments);
  server.handle(localImagePreviewRpc, localImagePreview);
  server.handle(openLocalFileRpc, openLocalFile);
  return () => imagePreviewService.dispose();
}
