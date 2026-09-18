/**
 * Pure markdown parsing for the inline-review plugin. No runtime imports, so
 * this module is testable with plain Node (node --test with type stripping)
 * and safe to use from both plugin runtimes.
 *
 * Supported: fenced code blocks, ATX headings, bullet lists (with nesting and
 * task items), ordered lists, block quotes, GFM tables (with alignment), GFM
 * tables with header-only rows, horizontal rules, paragraphs with hard line
 * breaks, and inline tokens: bold, italic, inline code, strikethrough, links,
 * images, and bare-URL autolinks.
 */

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "strike"; text: string }
  | { type: "link"; text: string; url: string }
  | { type: "image"; alt: string; url: string };

export type ListItem = {
  level: number;
  task: boolean;
  checked: boolean;
  spans: InlineToken[];
};

export type TableCell = { text: string; spans: InlineToken[]; align: "left" | "center" | "right" };

export type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; items: ListItem[] }
  | { kind: "ordered"; items: { marker: string; level: number; spans: InlineToken[] }[] }
  | { kind: "quote"; depth: number; text: string }
  | { kind: "table"; header: TableCell[]; rows: TableCell[][] }
  | { kind: "hr" };

const fencePattern = /^\s*```/;
const indentedCodePattern = /^(?:    |\t)/;
const headingPattern = /^(#{1,6})\s+(.*)$/;
const bulletPattern = /^(\s*)[-*+]\s+(.*)$/;
const orderedPattern = /^(\s*)(\d+)[.)]\s+(.*)$/;
const quotePattern = /^(\s*)(>+)\s?(.*)$/;
const hrPattern = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const tableRowPattern = /^\s*\|.*\|\s*$|^\s*\|.*[^|]\s*$/;
const tableSeparatorPattern =
  /^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/;

function isTableRow(line: string): boolean {
  return tableRowPattern.test(line) && line.includes("|");
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseAlignment(separatorCell: string): "left" | "center" | "right" {
  const left = separatorCell.startsWith(":");
  const right = separatorCell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function makeCells(
  texts: string[],
  alignments: ("left" | "center" | "right")[],
): TableCell[] {
  return texts.map((text, index) => ({
    text,
    spans: parseInline(text),
    align: alignments[index] ?? "left",
  }));
}

function isTaskItem(text: string): { task: boolean; checked: boolean; rest: string } {
  const match = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  if (match) return { task: true, checked: match[1] !== " ", rest: match[2] };
  return { task: false, checked: false, rest: text };
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (fencePattern.test(line)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !fencePattern.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // consume the closing fence, or run past the end while streaming
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (isTableRow(line) && index + 1 < lines.length && tableSeparatorPattern.test(lines[index + 1])) {
      const alignments = splitTableRow(lines[index + 1]).map(parseAlignment);
      const headerTexts = splitTableRow(line);
      const header = makeCells(headerTexts, alignments);
      index += 2;
      const rows: TableCell[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        const cells = splitTableRow(lines[index]);
        // GFM pads short rows with empty cells.
        while (cells.length < headerTexts.length) cells.push("");
        rows.push(makeCells(cells, alignments));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (hrPattern.test(line) && !isTableRow(lines[index - 1] ?? "")) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }
    const heading = headingPattern.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (quotePattern.test(line)) {
      const first = quotePattern.exec(line)!;
      const depth = Math.min(4, first[2].length);
      const parts: string[] = [first[3]];
      index += 1;
      // Contiguous lines of the SAME depth merge; a depth change starts a
      // new nested quote block (renderer indents by depth).
      while (index < lines.length && quotePattern.test(lines[index])) {
        const match = quotePattern.exec(lines[index])!;
        if (Math.min(4, match[2].length) !== depth) break;
        parts.push(match[3]);
        index += 1;
      }
      blocks.push({ kind: "quote", depth, text: parts.join(" ") });
      continue;
    }
    const bullet = bulletPattern.exec(line);
    if (bullet) {
      const items: ListItem[] = [];
      while (index < lines.length && bulletPattern.test(lines[index]) && !fencePattern.test(lines[index])) {
        const match = bulletPattern.exec(lines[index])!;
        const indent = match[1].replace(/\t/g, "  ").length;
        const level = Math.min(4, Math.floor(indent / 2));
        const task = isTaskItem(match[2]);
        const content: string[] = [task.rest];
        index += 1;
        consumeListContinuation(lines, index, (nextIndex, extraLines) => {
          index = nextIndex;
          content.push(...extraLines);
        });
        items.push({
          level,
          task: task.task,
          checked: task.checked,
          spans: parseInline(content.join("\n")),
        });
      }
      blocks.push({ kind: "bullet", items });
      continue;
    }
    const ordered = orderedPattern.exec(line);
    if (ordered) {
      const items: { marker: string; level: number; spans: InlineToken[] }[] = [];
      while (index < lines.length && orderedPattern.test(lines[index]) && !fencePattern.test(lines[index])) {
        const match = orderedPattern.exec(lines[index])!;
        const indent = match[1].replace(/\t/g, "  ").length;
        const content: string[] = [match[3]];
        index += 1;
        consumeListContinuation(lines, index, (nextIndex, extraLines) => {
          index = nextIndex;
          content.push(...extraLines);
        });
        items.push({ marker: match[2], level: Math.min(4, Math.floor(indent / 2)), spans: parseInline(content.join("\n")) });
        index = index;
      }
      blocks.push({ kind: "ordered", items });
      continue;
    }
    // Indented code blocks (4 spaces / tab) — CommonMark requires the block
    // not to interrupt a paragraph, so only after a blank line or at the start.
    if (
      indentedCodePattern.test(line) &&
      !bulletPattern.test(line) &&
      !orderedPattern.test(line) &&
      !quotePattern.test(line) &&
      (index === 0 || lines[index - 1].trim().length === 0)
    ) {
      const code: string[] = [];
      while (
        index < lines.length &&
        indentedCodePattern.test(lines[index]) &&
        lines[index].trim().length > 0
      ) {
        code.push(lines[index].replace(/^(?:    |\t)/, ""));
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !fencePattern.test(lines[index]) &&
      !headingPattern.test(lines[index]) &&
      !quotePattern.test(lines[index]) &&
      !(bulletPattern.test(lines[index]) && !fencePattern.test(lines[index])) &&
      !(orderedPattern.test(lines[index]) && !fencePattern.test(lines[index])) &&
      !hrPattern.test(lines[index]) &&
      !(isTableRow(lines[index]) && index + 1 < lines.length && tableSeparatorPattern.test(lines[index + 1]))
    ) {
      paragraph.push(lines[index]);
      index += 1;
      // Setext heading: a paragraph line followed by a === or --- underline.
      if (
        paragraph.length > 0 &&
        index < lines.length &&
        /^(=+|-+)\s*$/.test(lines[index]) &&
        !isTableRow(lines[index]) &&
        !tableSeparatorPattern.test(lines[index])
      ) {
        blocks.push({
          kind: "heading",
          level: lines[index].trim().startsWith("=") ? 1 : 2,
          text: paragraph.join(" "),
        });
        paragraph.length = 0;
        index += 1;
        break;
      }
    }
    if (paragraph.length > 0) blocks.push({ kind: "p", lines: paragraph });
  }
  return blocks;
}

const inlinePattern =
  /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|!\[[^\]]*\]\([^)\s]+(\s+"[^"]*")?\)|\[[^\]]+\]\([^)\s]+(\s+"[^"]*")?\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s)]+)/g;

/**
 * Consumes wrapped and indented continuation lines of a list item:
 * - indented non-blank lines attach to the current item;
 * - after a blank line, further INDENTED lines still belong to the item
 *   (multi-paragraph items); any other line ends the item.
 */
function consumeListContinuation(
  lines: string[],
  startIndex: number,
  accept: (nextIndex: number, extraLines: string[]) => void,
): void {
  let index = startIndex;
  const extra: string[] = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      const next = lines[index + 1];
      if (
        next !== undefined &&
        /^[ ]{2,}|\t/.test(next) &&
        !bulletPattern.test(next) &&
        !orderedPattern.test(next) &&
        !fencePattern.test(next)
      ) {
        extra.push("");
        index += 1;
        continue;
      }
      break;
    }
    if (
      fencePattern.test(line) ||
      headingPattern.test(line) ||
      quotePattern.test(line) ||
      bulletPattern.test(line) ||
      orderedPattern.test(line) ||
      hrPattern.test(line)
    ) {
      break;
    }
    if (/^[ ]{2,}|\t/.test(line)) {
      extra.push(line.replace(/^(?: {2}|\t+)/, ""));
      index += 1;
      continue;
    }
    break;
  }
  if (extra.length > 0) accept(index, extra);
}

const escapeSequence = /\\([\\`*_{}\[\]()#+.!>~|-])/g;

/** Replaces backslash escapes with sentinels so they never match a pattern. */
function maskEscapes(text: string): { masked: string; restore: (value: string) => string } {
  const escaped: string[] = [];
  const masked = text.replace(/\\([\\`*_{}\[\]()#+\-.!>~])/g, (_match, character: string) => {
    escaped.push(character);
    return `\u0000${escaped.length - 1}\u0000`;
  });
  return {
    masked,
    restore: (value: string) =>
      value.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => escaped[Number(index)] ?? ""),
  };
}

/** Tokenizes one line of text into typed inline spans. */
export function parseInline(raw: string): InlineToken[] {
  const { masked, restore } = maskEscapes(raw);
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  for (const match of masked.matchAll(inlinePattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push({ type: "text", text: masked.slice(lastIndex, start) });
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("__") && token.endsWith("__")) {
      tokens.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      tokens.push({ type: "strike", text: token.slice(2, -2) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push({ type: "italic", text: token.slice(1, -1) });
    } else if (token.startsWith("_") && token.endsWith("_")) {
      tokens.push({ type: "italic", text: token.slice(1, -1) });
    } else if (token.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (image) {
        tokens.push({ type: "image", alt: image[1], url: image[2] });
      } else {
        tokens.push({ type: "text", text: token });
      }
    } else if (token.startsWith("[") || token.startsWith("<")) {
      const link = /^(?:\[([^\]]+)\]\(|<)([^)\s>]+)(?:\s+"[^"]*")?(\)|>)$/.exec(token);
      if (link) {
        tokens.push({
          type: "link",
          text: link[1] ?? link[2],
          url: link[2],
        });
      } else {
        tokens.push({ type: "text", text: token });
      }
    } else {
      tokens.push({ type: "link", text: token, url: token });
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < masked.length) {
    tokens.push({ type: "text", text: masked.slice(lastIndex) });
  }
  return tokens.map((token) => {
    if (token.type === "image") {
      return { ...token, alt: restore(token.alt) };
    }
    return { ...token, text: restore(token.text) };
  });
}
