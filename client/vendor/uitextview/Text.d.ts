import type { ComponentType, ReactNode } from "react";
import type { StyleProp, TextStyle } from "react-native";

export interface UITextViewProps {
  uiTextView?: boolean;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
  onPress?: () => void;
  onSelectionChange?: (event: { start: number; end: number }) => void;
  [key: string]: unknown;
}

export function UITextView(props: UITextViewProps): ReactNode;
