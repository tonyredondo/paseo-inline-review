import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { Switch, Text, View } from "react-native";
import {
  configureWideFrameLease,
  wideFrameSettings,
  type WideFrameLease,
} from "./wide-frame";

/** Settings screen: enables/disables the wide reading-frame experiment. */
export function WideFrameSettingsScreen({
  theme,
  layout,
  host,
  wideFrameLease,
}: PluginSurfaceProps & { wideFrameLease: WideFrameLease }) {
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

  async function toggle(): Promise<void> {
    if (settings.status !== "ready") return;
    const nextEnabled = !enabled;
    const saved = await settings.save(
      { ...settings.values, wideFrame: nextEnabled },
      settings.revision,
    );
    if (!saved || layout.platform !== "web") return;
    configureWideFrameLease(
      wideFrameLease,
      host.id,
      nextEnabled,
      {
        accent: theme.colors.accent ?? theme.colors.foreground,
        raised: theme.colors.surface2,
        border: theme.colors.border,
      },
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Feature flags</Text>
      <Text style={styles.muted}>
        {`Experimental plugin features. Each flag is independent; some need an app restart to take effect.`}
      </Text>
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>
      ) : null}
      <View style={styles.row}>
        <Text style={styles.label}>Widen the timeline</Text>
        <Switch value={enabled} onValueChange={() => void toggle()} />
      </View>
      {values ? (
        <Text style={styles.state}>{enabled ? "Widening enabled" : "Widening disabled"}</Text>
      ) : (
        <Text style={styles.muted}>{settings.status === "loading" ? "Loading…" : "Settings unavailable."}</Text>
      )}
      <Text style={styles.muted}>
        {`User messages render as review-style cards on desktop, iPhone and iPad. Web keeps Paseo's native image and action controls; native rows with host-owned attachments remain untouched.`}
      </Text>
    </View>
  );
}
