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
  | { type: "break" }
  | { type: "bold"; text: string; tokens: InlineToken[] }
  | { type: "italic"; text: string; tokens: InlineToken[] }
  | { type: "code"; text: string }
  | { type: "strike"; text: string; tokens: InlineToken[] }
  | { type: "link"; text: string; url: string; tokens?: InlineToken[] }
  | { type: "image"; alt: string; url: string; linkUrl?: string }
  | { type: "footnoteRef"; label: string };

export type ListItem = {
  level: number;
  task: boolean;
  checked: boolean;
  spans: InlineToken[];
};

export type TableCell = { text: string; spans: InlineToken[]; align: "left" | "center" | "right" };

export type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "code"; text: string; language: string | null }
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; items: ListItem[] }
  | { kind: "ordered"; items: { marker: string; level: number; spans: InlineToken[] }[] }
  | { kind: "quote"; depth: number; text: string }
  | { kind: "alert"; alertType: "note" | "tip" | "important" | "warning" | "caution"; lines: string[] }
  | { kind: "details"; summary: string; lines: string[] }
  | { kind: "footnote"; label: string; text: string }
  | { kind: "table"; header: TableCell[]; rows: TableCell[][] }
  | { kind: "hr" };

const fencePattern = /^\s*(`{3,})/;
const indentedCodePattern = /^(?:    |\t)/;
const headingPattern = /^(#{1,6})\s+(.*)$/;
const bulletPattern = /^(\s*)[-*+]\s+(.*)$/;
const orderedPattern = /^(\s*)(\d+)[.)]\s+(.*)$/;
const quotePattern = /^(\s*)(>+)\s?(.*)$/;
const hrPattern = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const detailsOpenPattern = /^\s*<details\b/i;
const detailsClosePattern = /^\s*<\/details>/i;
const summaryPattern = /^\s*<summary>(.*)<\/summary>\s*$/i;
const footnoteDefPattern = /^\s*\[\^([^\]]+)\]:\s*(.*)$/;
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
    if (detailsOpenPattern.test(line)) {
      // <details>/<summary> collapsible section. Body lines are kept for the
      // renderer to parse as nested markdown.
      index += 1;
      const inner: string[] = [];
      while (index < lines.length && !detailsClosePattern.test(lines[index])) {
        inner.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1; // consume </details>
      let summary = "";
      const body: string[] = [];
      for (const innerLine of inner) {
        const summaryMatch = summaryPattern.exec(innerLine);
        if (summaryMatch) {
          summary = summaryMatch[1];
        } else if (!summary && /^\s*<summary>/i.test(innerLine)) {
          // Summary split across lines: capture tag lines into the summary.
          continue;
        } else {
          body.push(innerLine);
        }
      }
      blocks.push({ kind: "details", summary, lines: body });
      continue;
    }
    const openFence = fencePattern.exec(line);
    if (openFence) {
      // CommonMark: a fence is closed only by a backtick run at least as
      // long as the opener — so ````markdown blocks can contain ``` code.
      const fenceLength = openFence[1].length;
      const closeFence = new RegExp("^\\s*`{" + fenceLength + ",}");
      const language = /^\s*`{3,}\s*([\w#+.-]*)/.exec(line)?.[1] ?? null;
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !closeFence.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // consume the closing fence, or run past the end while streaming
      blocks.push({ kind: "code", text: code.join("\n"), language: language && language.length > 0 ? language : null });
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
    const footnoteDef = footnoteDefPattern.exec(line);
    if (footnoteDef) {
      const label = footnoteDef[1];
      const content: string[] = [footnoteDef[2]];
      index += 1;
      while (index < lines.length && lines[index].trim().length > 0 && !quotePattern.test(lines[index]) && !fencePattern.test(lines[index])) {
        content.push(lines[index].replace(/^(?:    |\t)?/, ""));
        index += 1;
      }
      blocks.push({ kind: "footnote", label, text: content.join(" ").trim() });
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
      // GitHub alerts: "> [!NOTE]" etc. become their own block with an icon.
      const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(parts[0].trim());
      if (alertMatch) {
        const alertLines = [alertMatch[2], ...parts.slice(1)].filter((part) => part.length > 0);
        blocks.push({
          kind: "alert",
          alertType: alertMatch[1].toLowerCase() as "note" | "tip" | "important" | "warning" | "caution",
          lines: alertLines,
        });
      } else {
        blocks.push({ kind: "quote", depth, text: parts.join("\n") });
      }
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
      blocks.push({ kind: "code", text: code.join("\n"), language: null });
      continue;
    }
    if (refDefPattern.test(line) && !isTableRow(line)) {
      index += 1;
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
  /(\*\*(?:[^*]|\*(?!\*))+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|<br\s*\/?>|\[!\[[^\]]*\]\([^)\s]+\)\]\([^)\s]+\)|!\[[^\]]*\]\([^)\s]+(\s+"[^"]*")?\)|\[[^\]]+\]\(<[^>]*>\)|\[[^\]]+\]\([^)\s]+(\s+"[^"]*")?\)|\[[^\]]+\]\[[^\]]*\]|\[\^[^\]\s]+\]|\[[^\]]+\]|<https?:\/\/[^>\s]+>|https?:\/\/[^\s]+|www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s)]*)?|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

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

/** Reference link definition lines are removed from rendering and resolved. */
const refDefPattern = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/;

export function extractRefDefs(text: string): Map<string, string> {
  const refs = new Map<string, string>();
  const lines = text.split("\n");
  let inFence = false;
  let fenceLength = 3;
  for (const line of lines) {
    const fence = /^\s*(`{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLength = fence[1].length;
      } else if (fence[1].length >= fenceLength) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const match = refDefPattern.exec(line);
    if (match) {
      refs.set(match[1].toLowerCase(), match[2].trim());
    }
  }
  return refs;
}

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
const emojiShortcodes: Record<string, string> = {
  tada: "\u{1F389}", rocket: "\u{1F680}", fire: "\u{1F525}", bug: "\u{1F41B}",
  warning: "\u26A0\uFE0F", white_check_mark: "\u2705", x: "\u274C", question: "\u2753",
  exclamation: "\u2757", heavy_check_mark: "\u2714\uFE0F", heart: "\u2764\uFE0F",
  star: "\u2B50", wrench: "\u1F527", hammer: "\u1F528", memo: "\u1F4DD",
  book: "\u1F4D6", bulb: "\u{1F4A1}", zap: "\u26A1", eyes: "\u{1F440}",
  "ok_hand": "\u{1F44C}", wave: "\u{1F44B}", clap: "\u{1F44F}", thinking: "\u{1F914}",
  "+1": "\u{1F44D}", "-1": "\u{1F44E}", smile: "\u{1F600}", laughing: "\u{1F606}",
  cry: "\u{1F62D}", praying: "\u{1F64F}", muscle: "\u{1F4AA}", mag: "\u{1F50D}",
  seedling: "\u{1F331}", sparkles: "\u2728", package: "\u{1F4E6}", lock: "\u{1F512}",
  ship: "\u{1F6A2}", construction: "\u{1F6A7}", memo_pencil: "\u{1F4DD}",
};

function replaceShortcodes(value: string): string {
  if (!value.includes(":")) return value;
  return value.replace(/:([a-z0-9_+-]{1,30}):/gi, (match, name: string) => {
    const emoji = emojiShortcodes[name.toLowerCase()];
    return emoji ?? match;
  });
}

/**
 * CommonMark rule: intraword underscores do not emphasize. `snake_case_word`
 * stays plain; `_word_` surrounded by non-word characters still italicizes.
 * `*` keeps intraword emphasis, matching CommonMark.
 */
function isIntrawordUnderscore(text: string, start: number, length: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = text[start + length] ?? "";
  return /[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after);
}

export function parseInline(raw: string, refs?: Map<string, string>): InlineToken[] {
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
      tokens.push({ type: "bold", text: token.slice(2, -2), tokens: parseInline(token.slice(2, -2), refs) });
    } else if (token.startsWith("__") && token.endsWith("__")) {
      if (isIntrawordUnderscore(masked, start, token.length)) {
        // CommonMark: __ inside a word (snake__case) does not emphasize.
        tokens.push({ type: "text", text: token });
      } else {
        tokens.push({ type: "bold", text: token.slice(2, -2), tokens: parseInline(token.slice(2, -2), refs) });
      }
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      tokens.push({ type: "strike", text: token.slice(2, -2), tokens: parseInline(token.slice(2, -2), refs) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push({ type: "italic", text: token.slice(1, -1), tokens: parseInline(token.slice(1, -1), refs) });
    } else if (token.startsWith("_") && token.endsWith("_")) {
      if (isIntrawordUnderscore(masked, start, token.length)) {
        tokens.push({ type: "text", text: token });
      } else {
        tokens.push({ type: "italic", text: token.slice(1, -1), tokens: parseInline(token.slice(1, -1), refs) });
      }
    } else if (/^\[!\[[^\]]*\]\([^)]*\)\]\([^)\s]+\)$/.test(token)) {
      // [![alt](image)](link): a clickable image.
      const imageLink = /^\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)$/.exec(token)!;
      tokens.push({ type: "image", alt: imageLink[1], url: imageLink[2], linkUrl: imageLink[3] });
    } else if (token.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (image) {
        tokens.push({ type: "image", alt: image[1], url: image[2] });
      } else {
        tokens.push({ type: "text", text: token });
      }
    } else if (token.startsWith("<br") && /^<br\s*\/?>$/i.test(token)) {
      tokens.push({ type: "break" });
    } else if (/^\[\^[^\]\s]+\]$/.test(token)) {
      tokens.push({ type: "footnoteRef", label: token.slice(2, -1) });
    } else if (token.startsWith("<") || token.startsWith("[")) {
      let handled = false;
      // [text][label] and [label] resolve only when the reference exists.
      if (refs) {
        const ref = /^\[([^\]]+)\]\[([^\]]*)\]$/.exec(token);
        if (ref) {
          const label = (ref[2] || ref[1]).toLowerCase();
          const url = refs.get(label);
          if (url) {
            tokens.push({ type: "link", text: ref[1], url, tokens: parseInline(ref[1], refs) });
          }
          else tokens.push({ type: "text", text: token });
          handled = true;
        } else if (/^\[[^\]]+\]$/.test(token)) {
          const url = refs.get(token.slice(1, -1).toLowerCase());
          if (url) {
            const refText = token.slice(1, -1);
            tokens.push({ type: "link", text: refText, url, tokens: parseInline(refText, refs) });
            handled = true;
          }
        }
      }
      if (!handled) {
      const link = token.includes("](<")
        ? /^\[([^\]]+)\]\(<([^>]*)>\)$/.exec(token)
        : /^(?:\[([^\]]+)\]\(|<)([^)\s>]+)(?:\s+"[^"]*")?(\)|>)$/.exec(token);
      if (link) {
        const linkText = link[1] ?? link[2];
        tokens.push({
          type: "link",
          text: linkText,
          url: link[2],
          tokens: parseInline(linkText, refs),
        });
      } else {
        tokens.push({ type: "text", text: token });
      }
      }
    } else if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(token)) {
      tokens.push({ type: "link", text: token, url: `mailto:${token}` });
    } else {
      // Bare autolinks: strip trailing punctuation the sentence added
      // (markdown-it linkify behavior) so "https://x.com." does not link the
      // dot; unbalanced closing parens also fall off.
      const prefix = token.startsWith("www.") ? "https://" : "";
      const full = prefix + token;
      let end = full.length;
      while (end > 0) {
        const last = full[end - 1];
        if (". ,;:!?".includes(last)) {
          end -= 1;
          continue;
        }
        if (last === ")") {
          const opens = (full.slice(0, end).match(/\(/g) ?? []).length;
          const closes = (full.slice(0, end).match(/\)/g) ?? []).length;
          if (closes > opens) {
            end -= 1;
            continue;
          }
        }
        break;
      }
      const url = full.slice(0, end);
      const display = url.slice(prefix.length);
      tokens.push({ type: "link", text: display, url });
      const remainder = token.slice(display.length);
      if (remainder.length > 0) tokens.push({ type: "text", text: remainder });
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < masked.length) {
    tokens.push({ type: "text", text: masked.slice(lastIndex) });
  }
  return tokens.map((token) => {
    if (token.type === "image") {
      return { ...token, alt: replaceShortcodes(restore(token.alt)) };
    }
    if (token.type === "code") {
      return { ...token, text: restore(token.text) };
    }
    if (token.type === "break") {
      return token;
    }
    if (token.type === "bold" || token.type === "italic" || token.type === "strike") {
      // Nested tokens are already unescaped by the recursive call.
      return { ...token, text: replaceShortcodes(restore(token.text)) };
    }
    if (token.type === "footnoteRef") {
      return token;
    }
    return { ...token, text: replaceShortcodes(restore(token.text)) };
  });
}


// --- Local file links --------------------------------------------------------
// Mirrors the host app's assistant-file-links classifier: file:// URLs,
// absolute paths (with VSCode-style line suffixes), home-relative paths and
// workspace-relative paths with known source extensions. Web URLs return null.

export type LocalFileTarget = {
  path: string;
  lineStart?: number;
  lineEnd?: number;
};

const LOCAL_FILE_EXTENSIONS = new Set([
  "astro", "bash", "c", "cc", "cjs", "cpp", "cs", "css", "cts", "cxx", "env", "fish", "go",
  "gql", "gradle", "graphql", "h", "hpp", "htm", "html", "ini", "java", "js", "json", "jsonc",
  "jsx", "kt", "kts", "less", "lock", "lua", "md", "mdx", "mjs", "mts", "php", "proto", "py",
  "rb", "rs", "sass", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "txt",
  "vue", "xml", "yaml", "yml", "zsh", "log", "conf",
]);

const LINE_FRAGMENT_PATTERNS = [
  /^(.+?):([0-9]+)(?::[0-9]+)?(?:-([0-9]+)(?::[0-9]+)?)?$/,
  /^(.+?)\(([0-9]+)(?:,[0-9]+)?(?:-([0-9]+)(?:,[0-9]+)?)?\)$/,
  /^(.+?)\s+[Ll]ines?\s+([0-9]+)(?:-([0-9]+))?$/,
];

/** Strict suffix parsers: `path:12`, `path(12,3)`, `path lines 10-20`. */
function parseInlineLineSuffix(value: string): { path: string; lineStart?: number; lineEnd?: number } | null {
  for (const pattern of LINE_FRAGMENT_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const basePath = (match[1] ?? "").trim().replace(/^['"`]|['"`]$/g, "").replace(/\\/g, "/");
    if (!basePath || basePath.includes("://")) continue;
    const lineStart = parseInt(match[2], 10);
    if (!Number.isFinite(lineStart) || lineStart <= 0) continue;
    const lineEnd = match[3] ? parseInt(match[3], 10) : undefined;
    if (lineEnd !== undefined && (lineEnd <= 0 || lineEnd < lineStart)) continue;
    return { path: basePath, lineStart, lineEnd };
  }
  return null;
}

function splitHash(value: string): { path: string; fragment: string } {
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return { path: value, fragment: "" };
  return { path: value.slice(0, hashIndex), fragment: value.slice(hashIndex + 1) };
}

function parseFragmentLines(fragment: string): { lineStart?: number; lineEnd?: number } | null {
  const raw = fragment.replace(/^L/i, "");
  if (!raw) return null;
  const range = /^([0-9]+)(?:-[Ll]?([0-9]+))?$/.exec(raw);
  if (!range) return null;
  const lineStart = parseInt(range[1], 10);
  if (!Number.isFinite(lineStart) || lineStart <= 0) return null;
  const lineEnd = range[2] ? parseInt(range[2], 10) : undefined;
  if (lineEnd !== undefined && (lineEnd <= 0 || lineEnd < lineStart)) return null;
  return { lineStart, lineEnd };
}

function isHomeRelative(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function hasKnownSourceExtension(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return LOCAL_FILE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Classifies a link href as a local file target: `file://` URLs, absolute
 * paths (with VSCode-style line suffixes), home-relative paths, or
 * workspace-relative paths with a known source extension. Web URLs return
 * null.
 */
export function classifyLocalFileLink(
  href: string,
  options: { workspaceRoot?: string | null } = {},
): LocalFileTarget | null {
  const raw = (href ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.startsWith("#") || /^[A-Za-z0-9._%+-]+@/.test(raw)) return null;

  let path = "";
  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  if (/^file:\/\//i.test(raw)) {
    let fileUrl: URL;
    try {
      fileUrl = new URL(raw);
    } catch {
      return null;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(fileUrl.pathname);
    } catch {
      return null;
    }
    if (fileUrl.hostname && fileUrl.hostname !== "localhost") {
      decodedPath = `//${fileUrl.hostname}${decodedPath}`;
    } else if (/^\/[A-Za-z]:\//.test(decodedPath)) {
      decodedPath = decodedPath.slice(1);
    }
    const suffix = parseInlineLineSuffix(decodedPath);
    if (suffix) {
      path = suffix.path;
      lineStart = suffix.lineStart;
      lineEnd = suffix.lineEnd;
    } else {
      path = decodedPath;
      const fragmentLines = parseFragmentLines(fileUrl.hash.replace(/^#/, ""));
      lineStart = fragmentLines?.lineStart;
      lineEnd = fragmentLines?.lineEnd;
    }
  } else {
    const suffix = parseInlineLineSuffix(raw);
    if (suffix) {
      path = suffix.path;
      lineStart = suffix.lineStart;
      lineEnd = suffix.lineEnd;
    } else {
      const { path: hashless, fragment } = splitHash(raw);
      path = hashless;
      const fragmentLines = parseFragmentLines(fragment);
      lineStart = fragmentLines?.lineStart;
      lineEnd = fragmentLines?.lineEnd;
    }
  }
  if (!path) return null;

  // Home-relative paths resolve on the daemon side (server expands ~).
  if (isHomeRelative(path)) return { path, lineStart, lineEnd };

  // Absolute paths.
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return { path: path.replace(/\\/g, "/"), lineStart, lineEnd };
  }

  // Workspace-relative source files resolve against the workspace root.
  const root = options.workspaceRoot?.trim();
  if (!root) return null;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot.startsWith("/") && !/^[A-Za-z]:\//.test(normalizedRoot)) return null;
  if (!hasKnownSourceExtension(path)) return null;
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return { path: `${normalizedRoot}/${normalizedPath}`, lineStart, lineEnd };
}
