import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, Platform, Pressable, Text, View, type GestureResponderEvent, type ViewStyle } from "react-native";

type Position = { scale: number; x: number; y: number };
type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Gesture = { position: Position; point: Point; distance: number; touches: number; pinched: boolean };
const FIT: Position = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 5;
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

function contact(event: GestureResponderEvent): { point: Point; distance: number; touches: number } {
  const touches = event.nativeEvent.touches;
  const first = touches[0] ?? event.nativeEvent;
  const second = touches[1];
  return {
    touches: touches.length,
    point: second ? { x: (first.locationX + second.locationX) / 2, y: (first.locationY + second.locationY) / 2 } : { x: first.locationX, y: first.locationY },
    distance: second ? Math.hypot(second.locationX - first.locationX, second.locationY - first.locationY) : 0,
  };
}

/** One loaded image owns its zoom. Navigation/remount resets it to fit. */
export function ZoomableImage({ uri, label, theme, onError, onNavigate }: {
  uri: string;
  label: string;
  theme: PluginTheme;
  onError(): void;
  onNavigate(direction: -1 | 1): void;
}) {
  const [frame, setFrame] = useState<Size>({ width: 0, height: 0 });
  const [source, setSource] = useState<Size | null>(null);
  const [position, setPosition] = useState(FIT);
  const current = useRef(FIT);
  const gesture = useRef<Gesture | null>(null);
  useEffect(() => {
    let active = true;
    // Image.getSize works on native and web; web's onLoad has no source dimensions.
    Image.getSize(uri, (width, height) => {
      if (active && width > 0 && height > 0) setSource({ width, height });
    }, () => { if (active) onError(); });
    return () => { active = false; };
  }, [uri, onError]);
  const ratio = source ? Math.min(frame.width / source.width, frame.height / source.height) : 1;
  const fitted = source ? { width: source.width * ratio, height: source.height * ratio } : frame;
  const update = (next: Position): void => {
    const scale = Math.max(1, Math.min(MAX_ZOOM, next.scale));
    const value = {
      scale,
      x: clamp(next.x, Math.max(0, (fitted.width * scale - frame.width) / 2)),
      y: clamp(next.y, Math.max(0, (fitted.height * scale - frame.height) / 2)),
    };
    current.current = value;
    setPosition(value);
  };
  const rebase = (event: GestureResponderEvent): void => {
    const next = contact(event);
    if (next.touches > 0) gesture.current = { ...next, position: current.current, pinched: Boolean(gesture.current?.pinched) || next.touches > 1 };
  };
  const responder = useMemo(() => PanResponder.create({
    // This fullscreen frame owns the first contact even at fit scale. If an
    // ancestor claims it, later fingers cannot negotiate with this child again.
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_event, state) => state.numberActiveTouches === 2 || current.current.scale > 1 || (state.numberActiveTouches === 1 && Math.abs(state.dx) > 12 && Math.abs(state.dx) > Math.abs(state.dy) * 1.5),
    onPanResponderGrant: (event) => {
      const next = contact(event);
      gesture.current = { ...next, position: current.current, pinched: next.touches > 1 };
    },
    // Rebase when fingers join/leave, before their first movement is delivered.
    onPanResponderStart: rebase,
    onPanResponderEnd: rebase,
    onPanResponderMove: (event) => {
      const next = contact(event);
      const start = gesture.current;
      if (!start || next.touches < 1) return;
      if (next.touches !== start.touches) {
        gesture.current = { ...next, position: current.current, pinched: start.pinched || next.touches > 1 };
        return;
      }
      if (next.touches === 2 && start.distance > 0) {
        const requestedScale = start.position.scale * next.distance / start.distance;
        const scale = Math.max(1, Math.min(MAX_ZOOM, requestedScale));
        // Keep the point under the pinch midpoint stationary, then bound the pan.
        const factor = scale / start.position.scale;
        update({
          scale,
          x: next.point.x - frame.width / 2 - (start.point.x - frame.width / 2 - start.position.x) * factor,
          y: next.point.y - frame.height / 2 - (start.point.y - frame.height / 2 - start.position.y) * factor,
        });
        // Discard overshoot at either limit so reversing the pinch responds
        // immediately, even when the fingers remain on the screen at 100%.
        if (requestedScale < 1 || requestedScale > MAX_ZOOM) rebase(event);
      } else if (next.touches === 1 && start.position.scale > 1) {
        update({ scale: start.position.scale, x: start.position.x + next.point.x - start.point.x, y: start.position.y + next.point.y - start.point.y });
      }
    },
    onPanResponderRelease: (_event, state) => {
      const start = gesture.current;
      gesture.current = null;
      if (start && !start.pinched && current.current.scale === 1 && Math.abs(state.dx) >= 40 && Math.abs(state.dx) > Math.abs(state.dy) * 1.5) onNavigate(state.dx < 0 ? 1 : -1);
    },
    onPanResponderTerminate: () => { gesture.current = null; },
    onPanResponderTerminationRequest: () => false,
  }), [frame.width, frame.height, fitted.width, fitted.height, onNavigate]);
  const buttonStyle = { width: 44, height: 44, borderRadius: 8, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: theme.colors.surface2 };
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        {...responder.panHandlers}
        accessibilityLabel="Zoomable image"
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setFrame({ width, height });
          current.current = FIT;
          setPosition(FIT);
          gesture.current = null;
        }}
        style={[{ flex: 1, overflow: "hidden" }, Platform.OS === "web" ? { touchAction: "none" } as ViewStyle : null]}
      >
        <View style={{ pointerEvents: "none", position: "absolute", left: (frame.width - fitted.width) / 2, top: (frame.height - fitted.height) / 2, width: fitted.width, height: fitted.height, transform: [{ translateX: position.x }, { translateY: position.y }, { scale: position.scale }] }}>
          <Image source={{ uri }} accessibilityLabel={label} resizeMode="contain" style={{ width: "100%", height: "100%" }} onError={onError} />
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Zoom out" accessibilityState={{ disabled: position.scale === 1 }} disabled={position.scale === 1} onPress={() => update({ ...current.current, scale: current.current.scale - 1 })} style={[buttonStyle, { opacity: position.scale === 1 ? 0.3 : 1 }]}><Icon name="ZoomOut" size={20} color={theme.colors.foreground} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Reset zoom" onPress={() => update(FIT)} style={[buttonStyle, { width: 70 }]}><Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{`${Math.round(position.scale * 100)}%`}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Zoom in" accessibilityState={{ disabled: position.scale === MAX_ZOOM }} disabled={position.scale === MAX_ZOOM} onPress={() => update({ ...current.current, scale: current.current.scale + 1 })} style={[buttonStyle, { opacity: position.scale === MAX_ZOOM ? 0.3 : 1 }]}><Icon name="ZoomIn" size={20} color={theme.colors.foreground} /></Pressable>
      </View>
    </View>
  );
}
