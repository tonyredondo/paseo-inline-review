import type { PluginServerContext } from "@getpaseo/plugin/server";
import { wideFrameSettings } from "./shared/wide-frame-settings";
import {
  getTurnFinalRpc,
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
import { getTurnFinalIds, noteTurnEnded } from "./server/turns";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(wideFrameSettings);
  server.handle(loadCommentsRpc, loadComments);
  server.handle(saveCommentsRpc, saveComments);
  server.handle(openInBrowserRpc, openInBrowser);
  server.handle(openLocalFileRpc, openLocalFile);
  server.handle(getTurnFinalRpc, (input) => ({
    finalIds: getTurnFinalIds(input.agentId),
  }));
  // Turn-final index: the host reports each ended turn with its timeline
  // snapshot; the last assistant messageId in it is the turn-final message.
  server.on("agent.turn_ended", (event) => {
    noteTurnEnded(event.agent.id, event.turnId, event.timeline);
  });
  return () => {};
}
