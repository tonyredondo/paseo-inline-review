import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Modal, PanResponder, Platform, Pressable, SafeAreaView, Text, View,
  type FlatList as NativeFlatList, type ImageStyle, type StyleProp,
} from "react-native";
import type { InlineToken, LocalFileTarget } from "../shared/markdown-parse";
import { COMPACT_IMAGE_VIEWER_MAX_BYTES, FILE_TRANSFER_CHUNK_BYTES, localImagePreviewRpc, openLocalFileRpc } from "../shared/review";
import { retainImagePreview, retryImagePreview, type ThumbnailState } from "./image-preview-store";
import { listenImageViewerKeys } from "./web";
import { ZoomableImage } from "./image-zoom";

export type GalleryImage = Extract<InlineToken, { type: "image" }>;
const THUMBNAIL_STRIDE = 84;
const GENERATED_IMAGE_NAME = /^(?:[a-f0-9]{24,}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?:\.[a-z0-9]+)?$/i;

function imageLabel(image: GalleryImage): string {
  const alt = image.alt.trim();
  const name = image.url.split(/[?#]/)[0].split(/[\\/]/).pop() || "Image";
  const label = alt && !/^image$/i.test(alt) ? alt : name;
  return GENERATED_IMAGE_NAME.test(label) ? "Image" : label;
}

function ImageCaption({ image, theme, fontSize = 12 }: {
  image: GalleryImage;
  theme: PluginTheme;
  fontSize?: number;
}) {
  const label = imageLabel(image);
  const extension = /\.[a-z0-9]{1,10}$/i.exec(label)?.[0] ?? "";
  const name = extension ? label.slice(0, -extension.length) : label;
  const textStyle = { color: theme.colors.foreground, fontSize, fontWeight: "500" as const };
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
      <Text numberOfLines={1} accessibilityLabel={label} style={[textStyle, { flexShrink: 1, minWidth: 0 }]}>{name}</Text>
      {extension ? <Text aria-hidden importantForAccessibility="no" style={[textStyle, { flexShrink: 0 }]}>{extension}</Text> : null}
    </View>
  );
}

function ImagePreview({ image, target, theme, compact, enabled, thumbnail, onLoad, onOpen }: {
  image: GalleryImage;
  target: LocalFileTarget | null;
  theme: PluginTheme;
  compact: boolean;
  enabled: boolean;
  thumbnail?: boolean;
  onLoad(): void;
  onOpen(): void;
}) {
  const loadThumbnail = useRpc(localImagePreviewRpc);
  const [state, setState] = useState<ThumbnailState>({ status: "idle" });
  const [remoteError, setRemoteError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const maxEdge = compact ? 320 : 640;
  const quality = compact ? 65 : 78;
  useEffect(() => {
    if (!target) return;
    return retainImagePreview(target.path, loadThumbnail, setState, {
      autoLoad: enabled, maxEdge, quality,
    });
  }, [enabled, loadThumbnail, maxEdge, quality, target?.path]);

  const label = imageLabel(image);
  const uri = remoteError ? null : target
    ? (state.status === "ready" ? state.dataUri : null)
    : (enabled ? image.url : null);
  const error = remoteError || (target && state.status === "error");
  const loading = target && state.status === "loading";
  const imageStyle: StyleProp<ImageStyle> = { width: "100%", height: "100%" };
  if (uri) {
    const preview = <Image key={attempt} source={{ uri }} style={imageStyle} resizeMode="contain" accessibilityLabel={label} onError={() => setRemoteError(true)} />;
    return thumbnail ? preview : (
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Enlarge image ${label}`} onPress={onOpen} style={{ flex: 1, width: "100%" }}>
        {preview}
      </Pressable>
    );
  }
  if (thumbnail) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Icon name={error ? "ImageOff" : "Image"} size={18} color={theme.colors.foregroundMuted} /></View>;
  }
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 16 }}>
      {loading ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : <Icon name={error ? "ImageOff" : "Image"} size={28} color={theme.colors.foregroundMuted} />}
      <Text style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>
        {error ? "Could not load the image preview." : loading ? "Loading preview…" : "Load image previews"}
      </Text>
      {!loading ? (
        <Pressable accessibilityRole="button" accessibilityLabel={error ? "Retry image preview" : "Load image previews"} onPress={() => {
          onLoad();
          setRemoteError(false);
          setAttempt((value) => value + 1);
          if (target) retryImagePreview(target.path, { maxEdge, quality });
        }} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{error ? "Retry" : "Load previews"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function FullImage({ image, target, theme, compact, onOpenFile, onNavigate }: {
  image: GalleryImage;
  target: LocalFileTarget | null;
  theme: PluginTheme;
  compact: boolean;
  onOpenFile?: () => void;
  onNavigate(direction: -1 | 1): void;
}) {
  const openFile = useRpc(openLocalFileRpc);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ uri?: string; error?: string }>({});
  const imageMaxBytes = compact || Platform.OS === "ios" || Platform.OS === "android" ? COMPACT_IMAGE_VIEWER_MAX_BYTES : FILE_TRANSFER_CHUNK_BYTES;
  useEffect(() => {
    let active = true;
    setState({});
    if (!target) {
      setState({ uri: image.url });
    } else {
      // Only the open lightbox mounts this component. Keep one full image in
      // memory and reject replies after navigation, dismissal or unmount.
      void openFile({ path: target.path, mode: "image", optimizeImage: true, imageMaxBytes }).then((result) => {
        if (!active) return;
        if (result.ok && result.base64 && result.mimeType?.startsWith("image/")) {
          setState({ uri: `data:${result.mimeType};base64,${result.base64}` });
        } else {
          setState({ error: result.error ?? "The full image is unavailable." });
        }
      }).catch(() => {
        if (active) setState({ error: "Could not load the full image." });
      });
    }
    return () => { active = false; };
  }, [attempt, image.url, imageMaxBytes, openFile, target?.path]);
  if (state.uri) {
    return <ZoomableImage key={attempt} uri={state.uri} label={imageLabel(image)} theme={theme} onNavigate={onNavigate} onError={() => setState({ error: "Could not display the full image." })} />;
  }
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 20 }}>
      {state.error ? <Icon name="ImageOff" size={32} color={theme.colors.foregroundMuted} /> : <ActivityIndicator color={theme.colors.foregroundMuted} />}
      <Text style={{ color: state.error ? theme.colors.statusDanger : theme.colors.foregroundMuted, textAlign: "center" }}>{state.error ?? "Loading image…"}</Text>
      {state.error ? <Pressable accessibilityRole="button" accessibilityLabel="Retry full image" onPress={() => setAttempt((value) => value + 1)}><Text style={{ color: theme.colors.accent }}>Retry</Text></Pressable> : null}
      {state.error && onOpenFile ? <Pressable accessibilityRole="button" accessibilityLabel="Open image in file preview" onPress={onOpenFile}><Text style={{ color: theme.colors.accent }}>Open in file preview</Text></Pressable> : null}
    </View>
  );
}

/** A consecutive image run, with bounded previews and an explicit full viewer. */
export function ImageGallery({ images, theme, compact, resolveFile, onLocalFilePress, onLinkPress }: {
  images: GalleryImage[];
  theme: PluginTheme;
  compact: boolean;
  resolveFile?: (href: string) => LocalFileTarget | null;
  onLocalFilePress?: (target: LocalFileTarget) => void;
  onLinkPress?: (href: string) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(!compact);
  const index = Math.max(0, Math.min(selected, images.length - 1));
  const image = images[index];
  const target = image ? resolveFile?.(image.url) ?? null : null;
  const closeRef = useRef<View>(null);
  const thumbnails = useRef<NativeFlatList<GalleryImage>>(null);
  const select = (next: number): void => { setSelected(Math.max(0, Math.min(next, images.length - 1))); };
  useEffect(() => {
    if (selected !== index) setSelected(index);
    if (images.length === 0) setExpanded(false);
    if (images.length > 1) thumbnails.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
  }, [index, images.length, selected, expanded]);
  useEffect(() => {
    if (!expanded || images.length === 0) return;
    return listenImageViewerKeys((key) => {
      if (key === "Escape") setExpanded(false);
      else select(index + (key === "ArrowRight" ? 1 : -1));
    });
  }, [expanded, index, images.length]);
  const swipe = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.numberActiveTouches === 1 && Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
    onPanResponderRelease: (_event, gesture) => {
      if (Math.abs(gesture.dx) >= 40 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5) select(index + (gesture.dx < 0 ? 1 : -1));
    },
    onPanResponderTerminationRequest: () => true,
  }), [index, images.length]);
  if (!image) return null;
  const open = (): void => { setEnabled(true); setExpanded(true); };
  const controlSize = compact ? 44 : 36;
  const arrow = (direction: -1 | 1) => {
    const disabled = direction < 0 ? index === 0 : index === images.length - 1;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={direction < 0 ? "Previous image" : "Next image"}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => select(index + direction)}
        style={{ width: controlSize, height: controlSize, borderRadius: 8, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.3 : 1, backgroundColor: theme.colors.surface2 }}
      >
        <Icon name={direction < 0 ? "ChevronLeft" : "ChevronRight"} size={18} color={theme.colors.foreground} />
      </Pressable>
    );
  };
  const strip = images.length > 1 ? (
    <FlatList
      ref={thumbnails}
      horizontal
      data={images}
      showsHorizontalScrollIndicator={false}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={3}
      style={{ flexGrow: 0, height: 60 }}
      contentContainerStyle={{ paddingHorizontal: 12 }}
      keyExtractor={(item, itemIndex) => `${itemIndex}:${item.url}`}
      getItemLayout={(_data, itemIndex) => ({ length: THUMBNAIL_STRIDE, offset: THUMBNAIL_STRIDE * itemIndex, index: itemIndex })}
      renderItem={({ item, index: itemIndex }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show image ${itemIndex + 1} of ${images.length}: ${imageLabel(item)}`}
          accessibilityState={{ selected: itemIndex === index }}
          onPress={() => { select(itemIndex); setEnabled(true); }}
          style={{ width: 76, height: 58, marginRight: 8, padding: 3, borderRadius: 8, borderWidth: 2, borderColor: itemIndex === index ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface0, overflow: "hidden" }}
        >
          <ImagePreview image={item} target={resolveFile?.(item.url) ?? null} theme={theme} compact={compact} enabled={enabled} thumbnail onLoad={() => setEnabled(true)} onOpen={open} />
        </Pressable>
      )}
    />
  ) : null;
  const controls = images.length > 1 ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {arrow(-1)}
      <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, fontSize: 12, minWidth: 38, textAlign: "center" }}>{`${index + 1} / ${images.length}`}</Text>
      {arrow(1)}
    </View>
  ) : null;
  return (
    <View accessibilityLabel="Image gallery" style={{ alignSelf: "center", width: "100%", maxWidth: compact ? 380 : 560, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
      <View {...swipe.panHandlers} style={{ height: compact ? 210 : 300, padding: 8, backgroundColor: theme.colors.surface0 }}>
        <ImagePreview key={`${index}:${target?.path ?? image.url}`} image={image} target={target} theme={theme} compact={compact} enabled={enabled} onLoad={() => setEnabled(true)} onOpen={open} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 12 }}>
        <ImageCaption image={image} theme={theme} />
        {controls}
        <Pressable accessibilityRole="button" accessibilityLabel="Enlarge image" onPress={open} style={{ width: controlSize, height: controlSize, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}><Icon name="Maximize2" size={17} color={theme.colors.foreground} /></Pressable>
      </View>
      {image.linkUrl && onLinkPress ? <Pressable accessibilityRole="link" accessibilityLabel="Open image link" onPress={() => onLinkPress(image.linkUrl!)} style={{ paddingHorizontal: 12, paddingBottom: 10 }}><Text style={{ color: theme.colors.accent, fontSize: 12 }}>Open link</Text></Pressable> : null}
      {!expanded && strip ? <View style={{ paddingBottom: 12 }}>{strip}</View> : null}
      {expanded ? (
        <Modal
          visible
          transparent
          accessibilityLabel="Image viewer"
          animationType="none"
          presentationStyle="overFullScreen"
          supportedOrientations={["portrait", "landscape"]}
          onRequestClose={() => setExpanded(false)}
          onShow={() => closeRef.current?.focus()}
        >
          <SafeAreaView accessibilityLabel="Image viewer content" style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: compact ? 12 : 20 }}>
              <ImageCaption image={image} theme={theme} fontSize={14} />
              {controls}
              <Pressable ref={closeRef} accessibilityRole="button" accessibilityLabel="Close image viewer" onPress={() => setExpanded(false)} style={{ width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}><Icon name="X" size={20} color={theme.colors.foreground} /></Pressable>
            </View>
            <View style={{ flex: 1, minHeight: 0, paddingHorizontal: compact ? 8 : 24, paddingBottom: 16 }}>
              <FullImage key={`${index}:${target?.path ?? image.url}`} image={image} target={target} theme={theme} compact={compact} onNavigate={(direction) => select(index + direction)} onOpenFile={target && onLocalFilePress ? () => { setExpanded(false); onLocalFilePress(target); } : undefined} />
            </View>
            {strip ? <View style={{ paddingBottom: 12 }}>{strip}</View> : null}
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}
