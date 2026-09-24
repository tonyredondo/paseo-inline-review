import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  configureWideFrameLease,
  type WideFrameAnchorRef,
  type WideFrameLease,
} from "./wide-frame";
import { wideFrameSettings } from "../shared/wide-frame-settings";

type Owner = { id: number; setActive(active: boolean): void };

const owners: Owner[] = [];
let nextOwnerId = 1;
let activeOwnerId: number | null = null;

/** Elects one mounted timeline row to own the global DOM/settings feature. */
export function useWideFrameControllerOwner(): boolean {
  const idRef = useRef<number | null>(null);
  if (idRef.current === null) idRef.current = nextOwnerId++;
  const id = idRef.current;
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    const owner: Owner = { id, setActive };
    owners.push(owner);
    if (activeOwnerId === null) {
      activeOwnerId = id;
      setActive(true);
    }
    return () => {
      const index = owners.findIndex((candidate) => candidate.id === id);
      if (index >= 0) owners.splice(index, 1);
      if (activeOwnerId === id) {
        activeOwnerId = owners[0]?.id ?? null;
        owners[0]?.setActive(true);
      }
    };
  }, [id]);
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
