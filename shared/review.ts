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

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
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
