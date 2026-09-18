import { UITextView } from "./vendor/uitextview/Text.js";
import type { StyleProp, TextProps, TextStyle } from "react-native";

/**
 * iOS: each markdown span is a UITextView (react-native-uitextview, already
 * compiled into the Paseo app) so selection gets native word-level handles.
 * The library's TextAncestorContext hoists sibling spans into one paragraph
 * selection, exactly like Paseo's own MarkdownTextSpan.
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
