import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ensureWideFrame, undoWideFrame } from "./wide-frame";
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

/** Single settings subscription and wide-frame effect for the whole client. */
export function WideFrameController({ theme, layout }: Pick<PluginHostProps, "theme" | "layout">) {
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
    // The controller is elected from virtualized timeline rows, but the DOM
    // policy is host-wide. Row unmounts and transient settings states must not
    // tear it down; an explicit disabled value or plugin cleanup owns that.
    // A layout effect applies the current DOM policy before the browser paints.
    if (layout.platform !== "web" || enabled === null) return;
    if (enabled) {
      ensureWideFrame({
        accent: theme.colors.accent ?? theme.colors.foreground,
        raised: theme.colors.surface2,
        border: theme.colors.border,
      });
    } else {
      undoWideFrame();
    }
  }, [enabled, layout.platform, theme]);

  return null;
}
