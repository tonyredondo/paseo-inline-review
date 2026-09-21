import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { Pressable, Switch, Text, View } from "react-native";
import { wideFrameSettings } from "./wide-frame";

/** Settings screen: enables/disables the wide reading-frame experiment. */
export function WideFrameSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(wideFrameSettings);
  const values = settings.status === "ready" ? settings.values : null;
  const enabled = values?.wideFrame ?? false;
  // A read that raced a plugin reload caches an error state; retry once.
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    if (settings.status !== "ready" && !retried) {
      setRetried(true);
      void settings.reload();
    }
  }, [settings.status, retried, settings]);

  const styles = {
    root: { flex: 1, padding: 24, gap: 16, backgroundColor: theme.colors.surface0 } as const,
    title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "600" } as const,
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 } as const,
    label: { color: theme.colors.foreground, fontSize: 15 } as const,
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 } as const,
    state: { color: theme.colors.accent, fontSize: 13 } as const,
  };

  function toggle(): void {
    if (settings.status !== "ready") return;
    void settings.save({ wideFrame: !enabled }, settings.revision);
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Wide reading frame</Text>
      <Text style={styles.muted}>
        {`Widen the timeline past the host's fixed 820px column so messages, tool calls and user messages use the available window width, and style user messages like the plugin's review cards (left accent border, card surface). Desktop only.`}
      </Text>
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>
      ) : null}
      <View style={styles.row}>
        <Text style={styles.label}>Widen the timeline</Text>
        <Switch value={enabled} onValueChange={toggle} />
      </View>
      {values ? (
        <Text style={styles.state}>{enabled ? "Enabled — restart the app window if items look unchanged." : "Disabled"}</Text>
      ) : (
        <Text style={styles.muted}>{settings.status === "loading" ? "Loading…" : "Settings unavailable."}</Text>
      )}
      <Pressable onPress={toggle} hitSlop={6}>
        <Text style={styles.state}>{enabled ? "Tap the switch to disable" : "Tap the switch to enable"}</Text>
      </Pressable>
    </View>
  );
}
