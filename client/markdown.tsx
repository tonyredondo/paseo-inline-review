import type { ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { Fragment, useMemo } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { openExternal } from "./web";

/**
 * Minimal markdown rendering for claimed assistant messages. Paseo does not
 * expose its native markdown renderer to plugins, so this keeps the response
 * readable (code blocks, headings, lists, quotes, bold/italic/code/links)
 * while the plugin adds per-paragraph comment affordances.
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; items: string[] }
  | { kind: "ordered"; items: { marker: string; text: string }[] }
  | { kind: "quote"; text: string };

const fencePattern = /^\s*```.*$/;
const headingPattern = /^(#{1,4})\s+(.*)$/;
const bulletPattern = /^\s*[-*+]\s+(.*)$/;
const orderedPattern = /^\s*(\d+)[.)]\s+(.*)$/;
const quotePattern = /^\s*>\s?(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let index = 0;

  function isBlank(line: string): boolean {
    return line.trim().length === 0;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
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
      index += 1; // consume the closing fence (or run past the end while streaming)
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = headingPattern.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (quotePattern.test(line)) {
      const parts: string[] = [];
      while (index < lines.length && quotePattern.test(lines[index])) {
        parts.push(quotePattern.exec(lines[index])![1]);
        index += 1;
      }
      blocks.push({ kind: "quote", text: parts.join(" ") });
      continue;
    }
    if (bulletPattern.test(line)) {
      const items: string[] = [];
      while (index < lines.length && bulletPattern.test(lines[index]) && !fencePattern.test(lines[index])) {
        items.push(bulletPattern.exec(lines[index])![1]);
        index += 1;
      }
      blocks.push({ kind: "bullet", items });
      continue;
    }
    if (orderedPattern.test(line)) {
      const items: { marker: string; text: string }[] = [];
      while (index < lines.length && orderedPattern.test(lines[index]) && !fencePattern.test(lines[index])) {
        const match = orderedPattern.exec(lines[index])!;
        items.push({ marker: match[1], text: match[2] });
        index += 1;
      }
      blocks.push({ kind: "ordered", items });
      continue;
    }
    // Paragraph: merge consecutive plain lines.
    const plain: string[] = [];
    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !fencePattern.test(lines[index]) &&
      !headingPattern.test(lines[index]) &&
      !quotePattern.test(lines[index]) &&
      !bulletPattern.test(lines[index]) &&
      !orderedPattern.test(lines[index])
    ) {
      plain.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "p", text: plain.join(" ") });
  }
  return blocks;
}

const inlinePattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|_[^_\n]+_|\[[^\]]+\]\([^)\s]+\))/g;

function monospaceFont(): { fontFamily?: string } {
  if (Platform.OS === "ios") return { fontFamily: "Menlo" };
  if (Platform.OS === "android") return { fontFamily: "monospace" };
  return {};
}

function renderInline(text: string, theme: PluginTheme): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(<Fragment key={key++}>{text.slice(lastIndex, start)}</Fragment>);
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <Text key={key++} style={{ color: theme.colors.foreground, fontWeight: "700" }}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      nodes.push(
        <Text key={key++} style={{ color: theme.colors.foreground, fontStyle: "italic" }}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <Text
          key={key++}
          style={{
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface2,
            ...monospaceFont(),
            fontSize: 13,
          }}
        >
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        const url = link[2];
        nodes.push(
          <Text
            key={key++}
            style={{ color: theme.colors.accent }}
            onPress={() => {
              openExternal(url).catch(() => {});
            }}
          >
            {link[1]}
          </Text>,
        );
      } else {
        nodes.push(<Fragment key={key++}>{token}</Fragment>);
      }
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}

export function MarkdownText({ text, theme, compact }: { text: string; theme: PluginTheme; compact: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const styles = useMemo(
    () => ({
      paragraph: { color: theme.colors.foreground, fontSize: compact ? 14 : 15, lineHeight: 22 } as const,
      codeBlock: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
      } as const,
      codeText: { color: theme.colors.foreground, fontSize: compact ? 12 : 13, lineHeight: 18 } as const,
      heading1: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "700" } as const,
      heading2: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "700" } as const,
      heading3: { color: theme.colors.foreground, fontSize: 15, fontWeight: "700" } as const,
      heading4: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" } as const,
      quote: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 3,
        paddingLeft: 10,
      } as const,
      quoteText: { color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14, fontStyle: "italic" } as const,
      row: { flexDirection: "row", gap: 6 } as const,
      marker: { color: theme.colors.foregroundMuted, fontSize: compact ? 14 : 15, lineHeight: 22 } as const,
    }),
    [theme, compact],
  );
  const mono = monospaceFont();

  return (
    <View style={{ gap: 6 }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "code":
            return (
              <View key={index} style={styles.codeBlock}>
                <Text style={[styles.codeText, mono]}>{block.text}</Text>
              </View>
            );
          case "heading": {
            const headingStyle =
              block.level === 1
                ? styles.heading1
                : block.level === 2
                  ? styles.heading2
                  : block.level === 3
                    ? styles.heading3
                    : styles.heading4;
            return (
              <Text key={index} style={headingStyle}>
                {renderInline(block.text, theme)}
              </Text>
            );
          }
          case "bullet":
            return (
              <View key={index} style={{ gap: 2 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={styles.row}>
                    <Text style={styles.marker}>{"\u2022"}</Text>
                    <Text style={styles.paragraph}>
                      {renderInline(item, theme)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "ordered":
            return (
              <View key={index} style={{ gap: 2 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={styles.row}>
                    <Text style={styles.marker}>{item.marker}.</Text>
                    <Text style={styles.paragraph}>
                      {renderInline(item.text, theme)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "quote":
            return (
              <View key={index} style={styles.quote}>
                <Text style={styles.quoteText}>
                  {renderInline(block.text, theme)}
                </Text>
              </View>
            );
          case "p":
          default:
            return (
              <Text key={index} style={styles.paragraph}>
                {renderInline(block.text, theme)}
              </Text>
            );
        }
      })}
    </View>
  );
}
