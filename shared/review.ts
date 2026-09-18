import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
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
  /** Snapshot of the commented paragraph, used for quoting and anchoring. */
  paragraphText: z.string(),
  text: z.string(),
  createdAt: z.string(),
  /** pending = will be attached to the next message; sent = already context. */
  status: z.enum(["pending", "sent"]),
});

export type ReviewComment = z.output<typeof reviewCommentSchema>;

const attachmentItemSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  url: z.string().url(),
  text: z.string(),
  resourceType: z.string(),
});

/** Pulls the persisted comments for one agent into the client store. */
export const loadCommentsRpc = defineRpc({
  name: "review.load-comments",
  input: z.object({ agentId: z.string() }),
  output: z.object({ comments: z.array(reviewCommentSchema) }),
});

/** Replaces the stored comments for one agent. */
export const saveCommentsRpc = defineRpc({
  name: "review.save-comments",
  input: z.object({ agentId: z.string(), comments: z.array(reviewCommentSchema) }),
  output: z.object({ ok: z.boolean() }),
});

/** Composer attachment search: returns the current pending review drafts. */
export const draftSearchRpc = defineRpc({
  name: "review.draft-search",
  input: z.object({ query: z.string() }),
  output: z.object({ items: z.array(attachmentItemSchema) }),
});

export const openInBrowserRpc = defineRpc({
  name: "review.open-in-browser",
  input: z.object({ url: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const attachmentSource = {
  id: "review-draft",
  title: "Inline review draft",
  icon: "MessageSquareQuote",
  pickerTitle: "Attach review draft",
  searchPlaceholder: "Search review drafts...",
  search: draftSearchRpc,
};

/** Splits text into comment-anchorable chunks: blank-line separated blocks,
 * with fenced code blocks kept whole even when their content contains blank
 * lines. Splitting inside a fence used to break code block rendering. */
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
