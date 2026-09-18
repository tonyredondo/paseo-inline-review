import { Text, type StyleProp, type TextProps, type TextStyle } from "react-native";

/**
 * Markdown span primitive. Default implementation (web + Android): a plain
 * Text. On Android <Text selectable> is Paseo's own native-span behavior.
 */
export function MarkdownSpan({
  style,
  children,
  onPress,
  selectable,
  uiTextView,
  onSelectionChange,
}: {
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  onPress?: TextProps["onPress"];
  selectable?: boolean;
  uiTextView?: boolean;
  onSelectionChange?: unknown;
}) {
  return (
    <Text selectable={selectable} style={style} onPress={onPress}>
      {children}
    </Text>
  );
}
