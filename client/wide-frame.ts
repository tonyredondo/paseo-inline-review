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

export interface WideFrameColors {
  accent?: string;
  surface?: string;
  raised?: string;
  border?: string;
}

type WNode = {
  clientWidth: number;
  parentElement: WNode | null;
  style: Record<string, string>;
  dataset: Record<string, string>;
};
type WDoc = { querySelectorAll(selector: string): ArrayLike<WNode>; body?: WNode | null };
type WWin = {
  getComputedStyle(el: WNode): { maxWidth: string };
  innerWidth?: number;
  requestAnimationFrame(cb: () => void): number;
  MutationObserver?: new (cb: () => void) => {
    observe(
      target: WNode,
      options: { childList: boolean; subtree: boolean; attributes?: boolean; attributeFilter?: string[] },
    ): void;
    disconnect(): void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

const HIDE = 860;
const BREATHING = 160; // 80px of air per side

/** Converts #rrggbb to rgba() so fills can fade without losing hue. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Colors for the user-message card pass (set at install time). */
let userCardAccent = "#58a6ff";
let userCardSurface = "#161b22";
let userCardRaised = "#1c2128";
let userCardBorder = "#30363d";

/**
 * Styles host user messages like the plugin's review cards: rounded card,
 * dimmed accent border on the left, and the card surface. The host renders
 * user messages right-aligned; this only changes the bubble's box style.
 */
function styleUserMessages(doc: WDoc, win: WWin): void {
  type UNode = WNode & {
    querySelectorAll(selector: string): ArrayLike<WNode>;
  };
  type UWin = {
    getComputedStyle(el: WNode): { maxWidth: string; backgroundColor: string };
  };
  const nodes = doc.querySelectorAll('[data-testid="user-message"]');
  const cs = win as unknown as UWin;
  for (const el of Array.from(nodes)) {
    el.style.borderRadius = "8px";
    // Solid raised fill + hairline border on the other sides for contrast
    // against the timeline; the accent stays on the left edge (3px).
    el.style.borderTopWidth = "1px";
    el.style.borderTopStyle = "solid";
    el.style.borderTopColor = userCardBorder;
    el.style.borderRightWidth = "1px";
    el.style.borderRightStyle = "solid";
    el.style.borderRightColor = userCardBorder;
    el.style.borderBottomWidth = "1px";
    el.style.borderBottomStyle = "solid";
    el.style.borderBottomColor = userCardBorder;
    el.style.borderLeftWidth = "5px";
    el.style.borderLeftStyle = "solid";
    el.style.borderLeftColor = withAlpha(userCardAccent, 0.35);
    // The card surface goes on the OUTSIDE element; the host's own inner
    // bubble is neutralized so there is one card, not a box in a box.
    el.style.backgroundColor = userCardRaised;
    // Chat-bubble sizing: the card hugs its text and sits at the right edge
    // (margin-left auto right-aligns a fit-content block), wrapping at the
    // pane width for long text.
    el.style.width = "fit-content";
    el.style.maxWidth = "100%";
    el.style.marginLeft = "auto";
    el.style.paddingLeft = "10px";
    el.style.paddingRight = "10px";
    // The trailing row leaves dead space at the bottom; pad the top so the
    // text sits vertically centered in the card.
    el.style.paddingTop = "12px";
    el.style.paddingBottom = "2px";
    el.dataset.inlineReviewUser = "1";
    // Clear the first painted descendant (the host bubble background) and
    // tighten its vertical padding — the card ran taller than its text.
    const rootEl = el as unknown as UNode;
    for (const inner of Array.from(rootEl.querySelectorAll("*"))) {
      const bg = cs.getComputedStyle(inner).backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
        inner.style.backgroundColor = "transparent";
        inner.dataset.inlineReviewUserInner = "1";
        inner.style.paddingTop = "6px";
        inner.style.paddingBottom = "6px";
        break;
      }
    }
    // The trailing row (timestamp + actions) adds a band under the text;
    // pull it up so the card hugs the content.
    const trail = Array.from(rootEl.querySelectorAll('[data-testid="user-message-trailing-row"]'))[0];
    if (trail) {
      trail.style.marginTop = "-10px";
      trail.style.marginBottom = "0px";
    }
  }
}

function unstyleUserMessages(doc: WDoc): void {
  const nodes = doc.querySelectorAll('[data-testid="user-message"]');
  for (const el of Array.from(nodes)) {
    const rootEl = el as unknown as { querySelectorAll(selector: string): ArrayLike<WNode> };
    el.style.borderRadius = "";
    el.style.borderLeftWidth = "";
    el.style.borderLeftStyle = "";
    el.style.borderLeftColor = "";
    el.style.borderTopWidth = "";
    el.style.borderTopStyle = "";
    el.style.borderTopColor = "";
    el.style.borderRightWidth = "";
    el.style.borderRightStyle = "";
    el.style.borderRightColor = "";
    el.style.borderBottomWidth = "";
    el.style.borderBottomStyle = "";
    el.style.borderBottomColor = "";
    el.style.backgroundColor = "";
    el.style.width = "";
    el.style.maxWidth = "";
    el.style.paddingLeft = "";
    el.style.paddingRight = "";
    el.style.paddingTop = "";
    el.style.paddingBottom = "";
    el.dataset.inlineReviewUser = "";
    el.style.marginLeft = "";
    for (const inner of Array.from(rootEl.querySelectorAll('[data-inline-review-user-inner="1"]'))) {
      inner.style.backgroundColor = "";
      inner.style.paddingTop = "";
      inner.style.paddingBottom = "";
      inner.dataset.inlineReviewUserInner = "";
    }
    for (const trail of Array.from(rootEl.querySelectorAll('[data-testid="user-message-trailing-row"]'))) {
      trail.style.marginTop = "";
      trail.style.marginBottom = "";
    }
  }
}

let undo: (() => void) | null = null;

/** Installs the web widening pass (idempotent). Colors refresh card styling. */
export function ensureWideFrame(colors?: WideFrameColors): void {
  if (undo) {
    if (colors) {
      if (colors.accent) userCardAccent = colors.accent;
      if (colors.surface) userCardSurface = colors.surface;
      if (colors.raised) userCardRaised = colors.raised;
      if (colors.border) userCardBorder = colors.border;
    }
    return;
  }
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
    // User messages: review-card look (re-applied; host re-renders wipe it).
    styleUserMessages(doc, g);
  };

  if (colors) {
    if (colors.accent) userCardAccent = colors.accent;
    if (colors.surface) userCardSurface = colors.surface;
    if (colors.raised) userCardRaised = colors.raised;
    if (colors.border) userCardBorder = colors.border;
  }
  const observerCbs: Array<() => void> = [];
  apply();
  // Zoom hook: browser/app zoom changes devicePixelRatio (the layout width
  // in CSS px stays constant). Watch the resolution media query; when it
  // flips, re-measure and re-apply with the new ratio, then re-arm with it.
  const withZoom = g as unknown as {
    devicePixelRatio?: number;
    matchMedia?: (query: string) => {
      matches: boolean;
      addEventListener?: (type: string, cb: () => void) => void;
    };
  };
  const installZoomHook = (): void => {
    const dpr = withZoom.devicePixelRatio;
    if (typeof dpr !== "number" || typeof withZoom.matchMedia !== "function") return;
    const mql = withZoom.matchMedia(`(resolution: ${dpr}dppx)`);
    mql.addEventListener?.("change", () => {
      schedule();
      installZoomHook(); // re-arm with the new ratio
    });
  };
  installZoomHook();
  // Push widening in the same frame as host re-renders: no visible
  // "old width" flash while items mount.
  const Observer = g.MutationObserver;
  if (Observer && doc.body) {
    const observer = new Observer(schedule);
    // Watch style attributes too: React re-renders rewrite the host
    // wrappers' style props and wipe our inline max-width, snapping items
    // back to the 820px frame until they are re-widened.
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
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
    unstyleUserMessages(doc);
    for (const cb of observerCbs) cb();
  };
}

export function undoWideFrame(): void {
  undo?.();
  undo = null;
}
