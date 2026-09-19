import { Platform, Text } from "react-native";
import { useEffect, useState, type ComponentType } from "react";
import type { StyleProp, TextProps, TextStyle } from "react-native";

/**
 * Markdown span primitive, platform-split internally:
 * - iOS: a UITextView span (react-native-uitextview; its native RNUITextView
 *   is already compiled into the Paseo app) so selection gets native
 *   word-level handles like Paseo's own renderer.
 * - Web: plain Text (react-native-web) with per-word selectable behavior.
 * - Android: plain selectable Text (Paseo's own Android-span behavior).
 *
 * The vendored UITextView module calls codegenNativeComponent at module scope,
 * which only exists on native builds; it is therefore loaded LAZILY through a
 * dynamic import on iOS render, never at bundle load on other platforms.
 */

type UITextViewProps = {
  uiTextView?: boolean;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  onPress?: () => void;
};

let cachedUITextView: ComponentType<UITextViewProps> | null | undefined;
// TEMPORARY DEBUG: surfaces why the UITextView module could not load, since
// client-side errors never reach the daemon logs.
export let uitextViewDebugInfo: string | null = null;

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
  const [spanComponent, setSpanComponent] = useState<ComponentType<UITextViewProps> | null | undefined>(
    Platform.OS === "ios" ? undefined : null,
  );

  useEffect(() => {
    if (Platform.OS !== "ios" || cachedUITextView !== undefined) return;
    void import("./vendor/uitextview/index.js")
      .then((mod) => {
        cachedUITextView = mod.UITextView as ComponentType<UITextViewProps>;
        uitextViewDebugInfo = "loaded";
        setSpanComponent(cachedUITextView);
        console.log("inline-review: uitextview module loaded on iOS");
      })
      .catch((error) => {
        cachedUITextView = null;
        uitextViewDebugInfo = `load failed: ${String(error?.message ?? error)}`;
        console.error("inline-review: uitextview load failed", error);
        setSpanComponent(null);
      });
  }, []);

  if (Platform.OS === "ios") {
    if (spanComponent) {
      const UITextViewSpan = spanComponent;
      return (
        <UITextViewSpan
          uiTextView
          selectable={selectable ?? true}
          style={style as never}
          onPress={onPress ? () => onPress({} as never) : undefined}
        >
          {children}
          {uitextViewDebugInfo && uitextViewDebugInfo !== "loaded" ? (
            <Text style={{ color: "#f85149", fontSize: 9 }}>
              {`[uitextview debug: ${uitextViewDebugInfo}]`}
            </Text>
          ) : null}
        </UITextViewSpan>
      );
    }
    // UITextView module not available yet (or at all): plain selectable Text
    // plus a visible debug hint for the user to screenshot.
    if (uitextViewDebugInfo && uitextViewDebugInfo !== "loaded") {
      return (
        <Text style={style} onPress={onPress}>
          {children}
          <Text style={{ color: "#f85149", fontSize: 11 }}>
            {` [uitextview debug: ${uitextViewDebugInfo}]`}
          </Text>
        </Text>
      );
    }
  }
  return (
    <Text selectable={selectable} style={style} onPress={onPress}>
      {children}
    </Text>
  );
}
