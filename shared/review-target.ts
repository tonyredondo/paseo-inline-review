import { z } from "zod";
import { extractRefDefs, parseBlocks, parseInline, type Block, type InlineToken } from "./markdown-parse.ts";

const pathSchema = z.array(z.number().int().nonnegative()).min(1).max(16);
export const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("response") }),
  z.object({ kind: z.literal("table-cell"), path: pathSchema, row: z.number().int().min(-1), column: z.number().int().nonnegative(), text: z.string(), header: z.array(z.string()), rowText: z.array(z.string()) }),
  z.object({ kind: z.literal("image"), path: pathSchema, imageIndex: z.number().int().nonnegative(), url: z.string(), alt: z.string() }),
  z.object({ kind: z.literal("block"), path: pathSchema, blockKind: z.enum(["heading", "quote", "alert", "details", "footnote"]), text: z.string() }),
]);
export type ReviewTarget = z.output<typeof reviewTargetSchema>;

export function sameReviewTarget(a: ReviewTarget | null | undefined, b: ReviewTarget | null | undefined): boolean {
  return a === b || (!a && !b) || JSON.stringify(a) === JSON.stringify(b);
}

export function isReviewTargetAtPath(target: ReviewTarget, path: readonly number[]): boolean {
  return target.kind !== "response" && target.path.length === path.length && target.path.every((index, depth) => index === path[depth]);
}

export function blockReviewTarget(block: Block, path: number[]): Extract<ReviewTarget, { kind: "block" }> | null {
  switch (block.kind) {
    case "heading": case "quote": case "footnote": return { kind: "block", path, blockKind: block.kind, text: block.text };
    case "alert": return { kind: "block", path, blockKind: block.kind, text: block.lines.join("\n") };
    case "details": return { kind: "block", path, blockKind: block.kind, text: `${block.summary}\n${block.lines.join("\n")}` };
    default: return null;
  }
}

export function tableCellReviewTarget(block: Extract<Block, { kind: "table" }>, path: number[], row: number, column: number): Extract<ReviewTarget, { kind: "table-cell" }> {
  const cells = row === -1 ? block.header : block.rows[row];
  return { kind: "table-cell", path, row, column, text: cells[column]?.text ?? "", header: block.header.map(cell => cell.text), rowText: cells.map(cell => cell.text) };
}

export function imageReviewTarget(image: Extract<InlineToken, { type: "image" }>, path: number[], imageIndex: number): Extract<ReviewTarget, { kind: "image" }> {
  return { kind: "image", path, imageIndex, url: image.url, alt: image.alt };
}

export function reviewTargetLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case "response": return "Entire response";
    case "table-cell": return `${target.row === -1 ? "Table header" : `Table row ${target.row + 1}`} · ${target.header[target.column] || `Column ${target.column + 1}`}`;
    case "image": return `Image ${target.imageIndex + 1}${target.alt && !/^image$/i.test(target.alt) ? ` · ${target.alt}` : ""}`;
    case "block": return ({ heading: "Heading", quote: "Quote", alert: "Callout", details: "Details", footnote: "Footnote" })[target.blockKind];
  }
}

export function reviewTargetQuote(target: ReviewTarget): string {
  switch (target.kind) {
    case "response": return "Entire response";
    case "table-cell": return `${reviewTargetLabel(target)}: ${target.text}\nRow: ${target.rowText.join(" | ")}`;
    case "image": return `${reviewTargetLabel(target)}: ${target.url}`;
    case "block": return `${reviewTargetLabel(target)}: ${target.text}`;
  }
}

/** Snapshot matching is conservative: an ambiguous target stays unattached. */
export function locateReviewTarget(text: string, target: ReviewTarget, references?: Map<string, string>): ReviewTarget | null {
  if (target.kind === "response") return target;
  const candidates: ReviewTarget[] = [];
  const refs = references ?? extractRefDefs(text);
  const walk = (source: string, parent: number[]): void => {
    parseBlocks(source).forEach((block, index) => {
      const path = [...parent, index];
      if (target.kind === "block") {
        const candidate = blockReviewTarget(block, path);
        if (candidate?.kind === "block" && candidate.blockKind === target.blockKind && (candidate.text === target.text || target.text.length >= 40 && candidate.text.startsWith(target.text))) candidates.push(candidate);
      } else if (target.kind === "table-cell" && block.kind === "table") {
        if (JSON.stringify(block.header.map(cell => cell.text)) === JSON.stringify(target.header)) {
          const rows = target.row === -1 ? [block.header] : block.rows;
          rows.forEach((cells, row) => {
            if (JSON.stringify(cells.map(cell => cell.text)) === JSON.stringify(target.rowText) && cells[target.column]?.text === target.text) {
              candidates.push(tableCellReviewTarget(block, path, target.row === -1 ? -1 : row, target.column));
            }
          });
        }
      } else if (target.kind === "image" && block.kind === "p") {
        let imageIndex = 0;
        for (const line of block.lines) {
          // Use the same inline parser and reference definitions as the renderer.
          for (const image of parseInline(line, refs).filter((token): token is Extract<InlineToken, { type: "image" }> => token.type === "image")) {
            if (image.url === target.url && image.alt === target.alt) candidates.push(imageReviewTarget(image, path, imageIndex));
            imageIndex++;
          }
        }
      }
      if (path.length < 16) {
        if (block.kind === "quote") walk(block.text, path);
        else if (block.kind === "alert" || block.kind === "details") walk(block.lines.join("\n"), path);
      }
    });
  };
  walk(text, []);
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.filter(candidate => sameReviewTarget(candidate, target));
  return exact.length === 1 ? exact[0] : null;
}
