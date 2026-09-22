import { Platform } from "react-native";

interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<WritableFile>;
}

interface DesktopHost {
  opener?: {
    openUrl?(url: string): Promise<void> | void;
  };
}

type WebGlobals = typeof globalThis & {
  atob?(value: string): string;
  showSaveFilePicker?(options: { suggestedName: string }): Promise<SaveFileHandle>;
  /** Electron preload bridge exposed by Paseo Desktop. */
  paseoDesktop?: DesktopHost;
  open?(url: string, target?: string, features?: string): unknown;
};

export class DownloadCancelledError extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "DownloadCancelledError";
  }
}

export interface ProgressiveDownload {
  writeBase64(value: string): Promise<number>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Opens an external URL on web clients. Paseo Desktop's preload bridge sends
 * it to the system browser; ordinary browser clients open a new tab. Native
 * callers return false so React Native Linking can handle the URL instead.
 */
export async function openExternalUrlOnWeb(url: string): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  const web = globalThis as WebGlobals;
  const desktopOpenUrl = web.paseoDesktop?.opener?.openUrl;
  if (typeof desktopOpenUrl === "function") {
    await desktopOpenUrl(url);
    return true;
  }
  if (typeof web.open === "function") {
    web.open?.(url, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}

/** Opens the destination before any file data crosses the RPC boundary. */
export async function openProgressiveDownload(fileName: string): Promise<ProgressiveDownload> {
  const web = globalThis as WebGlobals;
  if (Platform.OS !== "web" || !web.showSaveFilePicker || !web.atob) {
    throw new Error("Progressive downloads are not supported on this platform");
  }

  let handle: SaveFileHandle;
  try {
    handle = await web.showSaveFilePicker({ suggestedName: fileName });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DownloadCancelledError();
    }
    throw error;
  }
  const writable = await handle.createWritable();
  return {
    async writeBase64(value: string): Promise<number> {
      const binary = web.atob!(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      await writable.write(bytes);
      return bytes.byteLength;
    },
    close: () => writable.close(),
    async abort(): Promise<void> {
      if (writable.abort) await writable.abort();
      else await writable.close();
    },
  };
}
