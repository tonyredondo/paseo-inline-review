import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Data carried by the plugin-owned replacement of an assistant message. */
export const reviewItemSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export type ReviewItemData = z.output<typeof reviewItemSchema>;

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
  /** Snapshot of the commented paragraph, used for quoting and anchoring. */
  paragraphText: z.string(),
  text: z.string(),
  createdAt: z.string(),
  /** pending = will be attached to the next message; sent = already context. */
  status: z.enum(["pending", "sent"]),
});

export type ReviewComment = z.output<typeof reviewCommentSchema>;

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



/** TEMP AUDIT: client dumps turn-card detection state. */
export const debugHairlinesRpc = defineRpc({
  name: "review.debug-hairlines",
  input: z.object({ dump: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const openInBrowserRpc = defineRpc({
  name: "review.open-in-browser",
  input: z.object({ url: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const openLocalFileRpc = defineRpc({
  name: "review.open-local-file",
  input: z.object({
    path: z.string(),
    lineStart: z.number().int().optional(),
    lineEnd: z.number().int().optional(),
    mode: z.enum(["open", "read", "download"]).optional(),
    /** Chunked download: byte offset and max chunk size (client-driven). */
    offset: z.number().int().min(0).optional(),
    length: z.number().int().positive().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    content: z.string().optional(),
    truncated: z.boolean().optional(),
    size: z.number().optional(),
    /** True when the file looks binary: no text content is served. */
    binary: z.boolean().optional(),
    /** Base64 payload for mode "download". */
    base64: z.string().optional(),
    /** Chunked download: false while more chunks remain. */
    done: z.boolean().optional(),
  }),
});

/** Data for the plugin-owned replacement of a sent review user message. */
export const sentReviewSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
});

export type SentReviewData = z.output<typeof sentReviewSchema>;

/** Data for the plugin-owned card replacing a plain user message (user flag). */
export const userMessageCardSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
});

export type UserMessageCardData = z.output<typeof userMessageCardSchema>;

/** Matches the user messages produced by formatReview (optionally after a note). */
export function looksLikeSentReview(text: string): boolean {
  return /(?:^|\n)Review:\s*\n/.test(text) && /\[\d+\] On: "/.test(text);
}

/** Client tells the daemon which agent's workspace is currently visible, so
 * the attachment picker only offers that agent's draft. */
export const setActiveAgentRpc = defineRpc({
  name: "review.set-active-agent",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

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

/** Renders the PENDING comments as a review block the user can attach, paste or send. */
export function formatReview(comments: readonly ReviewComment[]): string {
  const pending = comments.filter((comment) => comment.status === "pending");
  if (pending.length === 0) return "";
  const lines: string[] = ["Review:", ""];
  pending.forEach((comment, index) => {
    lines.push(`[${index + 1}] On: "${shortenQuote(comment.paragraphText)}"`);
    lines.push(`Comment: ${comment.text.trim()}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/** Opens an absolute HTTP(S) URL with the daemon host OS default browser. */
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
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "txt";
}
