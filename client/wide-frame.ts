/**
 * EXPERIMENT-turned-feature: widen the host reading frame so the timeline
 * uses the available window width (tool calls, user messages, plugin items)
 * with breathing room, instead of the fixed 820px column.
 *
 * Desktop (web) only: re-caps every host element with max-width 820px
 * inline to the pane width; a MutationObserver keeps freshly mounted
 * elements covered in the same frame. Native platforms (iPad) keep the
 * host's 820px column — the DOM pass is unreachable there.
 * The user flag lives in plugin settings (host scope) as wideFrame.
 */
import { Platform } from "react-native";
import { wideFrameSettings } from "../shared/wide-frame-settings";

export { wideFrameSettings };

type WNode = {
  clientWidth: number;
  parentElement: WNode | null;
  style: { maxWidth: string };
  dataset: Record<string, string>;
};
type WDoc = { querySelectorAll(selector: string): ArrayLike<WNode>; body?: WNode | null };
type WWin = {
  getComputedStyle(el: WNode): { maxWidth: string };
  innerWidth?: number;
  requestAnimationFrame(cb: () => void): number;
  MutationObserver?: new (cb: () => void) => {
    observe(target: WNode, options: { childList: boolean; subtree: boolean }): void;
    disconnect(): void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

const HIDE = 860;
const BREATHING = 112; // 56px of air per side

let undo: (() => void) | null = null;

/** Installs the web widening pass (idempotent). Returns nothing; use undoWideFrame(). */
export function ensureWideFrame(): void {
  if (undo) return;
  if (Platform.OS !== "web") return;
  const g = globalThis as unknown as WWin & { document?: WDoc };
  const doc = g.document;
  if (!doc || typeof g.getComputedStyle !== "function") return;

  const widened = new Set<WNode>();
  let paneWidthCache = 0;
  let lastInnerWidth = -1;

  // Measure the pane ABOVE any element we widened: a widened wrapper is
  // itself >= 860 wide, so a naive climb treats it as the pane and the next
  // target shrinks by 80px each pass. Start at the parent and skip widened
  // ancestors — the real pane containers are never 820-capped.
  const paneWidthFor = (el: WNode): number => {
    let node: WNode | null = el.parentElement;
    while (node) {
      if (node.dataset.inlineReviewWide !== "1" && node.clientWidth >= 860) break;
      node = node.parentElement;
    }
    return node?.clientWidth ?? 0;
  };

  let raf = 0;
  const schedule = (): void => {
    if (raf) return;
    raf = g.requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  };

  const apply = (): void => {
    // Discover newly mounted 820-capped host elements (tool calls, user
    // messages, plugin items — everything shares the reading frame).
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      if (el.dataset.inlineReviewWide === "1") continue;
      if (g.getComputedStyle(el).maxWidth === "820px") {
        el.dataset.inlineReviewWide = "1";
        widened.add(el);
      }
    }
    if (widened.size === 0) return;
    const innerWidth = g.innerWidth ?? -1;
    if (paneWidthCache === 0) {
      // First pass: measure the pane BEFORE widening anything (clean chain).
      const first = widened.values().next().value ?? null;
      paneWidthCache = first ? paneWidthFor(first) : 0;
      lastInnerWidth = innerWidth;
    } else if (innerWidth !== lastInnerWidth && innerWidth > 0) {
      // Window resized: re-measure once against the (now widened) chain.
      lastInnerWidth = innerWidth;
      const first = widened.values().next().value ?? null;
      paneWidthCache = first ? paneWidthFor(first) : 0;
    }
    const paneWidth = paneWidthCache;
    if (paneWidth < 900) return; // narrow pane: leave the host frame alone
    const target = `${paneWidth - BREATHING}px`;
    for (const el of widened) {
      if (el.style.maxWidth !== target) el.style.maxWidth = target;
    }
  };

  const observerCbs: Array<() => void> = [];
  apply();
  // Push widening in the same frame as host re-renders: no visible
  // "old width" flash while items mount.
  const Observer = g.MutationObserver;
  if (Observer && doc.body) {
    const observer = new Observer(schedule);
    observer.observe(doc.body, { childList: true, subtree: true });
    observerCbs.push(() => observer.disconnect());
  }
  g.addEventListener("resize", schedule);
  observerCbs.push(() => g.removeEventListener("resize", schedule));

  undo = () => {
    for (const el of widened) {
      // Dropping the inline value restores the host class.
      el.style.maxWidth = "";
      el.dataset.inlineReviewWide = "";
    }
    widened.clear();
    paneWidthCache = 0;
    for (const cb of observerCbs) cb();
  };
}

export function undoWideFrame(): void {
  undo?.();
  undo = null;
}
