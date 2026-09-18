import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Data carried by the plugin-owned replacement of an assistant message. */
export const reviewItemSchema = z.object({
  messageId: z.string().nullable(),
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export type ReviewItemData = z.output<typeof reviewItemSchema>;

export type ReviewComment = {
  id: string;
  agentId: string;
  messageId: string | null;
  /** Zero-based paragraph index inside the commented assistant message. */
  paragraphIndex: number;
  /** Snapshot of the commented paragraph, used for quoting and null-messageId anchoring. */
  paragraphText: string;
  text: string;
  createdAt: string;
};

/**
 * Splits text into comment-anchorable chunks: blank-line separated blocks,
 * with fenced code blocks kept whole even when their content contains blank
 * lines. Splitting inside a fence used to break code block rendering.
 */
export function splitParagraphs(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
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

/** Renders the comments as a review block the user can paste or send. */
export function formatReview(comments: readonly ReviewComment[]): string {
  if (comments.length === 0) return "";
  const lines: string[] = ["Review:", ""];
  comments.forEach((comment, index) => {
    lines.push(`[${index + 1}] On: "${shortenQuote(comment.paragraphText)}"`);
    lines.push(`Comment: ${comment.text.trim()}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export const openInBrowserRpc = defineRpc({
  name: "review.open-in-browser",
  input: z.object({ url: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/** Opens an absolute HTTP(S) URL with the daemon host OS default browser. */
export function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
