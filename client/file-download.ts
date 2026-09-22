import {
  FILE_TRANSFER_CHUNK_BYTES,
  MAX_DOWNLOAD_BYTES,
} from "../shared/review";
import { openProgressiveDownload } from "./web";

type OpenFile = (input: {
  path: string;
  mode: "download";
  offset: number;
  length: number;
  fileVersion?: string;
}) => Promise<{
  ok: boolean;
  error?: string;
  base64?: string;
  done?: boolean;
  size?: number;
  fileVersion?: string;
}>;

/** Transfers at most 5 MB at a time and writes each decoded chunk immediately. */
export async function downloadLocalFileProgressively({
  path,
  openFile,
  onProgress,
}: {
  path: string;
  openFile: OpenFile;
  onProgress?(progress: number | null): void;
}): Promise<number> {
  const fileName = path.split(/[\\/]/).pop() || "download";
  const destination = await openProgressiveDownload(fileName);
  let offset = 0;
  let expectedSize: number | null = null;
  let fileVersion: string | undefined;

  try {
    for (;;) {
      const result = await openFile({
        path,
        mode: "download",
        offset,
        length: FILE_TRANSFER_CHUNK_BYTES,
        fileVersion,
      });
      if (!result.ok || result.base64 === undefined) {
        throw new Error(result.error ?? "Could not download the file");
      }
      if (!Number.isSafeInteger(result.size) || (result.size ?? -1) < 0) {
        throw new Error("The daemon returned an invalid file size");
      }
      if (expectedSize === null) expectedSize = result.size!;
      else if (result.size !== expectedSize) throw new Error("The file changed during download");
      if (!result.fileVersion) throw new Error("The daemon did not identify the download source");
      if (fileVersion === undefined) fileVersion = result.fileVersion;
      else if (result.fileVersion !== fileVersion) throw new Error("The file changed during download");
      if (expectedSize > MAX_DOWNLOAD_BYTES) throw new Error("File exceeds the download cap");

      const written = await destination.writeBase64(result.base64);
      offset += written;
      onProgress?.(expectedSize > 0 ? Math.min(1, offset / expectedSize) : 1);
      if (result.done) break;
      if (written === 0) throw new Error("The daemon returned an empty download chunk");
      if (offset > MAX_DOWNLOAD_BYTES) throw new Error("File exceeds the download cap");
    }
    await destination.close();
    onProgress?.(null);
    return expectedSize ?? 0;
  } catch (error) {
    onProgress?.(null);
    try {
      await destination.abort();
    } catch {
      // Preserve the transfer error; abort is best-effort cleanup.
    }
    throw error;
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
