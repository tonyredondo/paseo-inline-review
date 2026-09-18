"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.UITextView = UITextView;
var _react = _interopRequireDefault(require("react"));
var _reactNative = require("react-native");
var _RNUITextViewChildNativeComponent = _interopRequireDefault(require("./RNUITextViewChildNativeComponent"));
var _RNUITextViewNativeComponent = _interopRequireDefault(require("./RNUITextViewNativeComponent"));
var _press = require("./press.js");
var _util = require("./util.js");
var _jsxRuntime = require("react/jsx-runtime");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const TextAncestorContext = /*#__PURE__*/_react.default.createContext({
  isAncestor: false,
  rootStyle: _reactNative.StyleSheet.create({})
});
const textDefaults = {
  allowFontScaling: true,
  selectable: true
};
const useTextAncestorContext = () => _react.default.useContext(TextAncestorContext);

/**
 * Event fired by `onSelectionChange`. `start`/`end` are 0-based UTF-16 indices
 * into the rendered string. `start === end` means the selection was cleared.
 */

function UITextViewChild({
  style,
  children,
  ...rest
}) {
  const {
    isAncestor,
    rootStyle,
    highlightGroup: ancestorHighlightGroup,
    suppressHighlighting: ancestorSuppressHighlighting,
    pressRetentionOffset: ancestorPressRetentionOffset,
    onPress: ancestorOnPress,
    onLongPress: ancestorOnLongPress
  } = useTextAncestorContext();
  const ownHighlightGroup = _react.default.useId();
  const {
    highlightGroup,
    suppressHighlighting,
    pressRetentionOffset,
    onPress,
    onLongPress
  } = (0, _press.resolvePressContext)(ownHighlightGroup, rest, {
    highlightGroup: ancestorHighlightGroup,
    suppressHighlighting: ancestorSuppressHighlighting,
    pressRetentionOffset: ancestorPressRetentionOffset,
    onPress: ancestorOnPress,
    onLongPress: ancestorOnLongPress
  });
  // The native event currently contains only `target`, while TextProps types
  // these callbacks as full gesture events. Preserve the existing public type
  // and adapt it only at the private Codegen boundary.
  const nativeOnPress = onPress;
  const nativeOnLongPress = onLongPress;

  // Flatten the styles, and apply the root styles when needed
  const flattenedStyle = _react.default.useMemo(() => (0, _util.flattenStyles)(rootStyle, style), [rootStyle, style]);
  if (!isAncestor) {
    return /*#__PURE__*/(0, _jsxRuntime.jsx)(TextAncestorContext.Provider, {
      value: {
        isAncestor: true,
        rootStyle: flattenedStyle,
        highlightGroup,
        suppressHighlighting,
        pressRetentionOffset,
        onPress,
        onLongPress
      },
      children: /*#__PURE__*/(0, _jsxRuntime.jsx)(_RNUITextViewNativeComponent.default, {
        ...textDefaults,
        ...rest,
        // ellipsizeMode={rest.ellipsizeMode ?? rest.lineBreakMode ?? 'tail'}
        style: [flattenedStyle]
        // @ts-expect-error Weirdness
        ,
        onPress: undefined,
        onLongPress: undefined,
        children: _react.default.Children.toArray(children).map((c, index) => {
          if (/*#__PURE__*/_react.default.isValidElement(c)) {
            return c;
          } else if (typeof c === 'string' || typeof c === 'number') {
            return /*#__PURE__*/(0, _jsxRuntime.jsx)(_RNUITextViewChildNativeComponent.default, {
              style: flattenedStyle,
              text: c.toString(),
              ...rest,
              highlightGroup: highlightGroup,
              suppressHighlighting: suppressHighlighting,
              pressRetentionOffsetTop: pressRetentionOffset?.top,
              pressRetentionOffsetRight: pressRetentionOffset?.right,
              pressRetentionOffsetBottom: pressRetentionOffset?.bottom,
              pressRetentionOffsetLeft: pressRetentionOffset?.left,
              onPress: nativeOnPress,
              onLongPress: nativeOnLongPress
            }, index);
          }
          return null;
        })
      })
    });
  } else {
    return /*#__PURE__*/(0, _jsxRuntime.jsx)(TextAncestorContext.Provider, {
      value: {
        isAncestor: true,
        rootStyle: flattenedStyle,
        highlightGroup,
        suppressHighlighting,
        pressRetentionOffset,
        onPress,
        onLongPress
      },
      children: _react.default.Children.toArray(children).map((c, index) => {
        if (/*#__PURE__*/_react.default.isValidElement(c)) {
          return c;
        } else if (typeof c === 'string' || typeof c === 'number') {
          return /*#__PURE__*/(0, _jsxRuntime.jsx)(_RNUITextViewChildNativeComponent.default, {
            style: flattenedStyle,
            text: c.toString(),
            ...rest,
            highlightGroup: highlightGroup,
            suppressHighlighting: suppressHighlighting,
            pressRetentionOffsetTop: pressRetentionOffset?.top,
            pressRetentionOffsetRight: pressRetentionOffset?.right,
            pressRetentionOffsetBottom: pressRetentionOffset?.bottom,
            pressRetentionOffsetLeft: pressRetentionOffset?.left,
            onPress: nativeOnPress,
            onLongPress: nativeOnLongPress
          }, index);
        }
        return null;
      })
    });
  }
}
function UITextViewInner(props) {
  const {
    isAncestor
  } = useTextAncestorContext();

  // Even if the uiTextView prop is set, we can still default to using
  // normal selection (i.e. base RN text) if the text doesn't need to be
  // selectable
  if ((!props.selectable || !props.uiTextView) && !isAncestor) {
    return /*#__PURE__*/(0, _jsxRuntime.jsx)(_reactNative.Text, {
      ...props
    });
  }
  return /*#__PURE__*/(0, _jsxRuntime.jsx)(UITextViewChild, {
    ...props
  });
}
function UITextView(props) {
  if (_reactNative.Platform.OS !== 'ios') {
    return /*#__PURE__*/(0, _jsxRuntime.jsx)(_reactNative.Text, {
      ...props
    });
  }
  return /*#__PURE__*/(0, _jsxRuntime.jsx)(UITextViewInner, {
    ...props
  });
}
//# sourceMappingURL=Text.js.map