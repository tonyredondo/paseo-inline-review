import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { IMAGE_THUMBNAIL_MAX_BYTES } from "../shared/review.ts";

export type ImagePreviewResult = {
  ok: boolean;
  error?: string;
  fileVersion?: string;
  originalSize?: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  mimeType?: string;
  base64?: string;
  thumbnailSize?: number;
  unchanged?: boolean;
};

export type ImageProcessor = (
  path: string,
  input: { maxEdge: number; quality: number; maxBytes: number },
) => Promise<{
  buffer: Buffer;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}>;

type QueueItem = {
  run(): Promise<void>;
  resolve(result: ImagePreviewResult): void;
};

const SUPPORTED_SIGNATURE_BYTES = 12;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function versionOf(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

function supportedImageSignature(header: Buffer): boolean {
  if (header.length >= 8 && header[0] === 0x89 && header.subarray(1, 4).toString("ascii") === "PNG") return true;
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
  const gif = header.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") return true;
  return header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
}

async function hasSupportedSignature(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SUPPORTED_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return supportedImageSignature(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

type SipsInfo = { width: number; height: number; hasAlpha: boolean };

function parseSipsInfo(stdout: string): SipsInfo {
  const width = /pixelWidth:\s*(\d+)/i.exec(stdout)?.[1];
  const height = /pixelHeight:\s*(\d+)/i.exec(stdout)?.[1];
  if (!width || !height) throw new Error("Could not determine image dimensions");
  return {
    width: Number(width),
    height: Number(height),
    hasAlpha: /hasAlpha:\s*yes/i.test(stdout),
  };
}

async function readSipsInfo(path: string): Promise<SipsInfo> {
  const { stdout } = await execFileAsync(
    "/usr/bin/sips",
    ["--getProperty", "pixelWidth", "--getProperty", "pixelHeight", "--getProperty", "hasAlpha", path],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  return parseSipsInfo(stdout);
}

/**
 * Paseo Desktop currently runs its daemon on macOS. Using the platform image
 * tool avoids shipping a native Node addon, whose optional binary was not
 * loadable from a clean plugin install. Other daemon platforms fail explicitly
 * so the client can keep the existing full-image action available.
 */
export const platformImageProcessor: ImageProcessor = async (path, input) => {
  if (process.platform !== "darwin") {
    throw new Error("Local thumbnails are unavailable on this daemon platform; open the full image instead");
  }

  // sips deliberately produces a static first-frame preview for animated input.
  const original = await readSipsInfo(path);
  const directory = await mkdtemp(join(tmpdir(), "inline-review-thumbnail-"));
  try {
    const format = original.hasAlpha ? "png" : "jpeg";
    const mimeType = original.hasAlpha ? "image/png" : "image/jpeg";
    const outputPath = join(directory, `thumbnail.${format === "jpeg" ? "jpg" : "png"}`);
    let edge = Math.min(input.maxEdge, Math.max(original.width, original.height));
    let quality = input.quality;
    let output: Buffer | null = null;
    let outputInfo: SipsInfo | null = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const formatOptions = format === "jpeg"
        ? ["--setProperty", "formatOptions", String(quality)]
        : [];
      await execFileAsync(
        "/usr/bin/sips",
        [
          "--resampleHeightWidthMax", String(edge),
          "--setProperty", "format", format,
          ...formatOptions,
          path,
          "--out", outputPath,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      output = await readFile(outputPath);
      const scale = Math.min(1, edge / Math.max(original.width, original.height));
      outputInfo = {
        width: Math.max(1, Math.round(original.width * scale)),
        height: Math.max(1, Math.round(original.height * scale)),
        hasAlpha: original.hasAlpha,
      };
      if (output.byteLength <= input.maxBytes) break;
      if (format === "jpeg" && quality > 45) quality = Math.max(45, quality - 12);
      else edge = Math.max(64, Math.floor(edge * 0.72));
    }

    if (!output || !outputInfo || output.byteLength > input.maxBytes) {
      throw new Error(`Could not create a thumbnail below ${input.maxBytes} bytes`);
    }
    return {
      buffer: output,
      mimeType,
      originalWidth: original.width,
      originalHeight: original.height,
      width: outputInfo.width,
      height: outputInfo.height,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export function createImagePreviewService({
  processor = platformImageProcessor,
  concurrency = 2,
  cacheBytes = 32 * 1024 * 1024,
}: {
  processor?: ImageProcessor;
  concurrency?: number;
  cacheBytes?: number;
} = {}) {
  const cache = new Map<string, ImagePreviewResult>();
  const cacheSizes = new Map<string, number>();
  const inFlight = new Map<string, Promise<ImagePreviewResult>>();
  const queue: QueueItem[] = [];
  let active = 0;
  let cachedBytes = 0;
  let disposed = false;
  let hits = 0;
  let misses = 0;
  let maxActive = 0;

  function cacheResult(key: string, result: ImagePreviewResult): void {
    if (!result.ok || !result.thumbnailSize) return;
    const retainedBytes = result.base64?.length ?? result.thumbnailSize;
    cache.set(key, result);
    cacheSizes.set(key, retainedBytes);
    cachedBytes += retainedBytes;
    while (cachedBytes > cacheBytes && cache.size > 0) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
      cachedBytes -= cacheSizes.get(oldest) ?? 0;
      cacheSizes.delete(oldest);
    }
  }

  function drain(): void {
    while (!disposed && active < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      active += 1;
      maxActive = Math.max(maxActive, active);
      void item.run().finally(() => {
        active -= 1;
        drain();
      });
    }
  }

  async function generate(
    path: string,
    fileVersion: string,
    originalSize: number,
    maxEdge: number,
    quality: number,
  ): Promise<ImagePreviewResult> {
    if (!(await hasSupportedSignature(path))) return { ok: false, error: "Unsupported local image format" };
    const processed = await processor(path, { maxEdge, quality, maxBytes: IMAGE_THUMBNAIL_MAX_BYTES });
    if (processed.buffer.byteLength > IMAGE_THUMBNAIL_MAX_BYTES) {
      return { ok: false, error: "Generated thumbnail exceeds the configured byte limit" };
    }
    const after = await stat(path);
    if (versionOf(after) !== fileVersion) return { ok: false, error: "The image changed while it was being processed" };
    return {
      ok: true,
      fileVersion,
      originalSize,
      originalWidth: processed.originalWidth,
      originalHeight: processed.originalHeight,
      width: processed.width,
      height: processed.height,
      mimeType: processed.mimeType,
      base64: processed.buffer.toString("base64"),
      thumbnailSize: processed.buffer.byteLength,
    };
  }

  async function request(input: {
    path: string;
    maxEdge?: number;
    quality?: number;
    knownFileVersion?: string;
  }): Promise<ImagePreviewResult> {
    if (disposed) return { ok: false, error: "Image preview service is disposed" };
    try {
      const stats = await stat(input.path);
      if (!stats.isFile()) return { ok: false, error: "Path is not a regular file" };
      if (stats.size > MAX_SOURCE_BYTES) return { ok: false, error: "Image is larger than the 100 MB processing limit", originalSize: stats.size };
      const fileVersion = versionOf(stats);
      const maxEdge = Math.min(1280, Math.max(64, input.maxEdge ?? 640));
      const quality = Math.min(95, Math.max(35, input.quality ?? 78));
      const key = `${fileVersion}:${maxEdge}:${quality}`;
      const cached = cache.get(key);
      if (cached) {
        hits += 1;
        cache.delete(key);
        cache.set(key, cached);
        return input.knownFileVersion === fileVersion
          ? { ...cached, base64: undefined, unchanged: true }
          : cached;
      }
      const current = inFlight.get(key);
      if (current) {
        hits += 1;
        return current;
      }
      misses += 1;
      const operation = new Promise<ImagePreviewResult>((resolve) => {
        const item: QueueItem = {
          resolve,
          async run() {
            let result: ImagePreviewResult;
            try {
              result = await generate(input.path, fileVersion, stats.size, maxEdge, quality);
            } catch (error) {
              result = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            if (!disposed) cacheResult(key, result);
            resolve(result);
          },
        };
        queue.push(item);
        drain();
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, operation);
      return operation;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function dispose(): void {
    disposed = true;
    for (const item of queue.splice(0)) item.resolve({ ok: false, error: "Image preview service is disposed" });
    cache.clear();
    cacheSizes.clear();
    cachedBytes = 0;
  }

  return {
    request,
    dispose,
    diagnostics: () => ({ active, queued: queue.length, cacheEntries: cache.size, cachedBytes, hits, misses, maxActive }),
  };
}

export const imagePreviewService = createImagePreviewService();
