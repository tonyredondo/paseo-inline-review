import { Platform, Text } from "react-native";
import { UITextView } from "./vendor/uitextview/Text.js";
import type { StyleProp, TextProps, TextStyle } from "react-native";

/**
 * Markdown span primitive, platform-split internally:
 * - iOS: a UITextView span (react-native-uitextview; its native RNUITextView
 *   is already compiled into the Paseo app) so selection gets native
 *   word-level handles like Paseo's own renderer.
 * - Web: plain Text (react-native-web) with per-word selectable behavior.
 * - Android: plain selectable Text (Paseo's own Android-span behavior).
 */
export function MarkdownSpan({
  style,
  children,
  onPress,
  selectable,
  uiTextView,
}: {
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  onPress?: TextProps["onPress"];
  selectable?: boolean;
  uiTextView?: boolean;
}) {
  if (Platform.OS === "ios") {
    return (
      <UITextView
        uiTextView
        selectable={selectable ?? true}
        style={style as never}
        onPress={onPress ? () => onPress({} as never) : undefined}
      >
        {children}
      </UITextView>
    );
  }
  return (
    <Text selectable={selectable} style={style} onPress={onPress}>
      {children}
    </Text>
  );
}
