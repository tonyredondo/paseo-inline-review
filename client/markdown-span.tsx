import { Text } from "react-native";
import type { StyleProp, TextProps, TextStyle } from "react-native";

/**
 * Markdown span primitive. Every platform ends up as a Text:
 * - Web: word-level selectable Texts are rendered by the caller.
 * - Android/iOS: <Text selectable> per span (Paseo's own Android-span model).
 *
 * A vendored react-native-uitextview (native UITextView selection like
 * Paseo's internal renderer) is not possible from a plugin: its codegen
 * module registers RNUITextView/RNUITextViewChild, which the app has already
 * registered - "Tried to register two views with the same name". That requires
 * Paseo to expose uitextview as a host module (upstream discussion 5055).
 */
export function MarkdownSpan({
  style,
  children,
  onPress,
  selectable,
}: {
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  onPress?: TextProps["onPress"];
  selectable?: boolean;
}) {
  return (
    <Text selectable={selectable} style={style} onPress={onPress}>
      {children}
    </Text>
  );
}
