import { execFile } from "node:child_process";
import type { RpcInput } from "@getpaseo/plugin";
import { isValidHttpUrl, openInBrowserRpc } from "../shared/review";

/**
 * Opens an HTTP(S) URL with the daemon machine's default browser, so links get
 * full browser chrome (address bar, tabs, extensions) instead of an embedded
 * frame. Only HTTP(S) is allowed.
 */
export function openInBrowser({ url }: RpcInput<typeof openInBrowserRpc>): Promise<{ ok: boolean }> {
  if (!isValidHttpUrl(url)) return Promise.resolve({ ok: false });
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    execFile(command, args, (error) => {
      resolve({ ok: !error });
    });
  });
}
