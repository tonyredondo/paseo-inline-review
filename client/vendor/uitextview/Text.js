"use strict";

import React from 'react';
import { Platform, StyleSheet, Text as RNText } from 'react-native';
import RNUITextViewChildNativeComponent from './RNUITextViewChildNativeComponent';
import RNUITextViewNativeComponent from './RNUITextViewNativeComponent';
import { flattenStyles } from "./util.js";
import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
const TextAncestorContext = /*#__PURE__*/React.createContext([false, StyleSheet.create({})]);
const textDefaults = {
  allowFontScaling: true,
  selectable: true
};
const useTextAncestorContext = () => React.useContext(TextAncestorContext);

/**
 * Event fired by `onSelectionChange`. `start`/`end` are 0-based UTF-16 indices
 * into the rendered string. `start === end` means the selection was cleared.
 */

function UITextViewChild({
  style,
  children,
  ...rest
}) {
  const [isAncestor, rootStyle] = useTextAncestorContext();

  // Flatten the styles, and apply the root styles when needed
  const flattenedStyle = React.useMemo(() => flattenStyles(rootStyle, style), [rootStyle, style]);
  if (!isAncestor) {
    return /*#__PURE__*/_jsx(TextAncestorContext.Provider, {
      value: [true, flattenedStyle],
      children: /*#__PURE__*/_jsx(RNUITextViewNativeComponent, {
        ...textDefaults,
        ...rest,
        // ellipsizeMode={rest.ellipsizeMode ?? rest.lineBreakMode ?? 'tail'}
        style: [flattenedStyle]
        // @ts-expect-error Weirdness
        ,
        onPress: undefined,
        onLongPress: undefined,
        children: React.Children.toArray(children).map((c, index) => {
          if (/*#__PURE__*/React.isValidElement(c)) {
            return c;
          } else if (typeof c === 'string' || typeof c === 'number') {
            return (
              /*#__PURE__*/
              // @ts-expect-error @TODO fix this type
              _jsx(RNUITextViewChildNativeComponent, {
                style: flattenedStyle,
                text: c.toString(),
                ...rest
              }, index)
            );
          }
          return null;
        })
      })
    });
  } else {
    return /*#__PURE__*/_jsx(_Fragment, {
      children: React.Children.toArray(children).map((c, index) => {
        if (/*#__PURE__*/React.isValidElement(c)) {
          return c;
        } else if (typeof c === 'string' || typeof c === 'number') {
          return (
            /*#__PURE__*/
            // @ts-expect-error @TODO fix this type
            _jsx(RNUITextViewChildNativeComponent, {
              style: flattenedStyle,
              text: c.toString(),
              ...rest
            }, index)
          );
        }
        return null;
      })
    });
  }
}
function UITextViewInner(props) {
  const [isAncestor] = useTextAncestorContext();

  // Even if the uiTextView prop is set, we can still default to using
  // normal selection (i.e. base RN text) if the text doesn't need to be
  // selectable
  if ((!props.selectable || !props.uiTextView) && !isAncestor) {
    return /*#__PURE__*/_jsx(RNText, {
      ...props
    });
  }
  return /*#__PURE__*/_jsx(UITextViewChild, {
    ...props
  });
}
export function UITextView(props) {
  if (Platform.OS !== 'ios') {
    return /*#__PURE__*/_jsx(RNText, {
      ...props
    });
  }
  return /*#__PURE__*/_jsx(UITextViewInner, {
    ...props
  });
}
//# sourceMappingURL=Text.js.map