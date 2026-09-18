import type { PluginTheme } from "@getpaseo/plugin";
import Markdown, { type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import { useMemo } from "react";
import { openExternal } from "./web";

/**
 * Markdown rendering built on @ronradtke/react-native-markdown-display
 * (CommonMark + GFM tables). Paseo does not expose its native markdown
 * renderer to plugins, so the plugin bundles its own. Styles are mapped from
 * the host theme; links open through the host-provided external linker.
 *
 * The comment affordances live in timeline.tsx: each commented paragraph is a
 * chunk inside a Pressable, and this component renders one chunk.
 */

function markdownStyles(theme: PluginTheme, compact: boolean): MarkdownStyleMap {
  const body = compact ? 14 : 15;
  return {
    body: { color: theme.colors.foreground, fontSize: body, lineHeight: 22 },
    text: { color: theme.colors.foreground },
    textgroup: { color: theme.colors.foreground },
    paragraph: { color: theme.colors.foreground, marginTop: 2, marginBottom: 2 },
    strong: { color: theme.colors.foreground, fontWeight: "700" },
    em: { color: theme.colors.foreground },
    s: { color: theme.colors.foreground, textDecorationLine: "line-through" },
    ins: { color: theme.colors.foreground, textDecorationLine: "underline" },
    heading1: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, marginBottom: 2 },
    heading2: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, marginBottom: 2 },
    heading3: { color: theme.colors.foreground, fontSize: 15, marginBottom: 2 },
    heading4: { color: theme.colors.foreground, fontSize: 14, marginBottom: 2 },
    heading5: { color: theme.colors.foreground, fontSize: 13, marginBottom: 2 },
    heading6: { color: theme.colors.foreground, fontSize: 13, marginBottom: 2 },
    blockquote: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderLeftWidth: 3,
      marginLeft: 0,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    bullet_list_icon: { color: theme.colors.foregroundMuted, marginLeft: 4, marginRight: 4 },
    ordered_list_icon: { color: theme.colors.foregroundMuted, marginLeft: 4, marginRight: 4 },
    code_inline: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      padding: 2,
      borderRadius: 4,
    },
    code_block: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      padding: 10,
      borderRadius: 8,
    },
    fence: {
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      overflow: "hidden",
    },
    fence_code: { backgroundColor: theme.colors.surface2, padding: 10 },
    fence_token: { color: theme.colors.foreground, fontSize: compact ? 12 : 13, lineHeight: 18 },
    fence_language_label: { color: theme.colors.foregroundMuted, fontSize: 11 },
    fence_copy_button: { padding: 4 },
    fence_copy_text: { color: theme.colors.foregroundMuted, fontSize: 11 },
    hr: { backgroundColor: theme.colors.border, height: 1 },
    table: { borderColor: theme.colors.border, borderRadius: 6 },
    thead: { backgroundColor: theme.colors.surface2 },
    tr: { borderBottomColor: theme.colors.border, flexDirection: "row" },
    th: { color: theme.colors.foreground, fontSize: compact ? 12 : 13, padding: 6 },
    td: { color: theme.colors.foreground, fontSize: compact ? 12 : 13, padding: 6 },
    link: { color: theme.colors.accent, textDecorationLine: "underline" },
    blocklink: { borderColor: theme.colors.border },
    image: { borderRadius: 8 },
    hardbreak: { width: "100%", height: 1 },
  };
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
  const styles = useMemo(() => markdownStyles(theme, compact), [theme, compact]);
  return (
    <Markdown
      style={styles}
      mergeStyle={false}
      onLinkPress={(url) => {
        openExternal(url).catch(() => {});
        return true;
      }}
    >
      {text}
    </Markdown>
  );
}
