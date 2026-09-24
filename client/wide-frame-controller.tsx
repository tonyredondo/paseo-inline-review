import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** Elects one visible timeline row to own the global DOM/settings feature. */
export function useWideFrameControllerOwner(anchorRef: WideFrameAnchorRef): boolean {
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    const root = timelineRootFor(anchorRef.current);
    const registration = registerWideFrameOwner(root, setActive);
    return () => {
      registration.release();
    };
  }, [anchorRef]);
  return active;
}

/** Single settings subscription and wide-frame effect for one plugin instance. */
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
  const retried = useRef(false);
  const enabled = settings.status === "ready" ? settings.values.wideFrame : null;

  useEffect(() => {
    if (settings.status !== "ready" && settings.status !== "loading" && !retried.current) {
      retried.current = true;
      void settings.reload();
    }
  }, [settings]);

  useLayoutEffect(() => {
    // The controller is elected from virtualized timeline rows. The setting is
    // host-scoped, while the DOM policy follows the elected timeline anchor.
    // Row unmounts and transient settings states must not tear it down; an
    // explicit disabled value or plugin cleanup owns that.
    // A layout effect applies the current DOM policy before the browser paints.
    if (layout.platform !== "web" || enabled === null) return;
    configureWideFrameLease(
      wideFrameLease,
      host.id,
      enabled,
      {
        accent: theme.colors.accent ?? theme.colors.foreground,
        raised: theme.colors.surface2,
        border: theme.colors.border,
      },
      anchorRef,
    );
  }, [
    enabled,
    host.id,
    layout.platform,
    theme.colors.accent,
    theme.colors.foreground,
    theme.colors.surface2,
    theme.colors.border,
    wideFrameLease,
    anchorRef,
  ]);

  return null;
}
