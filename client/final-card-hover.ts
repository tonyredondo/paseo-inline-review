type TimerHandle = unknown;
type Schedule = (callback: () => void, delayMs: number) => TimerHandle;
type Cancel = (timer: TimerHandle) => void;

type HoverEntry = {
  hovered: boolean;
  hideTimer: TimerHandle | null;
  listeners: Set<() => void>;
};

const HIDE_DELAY_MS = 48;

/** Shares hover across the separate host rows that visually form one card. */
export function createFinalCardHoverStore(
  schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: Cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
) {
  const entries = new Map<string, HoverEntry>();

  function entryFor(key: string): HoverEntry {
    const current = entries.get(key);
    if (current) return current;
    const created: HoverEntry = { hovered: false, hideTimer: null, listeners: new Set() };
    entries.set(key, created);
    return created;
  }

  function notify(entry: HoverEntry): void {
    for (const listener of entry.listeners) listener();
  }

  return {
    subscribe(key: string, listener: () => void): () => void {
      const entry = entryFor(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size !== 0) return;
        if (entry.hideTimer !== null) cancel(entry.hideTimer);
        entries.delete(key);
      };
    },

    isHovered(key: string): boolean {
      return entries.get(key)?.hovered ?? false;
    },

    show(key: string): void {
      const entry = entryFor(key);
      if (entry.hideTimer !== null) {
        cancel(entry.hideTimer);
        entry.hideTimer = null;
      }
      if (entry.hovered) return;
      entry.hovered = true;
      notify(entry);
    },

    hide(key: string): void {
      const entry = entries.get(key);
      if (!entry || !entry.hovered || entry.hideTimer !== null) return;
      let timer: TimerHandle | null = null;
      timer = schedule(() => {
        if (entry.hideTimer !== timer) return;
        entry.hideTimer = null;
        if (!entry.hovered) return;
        entry.hovered = false;
        notify(entry);
        if (entry.listeners.size === 0) entries.delete(key);
      }, HIDE_DELAY_MS);
      entry.hideTimer = timer;
    },
  };
}

export const finalCardHoverStore = createFinalCardHoverStore();
