import type { InlineToken } from "../shared/markdown-parse";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, Fragment, type ReactNode } from "react";
import { Image, Platform, Text, View } from "react-native";
import { parseBlocks, parseInline } from "../shared/markdown-parse";
import { openExternalUrl } from "@getpaseo/plugin/client";

/**
 * Renders parsed markdown blocks with React Native primitives. Paseo does not
 * expose its native markdown renderer to plugins, so the plugin parses and
 * draws its own (see shared/markdown-parse.ts and test/markdown.test.ts).
 */

function monospaceFont(): { fontFamily?: string } {
  if (Platform.OS === "ios") return { fontFamily: "Menlo" };
  if (Platform.OS === "android") return { fontFamily: "monospace" };
  return {};
}

function InlineRun({
  tokens,
  theme,
  styles,
}: {
  tokens: InlineToken[];
  theme: PluginTheme;
  styles: ReturnType<typeof useStyles>;
}): ReactNode {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case "bold":
            return (
              <Text key={index} style={{ color: theme.colors.foreground, fontWeight: "700" }}>
                {token.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={index} style={{ color: theme.colors.foreground, fontStyle: "italic" }}>
                {token.text}
              </Text>
            );
          case "strike":
            return (
              <Text
                key={index}
                style={{ color: theme.colors.foreground, textDecorationLine: "line-through" }}
              >
                {token.text}
              </Text>
            );
          case "code":
            return (
              <Text
                key={index}
                style={{
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                  fontSize: styles.codeFontSize,
                  ...monospaceFont(),
                }}
              >
                {token.text}
              </Text>
            );
          case "image":
            // Inline image inside a text line renders as its alt text.
            return (
              <Text key={index} style={{ color: theme.colors.foregroundMuted }}>
                {`[${token.alt}]`}
              </Text>
            );
          case "link":
            return (
              <Text
                key={index}
                style={{ color: theme.colors.accent }}
                onPress={() => {
                  // Follow the same link rules as Paseo's own renderer: the
                  // host opener uses the system browser on desktop, a new tab
                  // on web, and ignores malformed or non-HTTP(S) URLs.
                  openExternalUrl(token.url).catch(() => {});
                }}
              >
                {token.text}
              </Text>
            );
          case "text":
          default:
            return <Fragment key={index}>{token.text}</Fragment>;
        }
      })}
    </>
  );
}

function Cell({ cell, theme, styles }: { cell: { spans: InlineToken[]; align: string }; theme: PluginTheme; styles: ReturnType<typeof useStyles> }) {
  return (
    <View style={{ flex: 1, padding: styles.cell.padding }}>
      <Text style={{ color: theme.colors.foreground, fontSize: styles.tableFontSize, textAlign: cell.align as "left" | "center" | "right" }}>
        <InlineRun tokens={cell.spans} theme={theme} styles={styles} />
      </Text>
    </View>
  );
}

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      codeFontSize: compact ? 12 : 13,
      tableFontSize: compact ? 12 : 13,
      cell: { padding: 6 } as const,
      blockGap: { gap: compact ? 6 : 8 } as const,
      paragraph: { color: theme.colors.foreground, fontSize: compact ? 14 : 15, lineHeight: 22 } as const,
      paragraphLine: { color: theme.colors.foreground, fontSize: compact ? 14 : 15, lineHeight: 22 } as const,
      codeBlock: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
      } as const,
      codeText: { color: theme.colors.foreground, fontSize: compact ? 12 : 13, lineHeight: 18 } as const,
      heading: (level: number) =>
        ({
          color: theme.colors.foreground,
          fontWeight: "700",
          fontSize: compact
            ? level === 1 ? 18 : level === 2 ? 16 : 15
            : level === 1 ? 20 : level === 2 ? 18 : 15,
        }) as const,
      quote: { borderLeftColor: theme.colors.border, borderLeftWidth: 3, paddingLeft: 10 } as const,
      quoteText: { color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14, fontStyle: "italic" } as const,
      listRow: { flexDirection: "row", gap: 6 } as const,
      marker: { color: theme.colors.foregroundMuted, fontSize: compact ? 14 : 15, lineHeight: 22 } as const,
      taskDone: { color: theme.colors.statusSuccess, fontSize: compact ? 14 : 15, lineHeight: 22 } as const,
      table: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        overflow: "hidden" as const,
      } as const,
      tableRow: { flexDirection: "row" } as const,
      headerRow: { backgroundColor: theme.colors.surface2 } as const,
      cellBorder: { borderColor: theme.colors.border } as const,
      hr: { height: 1, backgroundColor: theme.colors.border, marginVertical: 4 } as const,
      image: { width: "100%" as const, height: 180, borderRadius: 8, marginVertical: 2 } as const,
      paragraphGap: { gap: 4 } as const,
    }),
    [theme, compact],
  );
}

export function MarkdownText({
  text,
  theme,
  compact,
}: {
  text: string;
  theme: PluginTheme;
  compact: boolean;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const styles = useStyles(theme, compact);
  const mono = monospaceFont();

  function renderTextLines(lines: string[], style: object): ReactNode {
    return lines.map((line, index) => (
      <Text key={index} style={style}>
        <InlineRun tokens={parseInline(line)} theme={theme} styles={styles} />
      </Text>
    ));
  }

  return (
    <View style={styles.blockGap}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "code":
            return (
              <View key={index} style={styles.codeBlock}>
                <Text style={[mono, { color: theme.colors.foreground, fontSize: styles.codeFontSize, lineHeight: 18 }]}>
                  {block.text}
                </Text>
              </View>
            );
          case "heading":
            return (
              <Text
                key={index}
                style={{
                  color: theme.colors.foreground,
                  fontWeight: "700",
                  fontSize: compact
                    ? block.level === 1 ? 18 : block.level === 2 ? 16 : 15
                    : block.level === 1 ? 20 : block.level === 2 ? 18 : 15,
                }}
              >
                <InlineRun tokens={parseInline(block.text)} theme={theme} styles={styles} />
              </Text>
            );
          case "bullet":
            return (
              <View key={index} style={{ gap: 2 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.listRow, { paddingLeft: 14 * item.level }]}>
                    {item.task ? (
                      <Text style={item.checked ? styles.taskDone : styles.marker}>
                        {item.checked ? "\u2713" : "\u25CB"}
                      </Text>
                    ) : (
                      <Text style={styles.marker}>{"\u2022"}</Text>
                    )}
                    <Text style={styles.paragraph}>
                      <InlineRun tokens={item.spans} theme={theme} styles={styles} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "ordered":
            return (
              <View key={index} style={{ gap: 2 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.listRow, { paddingLeft: 14 * item.level }]}>
                    <Text style={styles.marker}>{item.marker}.</Text>
                    <Text style={styles.paragraph}>
                      <InlineRun tokens={item.spans} theme={theme} styles={styles} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "quote":
            return (
              <View key={index} style={styles.quote}>
                <Text style={styles.quoteText}>
                  <InlineRun tokens={parseInline(block.text)} theme={theme} styles={styles} />
                </Text>
              </View>
            );
          case "table":
            return (
              <View key={index} style={styles.table}>
                <View style={[styles.tableRow, styles.headerRow, styles.cellBorder, { borderBottomWidth: 1 }]}>
                  {block.header.map((cell, cellIndex) => (
                    <Cell key={cellIndex} cell={cell} theme={theme} styles={styles} />
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View
                    key={rowIndex}
                    style={[styles.tableRow, styles.cellBorder, rowIndex < block.rows.length - 1 ? { borderBottomWidth: 1 } : null]}
                  >
                    {row.map((cell, cellIndex) => (
                      <View key={cellIndex} style={[{ flex: 1 }, cellIndex < row.length - 1 ? { borderRightWidth: 1, borderColor: theme.colors.border } : null]}>
                        <Cell cell={cell} theme={theme} styles={styles} />
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );
          case "hr":
            return <View key={index} style={styles.hr} />;
          case "p":
          default: {
            const single = block.lines.length === 1 && parseInline(block.lines[0]).length === 1 && parseInline(block.lines[0])[0]?.type === "image";
            if (single) {
              const token = parseInline(block.lines[0])[0];
              if (token.type === "image") {
                return (
                  <Image
                    key={index}
                    source={{ uri: token.url }}
                    style={styles.image}
                    resizeMode="contain"
                    accessibilityLabel={token.alt}
                  />
                );
              }
            }
            return (
              <View key={index} style={styles.paragraphGap}>
                {renderTextLines(block.lines, styles.paragraphLine)}
              </View>
            );
          }
        }
      })}
    </View>
  );
}
