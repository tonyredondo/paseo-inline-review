import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { parseBlocks } from "./markdown-parse.ts";

/** Data carried by the plugin-owned replacement of an assistant message. */
export const reviewItemSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export type ReviewItemData = z.output<typeof reviewItemSchema>;

export const codeLineAnchorSchema = z.object({
  /** Code-block index inside the stable paragraph snapshot. */
  blockIndex: z.number().int().nonnegative(),
  /** Zero-based source line inside the fenced/indented code block. */
  lineIndex: z.number().int().nonnegative(),
  lineText: z.string(),
  /** Nearest source lines, stored in document order to disambiguate duplicates. */
  contextBefore: z.array(z.string()).max(4),
  contextAfter: z.array(z.string()).max(4),
});

export type CodeLineAnchor = z.output<typeof codeLineAnchorSchema>;

export const reviewCommentSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  messageId: z.string().nullable(),
  /** Zero-based paragraph index inside the commented assistant message. */
  paragraphIndex: z.number().int(),
  /**
   * When the comment targets one markdown list item: zero-based index of that
   * item inside its list block. Null/absent = the whole paragraph.
   */
  itemIndex: z.number().int().nullable().optional(),
  /** A precise source-line target inside this paragraph's Markdown code block. */
  codeAnchor: codeLineAnchorSchema.nullable().optional(),
  /** Snapshot of the commented paragraph, used for quoting and anchoring. */
  paragraphText: z.string(),
  text: z.string(),
  createdAt: z.string(),
  /** Monotonic per-comment version used to reject stale device writes. */
  revision: z.number().int().nonnegative().default(0),
  /** Last local mutation time; breaks equal-revision conflicts deterministically. */
  updatedAt: z.string().optional(),
  /** Mounted renderer identity while a streaming message has no messageId yet. */
  sourceKey: z.string().nullable().optional(),
  /** pending = will be attached to the next message; sent = already context. */
  status: z.enum(["pending", "sent"]),
});

export type ReviewComment = z.output<typeof reviewCommentSchema>;

const CODE_CONTEXT_RADIUS = 2;

export function createCodeLineAnchor(
  code: string,
  blockIndex: number,
  lineIndex: number,
  contextRadius = CODE_CONTEXT_RADIUS,
): CodeLineAnchor {
  const lines = code.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new RangeError(`Code line ${lineIndex} is outside the ${lines.length}-line block.`);
  }
  const radius = Math.max(0, Math.min(4, contextRadius));
  return {
    blockIndex,
    lineIndex,
    lineText: lines[lineIndex],
    contextBefore: lines.slice(Math.max(0, lineIndex - radius), lineIndex),
    contextAfter: lines.slice(lineIndex + 1, lineIndex + 1 + radius),
  };
}

export function sameCodeLineAnchor(
  a: CodeLineAnchor | null | undefined,
  b: CodeLineAnchor | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.blockIndex === b.blockIndex &&
    a.lineIndex === b.lineIndex &&
    a.lineText === b.lineText &&
    a.contextBefore.length === b.contextBefore.length &&
    a.contextBefore.every((line, index) => line === b.contextBefore[index]) &&
    a.contextAfter.length === b.contextAfter.length &&
    a.contextAfter.every((line, index) => line === b.contextAfter[index])
  );
}

function codeAnchorContextScore(lines: string[], lineIndex: number, anchor: CodeLineAnchor): number {
  let score = 0;
  for (let index = 0; index < anchor.contextBefore.length; index += 1) {
    const offset = anchor.contextBefore.length - index;
    if (lines[lineIndex - offset] === anchor.contextBefore[index]) score += 1;
  }
  for (let index = 0; index < anchor.contextAfter.length; index += 1) {
    if (lines[lineIndex + index + 1] === anchor.contextAfter[index]) score += 1;
  }
  return score;
}

/** Re-finds one selected source line after streaming inserts or re-chunks text. */
export function locateCodeLineAnchor(paragraph: string, anchor: CodeLineAnchor): CodeLineAnchor | null {
  const candidates: Array<{
    code: string;
    blockIndex: number;
    lineIndex: number;
    contextScore: number;
    sameBlock: boolean;
    distance: number;
  }> = [];
  let codeBlockIndex = 0;
  for (const block of parseBlocks(paragraph)) {
    if (block.kind !== "code") continue;
    const lines = block.text.split("\n");
    for (const [lineIndex, line] of lines.entries()) {
      if (line !== anchor.lineText) continue;
      candidates.push({
        code: block.text,
        blockIndex: codeBlockIndex,
        lineIndex,
        contextScore: codeAnchorContextScore(lines, lineIndex, anchor),
        sameBlock: codeBlockIndex === anchor.blockIndex,
        distance: Math.abs(codeBlockIndex - anchor.blockIndex) + Math.abs(lineIndex - anchor.lineIndex),
      });
    }
    codeBlockIndex += 1;
  }
  candidates.sort((a, b) =>
    b.contextScore - a.contextScore ||
    Number(b.sameBlock) - Number(a.sameBlock) ||
    a.distance - b.distance ||
    a.blockIndex - b.blockIndex ||
    a.lineIndex - b.lineIndex,
  );
  const winner = candidates[0];
  if (!winner) return null;
  const storedContextLines = anchor.contextBefore.length + anchor.contextAfter.length;
  // A matching line with wholly different neighbours is more likely another
  // occurrence than the original target. Leave the comment unattached rather
  // than silently moving it to unrelated code.
  if (storedContextLines > 0 && winner.contextScore === 0) return null;
  const radius = Math.max(CODE_CONTEXT_RADIUS, anchor.contextBefore.length, anchor.contextAfter.length);
  return createCodeLineAnchor(winner.code, winner.blockIndex, winner.lineIndex, radius);
}

function commentVersionTime(comment: ReviewComment): string {
  return comment.updatedAt ?? comment.createdAt;
}

/** Orders two copies so every client and the daemon resolve conflicts alike. */
export function compareReviewCommentVersions(a: ReviewComment, b: ReviewComment): number {
  const aRevision = a.revision ?? 0;
  const bRevision = b.revision ?? 0;
  if (aRevision !== bRevision) return aRevision - bRevision;
  const time = commentVersionTime(a).localeCompare(commentVersionTime(b));
  if (time !== 0) return time;
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/** Prevents id-less streaming comments from leaking into sibling messages. */
export function commentBelongsToReviewSource(
  comment: ReviewComment,
  messageId: string | null,
  sourceKey: string,
): boolean {
  if (comment.messageId !== null) return comment.messageId === messageId;
  return comment.sourceKey !== null && comment.sourceKey !== undefined && comment.sourceKey === sourceKey;
}

/** A streaming paragraph snapshot may be a prefix of the completed paragraph. */
export function reviewCommentMatchesParagraph(
  comment: Pick<ReviewComment, "codeAnchor" | "itemIndex" | "paragraphText">,
  paragraph: string | undefined,
): boolean {
  if (paragraph === undefined) return false;
  if (comment.codeAnchor) return locateCodeLineAnchor(paragraph, comment.codeAnchor) !== null;
  if (comment.itemIndex !== null && comment.itemIndex !== undefined) {
    return paragraph.includes(comment.paragraphText);
  }
  if (paragraph === comment.paragraphText) return true;
  return comment.paragraphText.length >= 40 && paragraph.startsWith(comment.paragraphText);
}

/** Finds the completed paragraph for both block-level and list-item comments. */
export function findReviewCommentParagraphIndex(
  comment: Pick<ReviewComment, "codeAnchor" | "itemIndex" | "paragraphIndex" | "paragraphText">,
  paragraphs: readonly string[],
): number {
  if (reviewCommentMatchesParagraph(comment, paragraphs[comment.paragraphIndex])) {
    return comment.paragraphIndex;
  }
  return paragraphs.findIndex((paragraph) => reviewCommentMatchesParagraph(comment, paragraph));
}

/** Pulls the persisted comments for one agent into the client store. */
export const loadCommentsRpc = defineRpc({
  name: "review.load-comments",
  input: z.object({ agentId: z.string() }),
  output: z.object({
    comments: z.array(reviewCommentSchema),
    /** Ids deleted on any device. Devices drop them instead of resurrecting. */
    deleted: z.array(z.string()).optional(),
  }),
});

const commentSyncBucketSchema = z.object({
  agentId: z.string(),
  revision: z.number().int().nonnegative(),
  comments: z.array(reviewCommentSchema),
  deleted: z.array(z.string()),
});

/** Batches cross-device comment refreshes and omits unchanged agent payloads. */
export const syncCommentsRpc = defineRpc({
  name: "review.sync-comments",
  input: z.object({
    epoch: z.string().optional(),
    agents: z.array(z.object({
      agentId: z.string(),
      revision: z.number().int().nonnegative().optional(),
    })),
  }),
  output: z.object({
    epoch: z.string(),
    buckets: z.array(commentSyncBucketSchema),
  }),
});

/** Replaces the stored comments for one agent. */
export const saveCommentsRpc = defineRpc({
  name: "review.save-comments",
  input: z.object({
    agentId: z.string(),
    comments: z.array(reviewCommentSchema),
    /** Ids removed by this device; the daemon keeps them as tombstones. */
    deleted: z.array(z.string()).optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/** Applies only changed comment records and new tombstones. */
export const saveCommentDeltaRpc = defineRpc({
  name: "review.save-comment-delta",
  input: z.object({
    agentId: z.string(),
    upserts: z.array(reviewCommentSchema),
    deleted: z.array(z.string()),
  }),
  output: z.object({ ok: z.boolean() }),
});
/** Maximum bytes carried by one file-transfer RPC. */
export const FILE_TRANSFER_CHUNK_BYTES = 5 * 1024 * 1024;
export const COMPACT_FILE_TRANSFER_CHUNK_BYTES = 768 * 1024;
export const DESKTOP_FILE_TRANSFER_CHUNK_BYTES = 2 * 1024 * 1024;
/** Total-size safety rail for one download. */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
export const IMAGE_THUMBNAIL_MAX_BYTES = 100 * 1024;

export const localImagePreviewRpc = defineRpc({
  name: "review.local-image-preview",
  input: z.object({
    path: z.string(),
    maxEdge: z.number().int().min(64).max(1280).optional(),
    quality: z.number().int().min(35).max(95).optional(),
    knownFileVersion: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    fileVersion: z.string().optional(),
    originalSize: z.number().int().nonnegative().optional(),
    originalWidth: z.number().int().positive().optional(),
    originalHeight: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    mimeType: z.string().optional(),
    base64: z.string().optional(),
    thumbnailSize: z.number().int().nonnegative().max(IMAGE_THUMBNAIL_MAX_BYTES).optional(),
    unchanged: z.boolean().optional(),
  }),
});

export const openLocalFileRpc = defineRpc({
  name: "review.open-local-file",
  input: z.object({
    path: z.string(),
    lineStart: z.number().int().optional(),
    lineEnd: z.number().int().optional(),
    mode: z.enum(["open", "read", "image", "download"]).optional(),
    /** Chunked download: byte offset and max chunk size (client-driven). */
    offset: z.number().int().min(0).optional(),
    length: z.number().int().positive().max(FILE_TRANSFER_CHUNK_BYTES).optional(),
    /** Identity returned by the first chunk; later chunks must match it. */
    fileVersion: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    content: z.string().optional(),
    truncated: z.boolean().optional(),
    size: z.number().optional(),
    /** True when the file looks binary: no text content is served. */
    binary: z.boolean().optional(),
    /** Base64 payload for a download chunk or a complete image preview. */
    base64: z.string().optional(),
    /** Validated image media type for mode "image". */
    mimeType: z.string().optional(),
    /** Chunked download: false while more chunks remain. */
    done: z.boolean().optional(),
    /** Stable identity for every chunk in one download. */
    fileVersion: z.string().optional(),
  }),
});

/** Data for the plugin-owned replacement of a sent review user message. */
export const sentReviewSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
});

export type SentReviewData = z.output<typeof sentReviewSchema>;

/** Data for the plugin-owned native card replacing a plain user message. */
export const userMessageCardSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
});

export type UserMessageCardData = z.output<typeof userMessageCardSchema>;

/**
 * Newer clients may attach host-owned media metadata to a user timeline item
 * before the public transformer type learns about it. Keep those rows native:
 * replacing one would discard images, attachment actions, and their viewer.
 */
export function userMessageHasHostAttachments(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  return [record.images, record.attachments].some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null,
  );
}

/** Matches the user messages produced by formatReview (optionally after a note). */
export function looksLikeSentReview(text: string): boolean {
  return /(?:^|\n)Review:\s*\n/.test(text) && /\[\d+\] On: /.test(text);
}

/** Splits text into comment-anchorable chunks: blank-line separated blocks,
 * with fenced code blocks kept whole even when their content contains blank
 * lines. Splitting inside a fence used to break code block rendering. */
export function splitParagraphs(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceLength = 3;
  for (const line of text.split("\n")) {
    const fence = /^\s*(`{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLength = fence[1].length;
      } else if (fence[1].length >= fenceLength) {
        inFence = false;
      }
      current.push(line);
      continue;
    }
    if (!inFence && line.trim().length === 0) {
      if (current.length > 0) {
        const chunk = current.join("\n").trim();
        if (chunk.length > 0) chunks.push(chunk);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    const chunk = current.join("\n").trim();
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}

const quoteLimit = 280;

export function shortenQuote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > quoteLimit ? flat.slice(0, quoteLimit - 1) + "\u2026" : flat;
}

export function reviewCommentQuote(
  comment: Pick<ReviewComment, "codeAnchor" | "paragraphText">,
): string {
  if (!comment.codeAnchor) return shortenQuote(comment.paragraphText);
  return [
    `Code block ${comment.codeAnchor.blockIndex + 1}, line ${comment.codeAnchor.lineIndex + 1}:`,
    ...comment.codeAnchor.contextBefore,
    `>>> ${comment.codeAnchor.lineText}`,
    ...comment.codeAnchor.contextAfter,
  ].join("\n");
}

/** Renders the PENDING comments as a review block the user can attach, paste or send. */
export function formatReview(comments: readonly ReviewComment[]): string {
  const pending = comments.filter((comment) => comment.status === "pending");
  if (pending.length === 0) return "";
  const lines: string[] = ["Review:", ""];
  pending.forEach((comment, index) => {
    // JSON strings preserve quotes, newlines and backslashes while keeping the
    // review readable to both the agent and the sent-review card parser.
    const quote = reviewCommentQuote(comment);
    lines.push(`[${index + 1}] On: ${JSON.stringify(quote)}`);
    lines.push(`Comment: ${JSON.stringify(comment.text.trim())}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export type ParsedReview = {
  note: string;
  entries: Array<{ quote: string; comment: string }>;
};

export type ParsedCodeReviewQuote = {
  blockNumber: number;
  lineNumber: number;
  lines: Array<{ lineNumber: number; text: string; selected: boolean }>;
};

/** Turns the stable code-line quote format into rows suitable for a compact preview. */
export function parseCodeReviewQuote(quote: string): ParsedCodeReviewQuote | null {
  const match = /^Code block (\d+), line (\d+):\n([\s\S]*)$/.exec(quote);
  if (!match) return null;

  const blockNumber = Number(match[1]);
  const lineNumber = Number(match[2]);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1 ||
      !Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;

  const rawLines = match[3].split("\n");
  const selectedIndex = rawLines.findIndex((line) => line.startsWith(">>> "));
  if (selectedIndex < 0) return null;

  const lines = rawLines.map((line, index) => ({
    lineNumber: lineNumber + index - selectedIndex,
    text: index === selectedIndex ? line.slice(4) : line,
    selected: index === selectedIndex,
  }));
  if (lines.some((line) => line.lineNumber < 1)) return null;
  return { blockNumber, lineNumber, lines };
}

/** Parses current JSON-escaped reviews and preserves compatibility with history. */
export function parseReviewMessage(text: string): ParsedReview {
  const headerIndex = text.search(/(?:^|\n)Review:\s*\n/);
  const note = headerIndex > 0 ? text.slice(0, headerIndex).trim() : "";
  const body = headerIndex >= 0 ? text.slice(headerIndex).replace(/^(?:\n)?Review:\s*\n/, "") : text;
  const entries: ParsedReview["entries"] = [];
  const currentPattern = /^\[\d+\] On: ("(?:\\.|[^"\\])*")\nComment: ("(?:\\.|[^"\\])*")(?=\n\s*\n|\n\[\d+\] On: |$)/gm;
  for (const match of body.matchAll(currentPattern)) {
    try {
      entries.push({ quote: JSON.parse(match[1]), comment: JSON.parse(match[2]) });
    } catch {
      // A malformed current entry may still be readable by the legacy parser.
    }
  }
  if (entries.length > 0) return { note, entries };

  const legacyPattern = /\[\d+\] On: "([^"]*)"[^\n]*\nComment: ((?:.|\n)*?)(?=\n\s*\n|\n\[\d+\] On: |$)/g;
  for (const match of body.matchAll(legacyPattern)) {
    entries.push({ quote: match[1], comment: match[2].trim() });
  }
  return { note, entries };
}

/** Accepts only external links the client may hand to its local OS opener. */
export function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Best-effort syntax-highlight language for a file path (extension). */
export function previewLanguage(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "txt";
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdx"]);

/** Whether a file path should offer the rendered Markdown preview. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(previewLanguage(path));
}
