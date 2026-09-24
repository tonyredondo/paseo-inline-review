import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  configureWideFrameLease,
  type WideFrameAnchorRef,
  type WideFrameLease,
} from "./wide-frame";
import {
  registerWideFrameOwner,
  type WideFrameOwnerCandidate,
} from "./wide-frame-owner";
import { wideFrameSettings } from "../shared/wide-frame-settings";

type TimelineRoot = (NonNullable<WideFrameOwnerCandidate["root"]> & {
  parentElement?: TimelineRoot;
  matches?(selector: string): boolean;
}) | null;

function timelineRootFor(anchor: unknown): TimelineRoot {
  if (!anchor || typeof anchor !== "object") return null;
  let current: TimelineRoot = anchor as NonNullable<TimelineRoot>;
  while (current) {
    if (current.matches?.('[data-testid="agent-chat-scroll"]')) return current;
    current = current.parentElement ?? null;
  }
  return null;
}

/** Registers one row as a candidate; the global registry applies only its elected owner. */
export function WideFrameController({
  theme,
  layout,
  host,
  wideFrameLease,
  anchorRef,
}: Pick<PluginHostProps, "theme" | "layout" | "host"> & {
  wideFrameLease: WideFrameLease;
  anchorRef?: WideFrameAnchorRef;
}) {
  const settings = useSettings(wideFrameSettings);
  const enabled = settings.status === "ready" ? settings.values.wideFrame : null;
  const retried = useRef(false);
  const registration = useRef<ReturnType<typeof registerWideFrameOwner> | null>(null);
  const current = useRef({ settings, theme, layout, host });
  current.current = { settings, theme, layout, host };

  useEffect(() => {
    if (settings.status !== "ready" && settings.status !== "loading" && !retried.current) {
      retried.current = true;
      void settings.reload();
    }
  }, [settings]);

  useLayoutEffect(() => {
    const root = timelineRootFor(anchorRef?.current);
    const owner = registerWideFrameOwner(root, (active) => {
      if (!active) return;
      const value = current.current;
      if (value.layout.platform !== "web" || value.settings.status !== "ready") return;
      configureWideFrameLease(
        wideFrameLease,
        value.host.id,
        value.settings.values.wideFrame,
        {
          accent: value.theme.colors.accent ?? value.theme.colors.foreground,
          raised: value.theme.colors.surface2,
          border: value.theme.colors.border,
        },
        anchorRef,
      );
    });
    registration.current = owner;
    return () => {
      if (registration.current === owner) registration.current = null;
      owner.release();
    };
  }, [anchorRef, wideFrameLease]);

  // Settings and theme updates do not change the registered candidate. Ask
  // the registry to reapply the elected owner's latest snapshot instead.
  useLayoutEffect(() => {
    registration.current?.reconcile();
  }, [
    settings.status,
    enabled,
    host.id,
    layout.platform,
    theme.colors.accent,
    theme.colors.foreground,
    theme.colors.surface2,
    theme.colors.border,
  ]);

  return null;
}
