import type { InlineToken } from "../shared/markdown-parse";
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MarkdownSpan } from "./markdown-span";
import { isValidHttpUrl, openInBrowserRpc } from "../shared/review";
import { classifyLocalFileLink, type LocalFileTarget } from "../shared/markdown-parse";
import {
  extractRefDefs,
  parseBlocks,
  parseInline,
  type Block,
} from "../shared/markdown-parse";
import { highlightCode, type CodeToken, type CodeTokenType } from "../shared/syntax";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";

/**
 * Renders parsed markdown blocks with React Native primitives. Paseo does not
 * expose its native markdown renderer to plugins, so the plugin parses and
 * draws its own (see shared/markdown-parse.ts and test/markdown.test.ts).
 */

// iOS has no CSS-style overflow-wrap: a long identifier that cannot fit a
// justified line stretches the previous line instead of breaking. Insert
// zero-width spaces inside long unbroken words (separators and camelCase
// boundaries) to give the text layout break opportunities. Web does not need
// this (overflow-wrap: anywhere breaks without polluting copied text) and
// Android breaks long words natively, so this is iOS-only.
const ZWSP = "\u200B";

/** Code blocks longer than this collapse behind a "Show more" control. */
const CODE_COLLAPSE_LINES = 40;

/** Converts #rrggbb to rgba() so fills can fade without losing hue. */
/** Line-highlight band over the black code background (gutter included). */
const HIGHLIGHT_ALPHA = 0.38;

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function breakLongWords(text: string): string {
  if (Platform.OS !== "ios") return text;
  return text
    .split(/(\s+)/)
    .map((piece) => {
      if (/\s/.test(piece) || piece.length < 14) return piece;
      return piece
        .replace(/([._/\-])(?=[A-Za-z0-9])/g, `$1${ZWSP}`)
        .replace(/([a-z0-9])(?=[A-Z])/g, `$1${ZWSP}`);
    })
    .join("");
}

async function openLink(
  url: string,
  openUrlViaDaemon: ((input: { url: string }) => Promise<{ ok: boolean }>) | null,
): Promise<void> {
  // mailto: and other schemes skip the http check; the OS opener routes them.
  if (!url.startsWith("mailto:") && !isValidHttpUrl(url)) return;
  // 1. Host-injected external opener (system browser) when the app provides it.
  if (typeof openExternalUrl === "function") {
    try {
      await openExternalUrl(url);
      return;
    } catch {
      // fall through
    }
  }
  // 2. Daemon-side OS opener: the default browser with full browser chrome.
  if (openUrlViaDaemon) {
    try {
      const result = await openUrlViaDaemon({ url });
      if (result.ok) return;
    } catch {
      // fall through
    }
  }
  // 3. React Native opener as the last resort.
  await Linking.openURL(url);
}

/**
 * Lightens a #rrggbb color toward white so accent-colored text stays readable
 * on muted themes. factor 0 keeps the color, 1 yields white.
 */
function lighten(hex: string, factor: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const lifted = channels
    .map((channel) => Math.round(channel + (255 - channel) * factor))
    .map((channel) => channel.toString(16).padStart(2, "0"));
  return `#${lifted.join("")}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return { h: 0, s: 0, l: 0.5 };
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) / 360;
  const sat = Math.min(1, Math.max(0, s));
  const lig = Math.min(1, Math.max(0, l));
  if (sat === 0) {
    const gray = Math.round(lig * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${gray}${gray}${gray}`;
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  function channel(t: number): number {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  }
  const rgb = [hue + 1 / 3, hue, hue - 1 / 3]
    .map((t) => Math.round(Math.min(1, Math.max(0, channel(t))) * 255).toString(16).padStart(2, "0"));
  return `#${rgb.join("")}`;
}

function monospaceFont(): { fontFamily?: string } {
  if (Platform.OS === "ios") return { fontFamily: "Menlo" };
  if (Platform.OS === "android") return { fontFamily: "monospace" };
  // Web (desktop + browser): pass a CSS stack through react-native-web.
  return { fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" };
}

function InlineRun({
  tokens,
  theme,
  styles,
  refs,
  selectable,
  localFileResolver,
  onLocalFilePress,
}: {
  tokens: InlineToken[];
  theme: PluginTheme;
  styles: ReturnType<typeof useStyles>;
  refs?: Map<string, string>;
  /** Native: each word becomes its own selectable Text (word-level selection). */
  selectable?: boolean;
  /** Classifies a link href as a local file target (null = external). */
  localFileResolver?: (href: string) => LocalFileTarget | null;
  /** Pressed a local file link: (path, lineStart?, lineEnd?). */
  onLocalFilePress?: (target: LocalFileTarget) => void;
}): ReactNode {
  const openUrlViaDaemon = useRpc(openInBrowserRpc);
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case "bold":
            return (
              <MarkdownSpan key={index} style={{ color: theme.colors.foreground, fontWeight: "700" }} selectable={selectable}>
                {token.tokens ? <InlineRun tokens={token.tokens} theme={theme} styles={styles} refs={refs} selectable={selectable} /> : breakLongWords(token.text)}
              </MarkdownSpan>
            );
          case "italic":
            return (
              <MarkdownSpan key={index} style={{ color: theme.colors.foreground, fontStyle: "italic" }} selectable={selectable}>
                {token.tokens ? <InlineRun tokens={token.tokens} theme={theme} styles={styles} refs={refs} selectable={selectable} /> : breakLongWords(token.text)}
              </MarkdownSpan>
            );
          case "strike":
            return (
              <MarkdownSpan
                key={index}
                style={{ color: theme.colors.foreground, textDecorationLine: "line-through" }}
                selectable={selectable}
              >
                {token.tokens ? <InlineRun tokens={token.tokens} theme={theme} styles={styles} refs={refs} selectable={selectable} /> : breakLongWords(token.text)}
              </MarkdownSpan>
            );
          case "code":
            return (
              <MarkdownSpan
                key={index}
                style={{
                  color: lighten(theme.colors.accent, 0.45),
                  backgroundColor: theme.colors.surface2,
                  fontSize: styles.codeFontSize,
                  paddingHorizontal: 5,
                  paddingVertical: 2,
                  borderRadius: 6,
                  ...monospaceFont(),
                }}
                selectable={selectable}
              >
                {breakLongWords(token.text)}
              </MarkdownSpan>
            );
          case "image": {
            // Inline image inside a text line renders as its alt text; when the
            // image is wrapped in a link, the whole placeholder is tappable.
            const image = (
              <MarkdownSpan key={index} style={{ color: theme.colors.foregroundMuted }} selectable={selectable}>
                {`[${token.alt}]`}
              </MarkdownSpan>
            );
            if (!token.linkUrl) return image;
            return (
              <MarkdownSpan
                key={index}
                style={{ color: theme.colors.accent }}
                onPress={() => {
                  void openLink(token.linkUrl ?? "", openUrlViaDaemon);
                }}
              >
                {image}
              </MarkdownSpan>
            );
          }
          case "footnoteRef":
            return (
              <MarkdownSpan
                key={index}
                style={{ color: theme.colors.accent, fontSize: styles.codeFontSize - 1, fontWeight: "600" }}
                selectable={selectable}
              >
                {`[^${token.label}]`}
              </MarkdownSpan>
            );
          case "link": {
            // Link text parses recursively: bold/code inside a link renders
            // styled inside the link instead of showing raw markdown.
            const nested = token.tokens ? (
              <InlineRun
                tokens={token.tokens}
                theme={theme}
                styles={styles}
                refs={refs}
                selectable={selectable}
                localFileResolver={localFileResolver}
                onLocalFilePress={onLocalFilePress}
              />
            ) : (
              token.text
            );
            const localTarget = localFileResolver?.(token.url) ?? null;
            return (
              <MarkdownSpan
                key={index}
                style={{ color: theme.colors.accent }}
                onPress={() => {
                  if (localTarget) {
                    onLocalFilePress?.(localTarget);
                    return;
                  }
                  void openLink(token.url, openUrlViaDaemon);
                }}
              >
                {nested}
              </MarkdownSpan>
            );
          }
          case "break":
            return <Text key={index}>{"\n"}</Text>;
          case "text":
          default: {
            const broken = breakLongWords(token.text);
            if (!selectable) return <Fragment key={index}>{broken}</Fragment>;
            // Word-level selectable fragments: long-press selects the touched
            // word instead of the whole paragraph.
            return (
              <Fragment key={index}>
                {broken.split(/(\s+)/).map((piece, pieceIndex) =>
                  piece.length > 0 ? (
                    <MarkdownSpan key={pieceIndex} selectable>
                      {piece}
                    </MarkdownSpan>
                  ) : null,
                )}
              </Fragment>
            );
          }
        }
      })}
    </>
  );
}


/** Collapsible <details> section: tap the summary row to expand. */
function DetailsView({
  block,
  theme,
  compact,
  refs,
  selectable,
  styles,
}: {
  block: Extract<Block, { kind: "details" }>;
  theme: PluginTheme;
  compact: boolean;
  refs?: Map<string, string>;
  selectable?: boolean;
  styles: ReturnType<typeof useStyles>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View
      style={{
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Toggle ${block.summary || "details"}`}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, gap: 6 }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{open ? "▼" : "▶"}</Text>
        <MarkdownSpan style={{ color: theme.colors.foreground, fontWeight: "700", flex: 1, fontSize: compact ? 13 : 14 }}>
          {block.summary || "Details"}
        </MarkdownSpan>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 8 }}>
          <MarkdownText text={block.lines.join("\n")} theme={theme} compact={compact} refs={refs} selectable={selectable} />
        </View>
      ) : null}
    </View>
  );
}

/** Self-contained code block for out-of-module callers (file preview sheet). */
export function FileCodeBlock({
  code,
  language,
  theme,
  compact,
  forceShowAll,
  highlightStart,
  highlightEnd,
}: {
  code: string;
  language: string;
  theme: PluginTheme;
  compact: boolean;
  /** Never collapse: render the whole content (file preview). */
  forceShowAll?: boolean;
  /** 1-based line range to highlight (from the file link's line suffix). */
  highlightStart?: number;
  highlightEnd?: number;
}): ReactNode {
  const styles = useStyles(theme, compact);
  return (
    <CodeBlockView
      code={code}
      language={language}
      theme={theme}
      styles={styles}
      forceShowAll={forceShowAll}
      highlightStart={highlightStart}
      highlightEnd={highlightEnd}
    />
  );
}

export function CodeBlockView({
  code,
  language,
  theme,
  styles,
  onComment,
  forceShowAll,
  highlightStart,
  highlightEnd,
}: {
  code: string;
  language: string;
  theme: PluginTheme;
  styles: ReturnType<typeof useStyles>;
  /** Opens the inline review editor for the code block's paragraph. */
  onComment?: () => void;
  /** Preview mode: never collapse, show the whole file. */
  forceShowAll?: boolean;
  /** 1-based line range to highlight (from the file link's line suffix). */
  highlightStart?: number;
  highlightEnd?: number;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);
  const allLines = useMemo(() => highlightCode(code, language), [code, language]);
  // Very long dumps collapse: first COLLAPSE_LINES + an expander.
  const [showAll, setShowAll] = useState(false);
  // Scroll mode is the default everywhere; wrap is the secondary option.
  const [wrapMode, setWrapMode] = useState(false);
  const collapsed = allLines.length > CODE_COLLAPSE_LINES && !showAll && !forceShowAll;
  const lines = collapsed ? allLines.slice(0, CODE_COLLAPSE_LINES) : allLines;
  // Line highlight from the file link suffix (`span.go:467`, `#L12-L20`).
  const highlightFrom = highlightStart ?? null;
  const highlightTo = highlightEnd ?? highlightStart ?? null;
  const lineIsHighlighted = (lineIndex: number): boolean => {
    if (highlightFrom === null || highlightTo === null) return false;
    const line = lineIndex + 1;
    return line >= highlightFrom && line <= highlightTo;
  };
  // Fixed custom palette (One Dark-inspired), vivid on the black background.
  const darkPalette = {
    plain: "#d7dce3",
    keyword: "#c678dd",
    string: "#98c379",
    comment: "#7f848e",
    number: "#d19a66",
    function: "#61afef",
    type: "#e5c07b",
    added: "#3fb950",
    removed: "#f85149",
    meta: "#c8b3ff",
  };
  const mono = monospaceFont();
  // Web: code lines must not wrap; they scroll horizontally instead.
  const nowrap =
    Platform.OS === "web" ? ({ whiteSpace: "pre", flexWrap: "nowrap" } as object) : undefined;

  async function copy(): Promise<void> {
    try {
      await copyText(code);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = (setTimeout(() => setCopied(false), 2000) as unknown) as number;
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <View style={styles.codeBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy code"
        style={styles.copyButton}
        onPress={() => {
          void copy();
        }}
      >
        {copied ? (
          <Text style={styles.copyText}>Copied</Text>
        ) : (
          <Icon name="Copy" size={13} color="#8b949e" />
        )}
      </Pressable>
      {(() => {
        // Line-number gutter. Web: a fixed column left of the scrolling code
        // (lines never wrap there, so heights align 1:1). Native: the number
        // rides on each line row so wrapped lines keep their number top-aligned.
        const digits = String(lines.length).length;
        // Generous mono width (0.68em per char) plus padding: a too-tight
        // fixed width makes the number itself wrap ("14" / "5") in wrap mode.
        const gutterWidth = Math.max(2, digits) * styles.codeFontSize * 0.68 + 16;
        const gutterColor = "#565e69";
        const gutterRule = "rgba(139,148,158,0.25)";
        if (!wrapMode) {
          return (
            <View style={{ flexDirection: "row", alignItems: "stretch" }}>
              <View
                style={{
                  minWidth: gutterWidth,
                  paddingRight: 10,
                  borderRightWidth: StyleSheet.hairlineWidth,
                  borderRightColor: gutterRule,
                }}
              >
                {lines.map((_, lineIndex) => (
                  <Text
                    key={lineIndex}
                    style={[
                      mono,
                      {
                        color: gutterColor,
                        fontSize: styles.codeFontSize,
                        lineHeight: 18,
                        textAlign: "right",
                        // Highlighted rows paint the gutter cell too.
                        ...(lineIsHighlighted(lineIndex) ? { backgroundColor: withAlpha(theme.colors.accent, HIGHLIGHT_ALPHA) } : null),
                      },
                    ]}
                  >
                    {lineIndex + 1}
                  </Text>
                ))}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }}>
                {/* Column layout: the container width grows to the longest
                    line, so the horizontal scroll range is right and each
                    line stays on its own row, aligned with its number. */}
                <View style={{ alignItems: "flex-start", paddingLeft: 10 }}>
                  {lines.map((line, lineIndex) => (
                    <Text
                      key={lineIndex}
                      style={[
                        mono,
                        nowrap,
                        {
                          color: darkPalette.plain,
                          fontSize: styles.codeFontSize,
                          lineHeight: 18,
                          // Highlighted rows paint the trailing empty space
                          // too: stretch the row to the container width
                          // (the longest line) instead of hugging the text.
                          ...(lineIsHighlighted(lineIndex)
                            ? { backgroundColor: withAlpha(theme.colors.accent, HIGHLIGHT_ALPHA), alignSelf: "stretch" as const }
                            : null),
                        },
                      ]}
                    >
                      {line.length === 0
                        ? " "
                        : line.map((token: CodeToken, tokenIndex: number) => (
                            <Text key={tokenIndex} style={[mono, { color: darkPalette[token.type as keyof typeof darkPalette] }]}>
                              {token.text}
                            </Text>
                          ))}
                    </Text>
                  ))}
                </View>
              </ScrollView>
            </View>
          );
        }
        const webWrap = Platform.OS === "web" && wrapMode;
        return (
          <View>
            {lines.map((line, lineIndex) => (
              <View
                key={lineIndex}
                style={{
                  flexDirection: "row",
                  backgroundColor: lineIsHighlighted(lineIndex) ? withAlpha(theme.colors.accent, HIGHLIGHT_ALPHA) : "transparent",
                }}
              >
                <Text
                  style={[
                    mono,
                    {
                      color: gutterColor,
                      fontSize: styles.codeFontSize,
                      lineHeight: 18,
                      textAlign: "right",
                      width: gutterWidth,
                      paddingRight: 10,
                      // The number never wraps onto two lines.
                      ...(nowrap ?? null),
                    },
                  ]}
                >
                  {lineIndex + 1}
                </Text>
                <Text
                  style={[
                    mono,
                    {
                      color: darkPalette.plain,
                      fontSize: styles.codeFontSize,
                      lineHeight: 18,
                      flex: 1,
                      borderLeftWidth: StyleSheet.hairlineWidth,
                      borderLeftColor: gutterRule,
                      paddingLeft: 10,
                      ...(webWrap ? ({ whiteSpace: "pre-wrap" } as object) : null),
                    },
                  ]}
                >
                  {line.map((token: CodeToken, tokenIndex: number) => (
                    <Text key={tokenIndex} style={[mono, { color: darkPalette[token.type as keyof typeof darkPalette] }]}>
                      {token.text}
                    </Text>
                  ))}
                </Text>
              </View>
            ))}
          </View>
        );
      })()}
      {collapsed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show more lines"
          onPress={() => setShowAll(true)}
          style={{ paddingTop: 6 }}
        >
          <Text style={{ color: "#58a6ff", fontSize: 11 }}>
            {`Show ${allLines.length - lines.length} more lines`}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingTop: 6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={wrapMode ? "Scroll long lines" : "Wrap long lines"}
          onPress={() => setWrapMode((value) => !value)}
        >
          <Text style={{ color: "#8b949e", fontSize: 11 }}>{wrapMode ? "Scroll" : "Wrap"}</Text>
        </Pressable>
        {onComment ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comment on this code block"
            onPress={onComment}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name="MessageSquareQuote" size={11} color="#8b949e" />
              <Text style={{ color: "#8b949e", fontSize: 11 }}>Comment</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Cell({ cell, theme, styles, flex }: { cell: { spans: InlineToken[]; align: string }; theme: PluginTheme; styles: ReturnType<typeof useStyles>; flex: number }) {
  return (
    <View style={{ flex, padding: styles.cell.padding }}>
      <Text style={{ color: theme.colors.foreground, fontSize: styles.tableFontSize, textAlign: cell.align as "left" | "center" | "right" }}>
        <InlineRun tokens={cell.spans} theme={theme} styles={styles} />
      </Text>
    </View>
  );
}

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      codeFontSize: Platform.OS === "ios" ? (compact ? 11 : 12) : compact ? 12 : 13,
      tableFontSize: compact ? 12 : 13,
      cell: { padding: 6 } as const,
      blockGap: { gap: compact ? 10 : 14 } as const,
      // Normal left alignment (user preference over justified text).
      // overflow-wrap still lets very long identifiers break instead of
      // overflowing narrow lines (web; iOS gets ZWSP breaks, Android native).
      paragraph: {
        color: theme.colors.foreground,
        fontSize: compact ? 14 : 15,
        lineHeight: 22,
        overflowWrap: "anywhere",
      } as const,
      paragraphLine: {
        color: theme.colors.foreground,
        fontSize: compact ? 14 : 15,
        lineHeight: 22,
        overflowWrap: "anywhere",
      } as const,
      codeBlock: {
        backgroundColor: "#000000",
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
      } as const,
      copyButton: { position: "absolute", top: 6, right: 6, padding: 4, borderRadius: 6 } as const,
      copyText: { color: "#58a6ff", fontSize: 11 } as const,
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
      image: { width: "100%" as const, height: 180, borderRadius: 8, marginVertical: 2 } as const,
      paragraphGap: { gap: 0 } as const,
    }),
    [theme, compact],
  );
}

export function MarkdownText({
  text,
  theme,
  compact,
  refs,
  selectable,
  onChunkPress,
  onCommentRequest,
  onListItemPress,
  listItemExtras,
  localFileResolver,
  onLocalFilePress,
}: {
  text: string;
  theme: PluginTheme;
  compact: boolean;
  /** Reference link definitions extracted from the full message. */
  refs?: Map<string, string>;
  /** Native only: enables the platform text selection on rendered text. */
  selectable?: boolean;
  /** Native only: called when the user taps the chunk (used for double-tap). */
  onChunkPress?: () => void;
  /** Rendered as a Comment control on code blocks; opens the review editor. */
  onCommentRequest?: () => void;
  /** Tapped one markdown list item: (itemIndex, itemText, event). */
  onListItemPress?: (itemIndex: number, itemText: string, event?: unknown) => void;
  /** Per-item extras (comment cards) rendered below each list item. */
  listItemExtras?: (itemIndex: number) => ReactNode;
  /** Classifies a link href as a local file target (null = external). */
  localFileResolver?: (href: string) => LocalFileTarget | null;
  /** Pressed a local file link: (path, lineStart?, lineEnd?). */
  onLocalFilePress?: (target: LocalFileTarget) => void;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const styles = useStyles(theme, compact);
  const mono = monospaceFont();

  function renderTextLines(lines: string[], style: object): ReactNode {
    return lines.map((line, index) => (
      <MarkdownSpan key={index} style={style} uiTextView selectable={selectable} onPress={onChunkPress}>
        <InlineRun
          tokens={parseInline(line, refs)}
          theme={theme}
          styles={styles}
          refs={refs}
          selectable={selectable}
          localFileResolver={localFileResolver}
          onLocalFilePress={onLocalFilePress}
        />
      </MarkdownSpan>
    ));
  }

  return (
    <View style={styles.blockGap}>
      {blocks.map((block, index) => {
        const startsNumbered =
          (block.kind === "p" && /^\s*\d+[.)]\s/.test(block.lines[0] ?? "")) ||
          block.kind === "ordered" || block.kind === "bullet";
        const blockSpacing = startsNumbered ? { marginTop: 10 } : null;
        const weights =
          block.kind === "table"
            ? block.header.map((cell, columnIndex) => {
                let max = cell.text.length;
                for (const row of block.rows) {
                  const candidate = (row[columnIndex]?.text ?? "").length;
                  if (candidate > max) max = candidate;
                }
                return Math.min(8, Math.max(1, Math.round(max / 14)));
              })
            : null;
        switch (block.kind) {
          case "code":
            return (
              <CodeBlockView
                key={index}
                code={block.text}
                language={block.language ?? ""}
                theme={theme}
                styles={styles}
                onComment={onCommentRequest}
              />
            );
          case "heading":
            return (
              <Fragment key={index}>
                <MarkdownSpan
                  uiTextView
                  style={{
                    color: theme.colors.foreground,
                    fontWeight: "700",
                    marginTop: block.level === 1 ? 16 : 12,
                    marginBottom: block.level <= 2 ? 2 : 8,
                    fontSize: compact
                      ? block.level === 1 ? 20 : block.level === 2 ? 17 : block.level === 3 ? 16 : 15
                      : block.level === 1 ? 22 : block.level === 2 ? 19 : block.level === 3 ? 17 : 16,
                  }}
                >
                  <InlineRun tokens={parseInline(block.text, refs)} theme={theme} styles={styles} refs={refs} />
                </MarkdownSpan>
                {block.level <= 2 ? (
                  <View
                    style={{
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: theme.colors.foregroundMuted,
                      opacity: 0.35,
                    }}
                  />
                ) : null}
              </Fragment>
            );
          case "bullet":
            return (
              <View key={index} style={{ gap: 6, marginTop: 10 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.listRow, { paddingLeft: 14 * item.level }]}>
                    {item.task ? (
                      <Text style={item.checked ? styles.taskDone : styles.marker}>
                        {item.checked ? "\u2713" : "\u25CB"}
                      </Text>
                    ) : (
                      <Text style={styles.marker}>{"\u2022"}</Text>
                    )}
                    <View style={{ flex: 1, gap: 4 }}>
                      <MarkdownSpan
                        style={styles.paragraph}
                        uiTextView
                        selectable={selectable}
                        onPress={onListItemPress ? (event) => onListItemPress(itemIndex, item.spans.map((token) => ("text" in token ? token.text : "")).join(""), event) : undefined}
                      >
                        <InlineRun
                        tokens={item.spans}
                        theme={theme}
                        styles={styles}
                        selectable={selectable}
                        localFileResolver={localFileResolver}
                        onLocalFilePress={onLocalFilePress}
                      />
                      </MarkdownSpan>
                      {listItemExtras ? listItemExtras(itemIndex) : null}
                    </View>
                  </View>
                ))}
              </View>
            );
          case "ordered":
            return (
              <View key={index} style={{ gap: 6, marginTop: 10 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.listRow, { paddingLeft: 14 * item.level }]}>
                    <Text style={styles.marker}>{item.marker}.</Text>
                    <View style={{ flex: 1, gap: 4 }}>
                      <MarkdownSpan
                        style={styles.paragraph}
                        uiTextView
                        selectable={selectable}
                        onPress={onListItemPress ? (event) => onListItemPress(itemIndex, item.spans.map((token) => ("text" in token ? token.text : "")).join(""), event) : undefined}
                      >
                        <InlineRun
                        tokens={item.spans}
                        theme={theme}
                        styles={styles}
                        selectable={selectable}
                        localFileResolver={localFileResolver}
                        onLocalFilePress={onLocalFilePress}
                      />
                      </MarkdownSpan>
                      {listItemExtras ? listItemExtras(itemIndex) : null}
                    </View>
                  </View>
                ))}
              </View>
            );
          case "details": {
            return (
              <DetailsView
                key={index}
                block={block}
                theme={theme}
                compact={compact}
                refs={refs}
                selectable={selectable}
                styles={styles}
              />
            );
          }
          case "footnote": {
            return (
              <View key={index} style={{ gap: 2 }}>
                <MarkdownSpan style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 }} selectable={selectable}>
                  <Text style={{ color: theme.colors.accent, fontWeight: "700" }}>{`[^${block.label}]`}</Text>
                  {" "}
                  <InlineRun tokens={parseInline(block.text, refs)} theme={theme} styles={styles} refs={refs} selectable={selectable} />
                </MarkdownSpan>
              </View>
            );
          }
          case "alert": {
            const alertColors: Record<string, string> = {
              note: "#58a6ff",
              tip: "#3fb950",
              important: "#ab7df8",
              warning: "#d29922",
              caution: "#f85149",
            };
            const alertLabels: Record<string, string> = {
              note: "Note",
              tip: "Tip",
              important: "Important",
              warning: "Warning",
              caution: "Caution",
            };
            const alertIcons: Record<string, string> = {
              note: "Info",
              tip: "Lightbulb",
              important: "CircleAlert",
              warning: "TriangleAlert",
              caution: "OctagonAlert",
            };
            const alertColor = alertColors[block.alertType] ?? "#58a6ff";
            return (
              <View
                key={index}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: alertColor,
                  backgroundColor: theme.colors.surface2,
                  borderRadius: 6,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Icon name={alertIcons[block.alertType] ?? "Info"} size={14} color={alertColor} />
                  <MarkdownSpan style={{ color: alertColor, fontWeight: "700", fontSize: compact ? 13 : 14 }}>
                    {alertLabels[block.alertType]}
                  </MarkdownSpan>
                </View>
                <MarkdownText
                  text={block.lines.join("\n")}
                  theme={theme}
                  compact={compact}
                  refs={refs}
                  selectable={selectable}
                />
              </View>
            );
          }
          case "quote":
            // Quote content re-parses as nested markdown, so tables, fences
            // and lists inside a quote render fully. Deep quotes keep their
            // indent through the recursive MarkdownText (depth via ">", ">>").
            return (
              <View
                key={index}
                style={[styles.quote, { marginLeft: 10 * Math.max(0, block.depth - 1) }]}
              >
                <MarkdownText text={block.text} theme={theme} compact={compact} refs={refs} selectable={selectable} />
              </View>
            );
          case "table":
            return (
              <View key={index} style={styles.table}>
                <View style={[styles.tableRow, styles.headerRow, styles.cellBorder, { borderBottomWidth: 1 }]}>
                  {block.header.map((cell, cellIndex) => (
                    <Cell key={cellIndex} cell={cell} theme={theme} styles={styles} flex={weights?.[cellIndex] ?? 1} />
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View
                    key={rowIndex}
                    style={[styles.tableRow, styles.cellBorder, rowIndex < block.rows.length - 1 ? { borderBottomWidth: 1 } : null]}
                  >
                    {row.map((cell, cellIndex) => (
                      <View key={cellIndex} style={[{ flex: weights?.[cellIndex] ?? 1 }, cellIndex < row.length - 1 ? { borderRightWidth: 1, borderColor: theme.colors.border } : null]}>
                        <Cell cell={cell} theme={theme} styles={styles} flex={weights?.[cellIndex] ?? 1} />
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );
          case "hr":
            // Host-style "---" rules read as stray lines between messages;
            // drop them (the paragraph spacing already separates sections).
            return null;
          case "p":
          default: {
            const single = block.lines.length === 1 && parseInline(block.lines[0]).length === 1 && parseInline(block.lines[0])[0]?.type === "image";
            if (single) {
              const token = parseInline(block.lines[0], refs)[0];
              if (token.type === "image") {
                return (
                  <Image
                    key={index}
                    source={{ uri: token.url }}
                    style={[styles.image, blockSpacing ?? null]}
                    resizeMode="contain"
                    accessibilityLabel={token.alt}
                  />
                );
              }
            }
            return (
              <View key={index} style={[styles.paragraphGap, blockSpacing]}>
                {renderTextLines(block.lines, styles.paragraphLine)}
              </View>
            );
          }
        }
      })}
    </View>
  );
}
