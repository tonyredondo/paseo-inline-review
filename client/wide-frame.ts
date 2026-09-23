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
import { createAdaptiveSweep } from "./adaptive-sweep";
import {
  classifyWideFrameMutations,
  lowestCommonAncestor,
  type WideFrameMutation,
} from "./wide-frame-mutations";

export { wideFrameSettings };

export interface WideFrameColors {
  accent?: string;
  raised?: string;
  border?: string;
}

type WNode = {
  clientHeight: number;
  clientWidth: number;
  children: ArrayLike<WNode>;
  parentElement: WNode | null;
  previousElementSibling: WNode | null;
  nextElementSibling: WNode | null;
  childElementCount: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  setAttribute(name: string, value: string): void;
  insertBefore(node: WNode, before: WNode | null): void;
  remove(): void;
  matches?(selector: string): boolean;
  querySelectorAll?(selector: string): ArrayLike<WNode>;
};
type WDoc = {
  querySelectorAll(selector: string): ArrayLike<WNode>;
  body?: WNode | null;
  createElement(tag: string): WNode;
};
type WWin = {
  getComputedStyle(el: WNode): { maxWidth: string };
  innerWidth?: number;
  requestAnimationFrame(cb: () => void): number;
  cancelAnimationFrame?(id: number): void;
  MutationObserver?: new (cb: (mutations: unknown) => void) => {
    observe(
      target: WNode,
      options: { childList: boolean; subtree: boolean; attributes?: boolean; attributeFilter?: string[] },
    ): void;
    disconnect(): void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

const BREATHING = 160; // 80px of air per side
const USER_CARD_IMAGE_OVERLAP = 6;
const USER_CARD_TEXT_VERTICAL_PADDING = 5;
const USER_CARD_CONTROLS_BOTTOM_PADDING = 8;

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
let userCardRaised = "#1c2128";
let userCardBorder = "#30363d";

/**
 * Styles host user messages like the plugin's review cards: rounded card,
 * dimmed accent border on the left, and the card surface. The host renders
 * user messages right-aligned. Image attachments remain owned by the host,
 * but sit in a rail above the card instead of inside its painted surface.
 */
function queryWithin(root: WDoc | WNode, selector: string): WNode[] {
  const result = root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
  const node = root as WNode;
  if (typeof node.matches === "function" && node.matches(selector)) result.unshift(node);
  return result;
}

function styleUserMessages(root: WDoc | WNode, win: WWin, doc: WDoc): void {
  type UNode = WNode & {
    querySelectorAll(selector: string): ArrayLike<WNode>;
  };
  type UWin = {
    getComputedStyle(el: WNode): { maxWidth: string; backgroundColor: string };
  };
  const nodes = queryWithin(root, '[data-testid="user-message"]');
  const cs = win as unknown as UWin;
  for (const el of Array.from(nodes)) {
    el.style.borderRadius = "8px";
    el.style.borderTopStyle = "solid";
    el.style.borderTopColor = userCardBorder;
    el.style.borderRightStyle = "solid";
    el.style.borderRightColor = userCardBorder;
    el.style.borderBottomStyle = "solid";
    el.style.borderBottomColor = userCardBorder;
    el.style.borderLeftStyle = "solid";
    el.style.borderLeftColor = withAlpha(userCardAccent, 0.35);
    // Chat-bubble sizing: the card hugs its text and sits at the right edge
    // (margin-left auto right-aligns a fit-content block), wrapping at the
    // pane width for long text.
    el.style.width = "fit-content";
    el.style.maxWidth = "100%";
    el.style.boxSizing = "border-box";
    el.style.marginLeft = "auto";
    el.style.position = "relative";
    el.style.overflow = "visible";
    el.style.paddingLeft = "10px";
    el.style.paddingRight = "10px";
    el.dataset.inlineReviewUser = "1";
    // Clear the first painted descendant (the host bubble background) and
    // tighten its vertical padding — the card ran taller than its text.
    const rootEl = el as unknown as UNode;
    let cardBubble =
      Array.from(rootEl.querySelectorAll('[data-inline-review-user-inner="1"]'))[0] ?? null;
    if (!cardBubble) {
      for (const inner of Array.from(rootEl.querySelectorAll("*"))) {
        const bg = cs.getComputedStyle(inner).backgroundColor;
        if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
          cardBubble = inner;
          inner.dataset.inlineReviewUserInner = "1";
          break;
        }
      }
    }
    if (cardBubble) {
      cardBubble.style.backgroundColor = "transparent";
    }
    // Keep the host attachment buttons and their lightbox behavior intact.
    // The attachment row and text already share this painted host container,
    // so a one-column grid can size itself to whichever one is wider.
    const imageButtons = Array.from(
      rootEl.querySelectorAll('[aria-label="Open image attachment"]'),
    );
    const imageButton = imageButtons[0];
    let imageRow: WNode | null = imageButton ?? null;
    while (imageRow && imageRow.parentElement !== cardBubble) {
      imageRow = imageRow.parentElement;
    }
    for (const previous of Array.from(
      rootEl.querySelectorAll('[data-inline-review-user-images="1"]'),
    )) {
      // Keep the active rail intact. Clearing and rebuilding it makes the
      // plugin's own CSSOM writes wake the MutationObserver again.
      if (previous === imageRow) continue;
      previous.style.position = "";
      previous.style.bottom = "";
      previous.style.left = "";
      previous.style.zIndex = "";
      previous.style.display = "";
      previous.style.flexDirection = "";
      previous.style.flexWrap = "";
      previous.style.gap = "";
      previous.style.overflowX = "";
      previous.style.transform = "";
      previous.style.width = "";
      previous.style.maxWidth = "";
      previous.style.paddingTop = "";
      previous.style.marginBottom = "";
      previous.dataset.inlineReviewUserImages = "";
    }
    for (const previousImage of Array.from(
      rootEl.querySelectorAll('[data-inline-review-user-image="1"]'),
    )) {
      if (imageButtons.includes(previousImage)) continue;
      previousImage.style.flexShrink = "";
      previousImage.dataset.inlineReviewUserImage = "";
    }
    const previousBackdrops = Array.from(
      rootEl.querySelectorAll('[data-inline-review-user-backdrop="1"]'),
    );
    for (const previousBackdrop of previousBackdrops.slice(1)) {
      previousBackdrop.remove();
    }
    if (cardBubble && imageRow?.parentElement === cardBubble) {
      // The inert backdrop spans the complete host message, including its
      // trailing controls; its top edge still leaves the gallery protruding.
      // No Paseo content node is moved.
      el.style.backgroundColor = "transparent";
      el.style.borderTopWidth = "0px";
      el.style.borderRightWidth = "0px";
      el.style.borderBottomWidth = "0px";
      el.style.borderLeftWidth = "0px";
      el.style.paddingTop = "0px";
      el.style.paddingBottom = `${USER_CARD_CONTROLS_BOTTOM_PADDING}px`;
      el.style.isolation = "isolate";
      cardBubble.style.display = "grid";
      cardBubble.style.gridTemplateColumns = "minmax(0, 1fr)";
      cardBubble.style.gridAutoFlow = "row";
      cardBubble.style.justifyItems = "start";
      cardBubble.style.position = "relative";
      cardBubble.style.zIndex = "1";
      cardBubble.style.width = "100%";
      cardBubble.style.maxWidth = "100%";
      cardBubble.style.minWidth = "0px";
      cardBubble.style.overflowWrap = "anywhere";
      cardBubble.style.paddingTop = `${USER_CARD_TEXT_VERTICAL_PADDING}px`;
      cardBubble.style.paddingBottom = `${USER_CARD_TEXT_VERTICAL_PADDING}px`;

      for (const image of imageButtons) {
        image.style.flexShrink = "0";
        image.dataset.inlineReviewUserImage = "1";
      }
      imageRow.style.display = "flex";
      imageRow.style.flexDirection = "row";
      imageRow.style.flexWrap = "nowrap";
      imageRow.style.gap = "8px";
      imageRow.style.overflowX = "auto";
      imageRow.style.position = "relative";
      imageRow.style.zIndex = "2";
      imageRow.style.width = "max-content";
      imageRow.style.maxWidth = "100%";
      imageRow.style.minWidth = "0px";
      // Bring the gallery slightly into the card. The compact gap and balanced
      // text padding keep the images tied to the message without excess height.
      imageRow.style.paddingTop = "5px";
      imageRow.style.marginBottom = "4px";
      imageRow.dataset.inlineReviewUserImages = "1";

      let backdrop = previousBackdrops[0] ?? null;
      if (!backdrop) {
        backdrop = doc.createElement("div");
        backdrop.dataset.inlineReviewUserBackdrop = "1";
        backdrop.setAttribute("aria-hidden", "true");
      }
      if (backdrop.parentElement !== rootEl) {
        rootEl.insertBefore(backdrop, rootEl.children[0] ?? null);
      }
      backdrop.style.position = "absolute";
      backdrop.style.top = `${Math.max(imageRow.clientHeight - USER_CARD_IMAGE_OVERLAP, 0)}px`;
      backdrop.style.right = "0px";
      backdrop.style.bottom = "0px";
      backdrop.style.left = "0px";
      backdrop.style.zIndex = "0";
      backdrop.style.pointerEvents = "none";
      backdrop.style.backgroundColor = userCardRaised;
      backdrop.style.borderRadius = "8px";
      backdrop.style.borderTop = `1px solid ${userCardBorder}`;
      backdrop.style.borderRight = `1px solid ${userCardBorder}`;
      backdrop.style.borderBottom = `1px solid ${userCardBorder}`;
      backdrop.style.borderLeft = `5px solid ${withAlpha(userCardAccent, 0.35)}`;
    } else {
      // Solid raised fill + hairline border on the other sides for contrast
      // against the timeline; the accent stays on the left edge. Assign the
      // final no-image state directly so repeated passes do not oscillate
      // between regular and image-card styles.
      el.style.backgroundColor = userCardRaised;
      el.style.borderTopWidth = "1px";
      el.style.borderRightWidth = "1px";
      el.style.borderBottomWidth = "1px";
      el.style.borderLeftWidth = "5px";
      // The trailing row leaves dead space at the bottom; pad the top so the
      // text sits vertically centered in the card.
      el.style.paddingTop = "12px";
      el.style.paddingBottom = "2px";
      el.style.minWidth = "";
      el.style.isolation = "";
      for (const backdrop of previousBackdrops) backdrop.remove();
      if (cardBubble) {
        cardBubble.style.paddingTop = "6px";
        cardBubble.style.paddingBottom = "6px";
        cardBubble.style.display = "";
        cardBubble.style.gridTemplateColumns = "";
        cardBubble.style.gridAutoFlow = "";
        cardBubble.style.justifyItems = "";
        cardBubble.style.position = "";
        cardBubble.style.isolation = "";
        cardBubble.style.zIndex = "";
        cardBubble.style.width = "";
        cardBubble.style.maxWidth = "";
        cardBubble.style.minWidth = "";
        cardBubble.style.overflowWrap = "";
      }
    }
    // The trailing row (timestamp + actions) adds a band under the text;
    // pull it up so the card hugs the content.
    const trail = Array.from(rootEl.querySelectorAll('[data-testid="user-message-trailing-row"]'))[0];
    if (trail) {
      trail.style.marginTop = "-10px";
      trail.style.marginBottom = "0px";
      trail.style.position = "relative";
      trail.style.zIndex = "2";
    }
  }
}

/**
 * Tightens the gap under the collapsed tool-call row ("Ran N commands"):
 * the host wrapper carries a 16px bottom margin.
 */
function tightenToolCallRows(root: WDoc | WNode): void {
  const badges = queryWithin(root, '[data-testid="tool-call-group"]');
  for (const badge of Array.from(badges)) {
    const parent = badge.parentElement;
    if (parent) {
      parent.style.marginBottom = "6px";
      // Hug the paragraph ABOVE: cancel the previous message's bottom
      // padding + outer margin (host adds ~16px below each message).
      parent.style.marginTop = "-18px";
      parent.dataset.inlineReviewTight = "1";
    }
  }
}

function loosenToolCallRows(doc: WDoc): void {
  const nodes = doc.querySelectorAll('[data-inline-review-tight="1"]');
  for (const el of Array.from(nodes)) {
    el.style.marginBottom = "";
    el.style.marginTop = "";
    el.dataset.inlineReviewTight = "";
  }
}

/**
 * Turn separator: a full-width hairline right before each user message —
 * the marker that the agent's turn above it has ended. Skips the first
 * message of the thread (nothing to separate there). Re-inserted each
 * pass; host re-renders may remove it.
 */
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
    el.style.minWidth = "";
    el.style.boxSizing = "";
    el.style.position = "";
    el.style.overflow = "";
    el.style.isolation = "";
    el.style.paddingLeft = "";
    el.style.paddingRight = "";
    el.style.paddingTop = "";
    el.style.paddingBottom = "";
    el.dataset.inlineReviewUser = "";
    el.style.marginLeft = "";
    el.style.marginTop = "";
    for (const inner of Array.from(rootEl.querySelectorAll('[data-inline-review-user-inner="1"]'))) {
      inner.style.backgroundColor = "";
      inner.style.paddingTop = "";
      inner.style.paddingBottom = "";
      inner.style.display = "";
      inner.style.gridTemplateColumns = "";
      inner.style.gridAutoFlow = "";
      inner.style.justifyItems = "";
      inner.style.position = "";
      inner.style.isolation = "";
      inner.style.zIndex = "";
      inner.style.width = "";
      inner.style.maxWidth = "";
      inner.style.minWidth = "";
      inner.style.overflowWrap = "";
      inner.dataset.inlineReviewUserInner = "";
    }
    for (const imageRow of Array.from(
      rootEl.querySelectorAll('[data-inline-review-user-images="1"]'),
    )) {
      imageRow.style.position = "";
      imageRow.style.bottom = "";
      imageRow.style.left = "";
      imageRow.style.zIndex = "";
      imageRow.style.display = "";
      imageRow.style.flexDirection = "";
      imageRow.style.flexWrap = "";
      imageRow.style.gap = "";
      imageRow.style.overflowX = "";
      imageRow.style.transform = "";
      imageRow.style.width = "";
      imageRow.style.maxWidth = "";
      imageRow.style.minWidth = "";
      imageRow.style.paddingTop = "";
      imageRow.style.marginBottom = "";
      imageRow.dataset.inlineReviewUserImages = "";
    }
    for (const image of Array.from(
      rootEl.querySelectorAll('[data-inline-review-user-image="1"]'),
    )) {
      image.style.flexShrink = "";
      image.dataset.inlineReviewUserImage = "";
    }
    for (const backdrop of Array.from(
      rootEl.querySelectorAll('[data-inline-review-user-backdrop="1"]'),
    )) {
      backdrop.remove();
    }
    for (const trail of Array.from(rootEl.querySelectorAll('[data-testid="user-message-trailing-row"]'))) {
      trail.style.marginTop = "";
      trail.style.marginBottom = "";
      trail.style.position = "";
      trail.style.zIndex = "";
    }
  }
}

let undo: (() => void) | null = null;
let installedDocument: WDoc | null = null;
let refreshInstalled: ((colors?: WideFrameColors) => void) | null = null;

function applyUserCardColors(colors?: WideFrameColors): void {
  if (!colors) return;
  if (colors.accent) userCardAccent = colors.accent;
  if (colors.raised) userCardRaised = colors.raised;
  if (colors.border) userCardBorder = colors.border;
}

/** Installs the web widening pass (idempotent). Colors refresh card styling. */
export function ensureWideFrame(colors?: WideFrameColors): void {
  if (Platform.OS !== "web") return;
  const g = globalThis as unknown as WWin & { document?: WDoc };
  const doc = g.document;
  if (!doc || typeof g.getComputedStyle !== "function") return;
  if (undo && installedDocument === doc && refreshInstalled) {
    refreshInstalled(colors);
    return;
  }
  if (undo) undoWideFrame();
  installedDocument = doc;
  applyUserCardColors(colors);

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
  let scanScope: WNode | WDoc | null = null;
  let fullSweep = false;
  let stylePassPending = false;
  let disposed = false;
  let rebindObserverRoot = (): void => {};
  const markerSelector = '[data-testid="inline-review-root"], [data-testid="user-message"], [data-testid="tool-call-group"]';
  const requestRun = (): void => {
    if (raf) return;
    raf = g.requestAnimationFrame(() => {
      raf = 0;
      if (disposed) return;
      const shouldScan = fullSweep || scanScope !== null;
      const scope = fullSweep ? null : scanScope;
      const shouldStyle = stylePassPending;
      scanScope = null;
      fullSweep = false;
      stylePassPending = false;
      if (shouldScan) apply(scope);
      else if (shouldStyle) applyStylesOnly();
    });
  };
  const scheduleStyleOnly = (): void => {
    stylePassPending = true;
    requestRun();
  };
  const schedule = (scope?: WNode | WDoc): void => {
    if (scope) {
      // Merge scopes: a full sweep supersedes incremental ones.
      if (scanScope === null) scanScope = scope;
      else if (scope !== scanScope) fullSweep = true;
    } else {
      fullSweep = true;
    }
    requestRun();
  };

  const scanCandidates = (root: WNode | WDoc | null): WNode[] => {
    const scope = root ?? doc;
    const candidates = new Set<WNode>();
    if (root && root !== (doc as unknown as WNode)) candidates.add(root as WNode);
    for (const marker of queryWithin(scope, markerSelector)) {
      for (let current: WNode | null = marker; current; current = current.parentElement) {
        candidates.add(current);
        // A marker may be inserted after its capped wrapper. Climb to the
        // stable body boundary so that wrapper is discovered without reading
        // layout for every unrelated mutation observed elsewhere in the app.
        if (current === doc.body) break;
      }
    }
    return [...candidates];
  };

  /** Cheap re-apply of already-computed widening (host re-renders wipe it). */
  const applyStylesOnly = (): void => {
    const paneWidth = paneWidthCache;
    if (paneWidth >= 900) {
      const target = `${paneWidth - BREATHING}px`;
      for (const el of widened) {
        if (el.style.maxWidth !== target) el.style.maxWidth = target;
      }
    }
  };

  const applyWidths = (scope: WNode | WDoc | null = null): boolean => {
    // Discover newly mounted 820-capped host elements (tool calls, user
    // messages, plugin items — everything shares the reading frame).
    for (const el of scanCandidates(scope)) {
      // A client bundle replacement can leave our DOM marker in place after
      // the module-local Set is gone. Adopt that wrapper into this instance;
      // otherwise old rows keep the previous target while new rows use the
      // newly measured width and the timeline splits into two columns.
      if (el.dataset.inlineReviewWide === "1") {
        widened.add(el);
        continue;
      }
      if (g.getComputedStyle(el).maxWidth === "820px") {
        el.dataset.inlineReviewWide = "1";
        widened.add(el);
      }
    }
    if (widened.size === 0) return false;
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
    if (paneWidth < 900) return false; // narrow pane: leave the host frame alone
    const target = `${paneWidth - BREATHING}px`;
    for (const el of widened) {
      if (el.style.maxWidth !== target) el.style.maxWidth = target;
    }
    return true;
  };

  const apply = (scope: WNode | WDoc | null = null): void => {
    if (!applyWidths(scope)) return;
    // User messages: review-card look (re-applied; host re-renders wipe it).
    const styleRoot = scope ?? doc;
    styleUserMessages(styleRoot, g, doc);
    tightenToolCallRows(styleRoot);
    rebindObserverRoot();
  };

  refreshInstalled = (nextColors?: WideFrameColors): void => {
    applyUserCardColors(nextColors);
    apply();
  };
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
      removeEventListener?: (type: string, cb: () => void) => void;
    };
  };
  let removeZoomHook = (): void => {};
  const installZoomHook = (): void => {
    removeZoomHook();
    removeZoomHook = () => {};
    const dpr = withZoom.devicePixelRatio;
    if (typeof dpr !== "number" || typeof withZoom.matchMedia !== "function") return;
    const mql = withZoom.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = (): void => {
      schedule();
      installZoomHook(); // re-arm with the new ratio
    };
    mql.addEventListener?.("change", onChange);
    removeZoomHook = () => mql.removeEventListener?.("change", onChange);
  };
  installZoomHook();
  observerCbs.push(() => removeZoomHook());
  // Push widening in the same frame as host re-renders: no visible
  // "old width" flash while items mount.
  const Observer = g.MutationObserver;
  if (Observer && doc.body) {
    const body = doc.body;
    const adaptiveSweep = createAdaptiveSweep({
      run: () => {
        const paneWidth = paneWidthCache;
        const target = paneWidth >= 900 ? `${paneWidth - BREATHING}px` : "";
        if (target && [...widened].some((element) => element.style.maxWidth !== target)) {
          scheduleStyleOnly();
        }
        for (const marker of Array.from(doc.querySelectorAll(markerSelector))) {
          if (
            marker.dataset.inlineReviewUser !== "1" &&
            marker.dataset.inlineReviewTight !== "1" &&
            marker.parentElement?.dataset.inlineReviewTight !== "1"
          ) {
            schedule(marker);
          }
        }
      },
    });
    adaptiveSweep.start();
    observerCbs.push(() => adaptiveSweep.stop());
    const observer = new Observer((raw: unknown) => {
      const mutations = raw as WideFrameMutation[];
      // React re-renders rewrite the host wrappers' style props and wipe
      // our inline max-width, snapping items back to the 820px frame until
      // they are re-widened. Style flips on already-widened elements are
      // fixed by a targeted sweep; new nodes get a scoped scan.
      const work = classifyWideFrameMutations<WNode>({
        mutations,
        markerSelector,
      });
      // MutationObserver callbacks run before the browser paints. Repair only
      // width inside this callback: deferring that work can expose one frame
      // at 820px, while running card decoration here can make its own style
      // mutations recursively wake the observer and lock the renderer.
      if (work.repairWidenedStyles) applyStylesOnly();
      if (work.scopes.length === 1) {
        applyWidths(work.scopes[0]);
        rebindObserverRoot();
        schedule(work.scopes[0]);
      } else if (work.scopes.length > 1) {
        applyWidths();
        rebindObserverRoot();
        schedule();
      }
      if (work.repairWidenedStyles || work.scopes.length > 0) adaptiveSweep.wake();
    });
    let observedRoot: WNode | null = null;
    let observedParent: WNode | null = null;
    const isUnderBody = (node: WNode): boolean => {
      for (let current: WNode | null = node; current; current = current.parentElement) {
        if (current === body) return true;
      }
      return false;
    };
    const observerRootForTimeline = (): WNode => {
      const connected = [...widened].filter(isUnderBody);
      const common = lowestCommonAncestor(connected);
      if (!common || common === body) return body;
      // With only one row mounted, observe its parent so the next sibling is
      // still delivered without falling back to the document-wide subtree.
      return common.dataset.inlineReviewWide === "1"
        ? common.parentElement ?? common
        : common;
    };
    rebindObserverRoot = (): void => {
      const nextRoot = observerRootForTimeline();
      const nextParent = nextRoot.parentElement;
      if (nextRoot === observedRoot && nextParent === observedParent) return;
      if (observedRoot) observer.disconnect();
      observedRoot = nextRoot;
      observedParent = nextParent;
      observer.observe(nextRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "data-testid"],
      });
      // A shallow sentinel notices replacement of the complete timeline root
      // without subscribing to style or descendant churn elsewhere in Paseo.
      if (nextParent) {
        observer.observe(nextParent, {
          childList: true,
          subtree: false,
        });
      }
    };
    rebindObserverRoot();
    observerCbs.push(() => observer.disconnect());
  }
  const onResize = (): void => schedule();
  g.addEventListener("resize", onResize);
  observerCbs.push(() => g.removeEventListener("resize", onResize));

  undo = () => {
    disposed = true;
    if (raf) g.cancelAnimationFrame?.(raf);
    raf = 0;
    for (const el of widened) {
      // Dropping the inline value restores the host class.
      el.style.maxWidth = "";
      el.dataset.inlineReviewWide = "";
    }
    widened.clear();
    paneWidthCache = 0;
    unstyleUserMessages(doc);
    loosenToolCallRows(doc);
    for (const cb of observerCbs) cb();
    if (installedDocument === doc) {
      installedDocument = null;
      refreshInstalled = null;
    }
  };
}

export function undoWideFrame(): void {
  undo?.();
  undo = null;
  installedDocument = null;
  refreshInstalled = null;
}
