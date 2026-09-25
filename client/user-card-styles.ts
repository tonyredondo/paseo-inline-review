export interface UserCardStyleColors {
  accent?: string;
  raised?: string;
  border?: string;
}

type StyleNode = {
  dataset: Record<string, string>;
  parentElement: unknown;
  textContent: string | null;
  remove(): void;
};

type StyleDocument = {
  head?: { appendChild(node: StyleNode): void } | null;
  createElement(tag: string): StyleNode;
};

type UserCardStyleHost = {
  document?: StyleDocument;
  [key: symbol]: unknown;
};

type UserCardStyleState = {
  colors: UserCardStyleColors;
  document: StyleDocument | null;
  owners: Set<symbol>;
  style: StyleNode | null;
};

const USER_CARD_STYLE_STATE = Symbol.for("paseo.inline-review.user-card-styles.v1");

function stateFor(host: UserCardStyleHost): UserCardStyleState {
  const existing = host[USER_CARD_STYLE_STATE] as UserCardStyleState | undefined;
  if (existing?.owners instanceof Set) return existing;
  const created: UserCardStyleState = {
    colors: {},
    document: null,
    owners: new Set(),
    style: null,
  };
  host[USER_CARD_STYLE_STATE] = created;
  return created;
}

function alpha(hex: string | undefined, opacity: number, fallback: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match) return fallback;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${opacity})`;
}

function stylesheet(colors: UserCardStyleColors): string {
  const surface = /^#[0-9a-f]{6}$/i.test(colors.raised ?? "")
    ? colors.raised
    : "color-mix(in srgb, currentColor 8%, transparent)";
  const border = /^#[0-9a-f]{6}$/i.test(colors.border ?? "")
    ? colors.border
    : "color-mix(in srgb, currentColor 18%, transparent)";
  const accent = alpha(
    colors.accent,
    0.35,
    "color-mix(in srgb, currentColor 35%, transparent)",
  );
  const card = '[data-testid="agent-chat-scroll"] [data-testid="user-message"]';
  const plainCard = `${card}:not(:has([data-inline-review-user-images="1"]))`;
  return `${plainCard} {
  background-color: ${surface} !important;
  border-color: ${border} !important;
  border-style: solid !important;
  border-width: 1px !important;
  border-left-width: 5px !important;
  border-left-color: ${accent} !important;
  border-radius: 8px !important;
  box-sizing: border-box !important;
  margin-left: auto !important;
  max-width: 100% !important;
  overflow: visible !important;
  padding: 12px 10px 2px !important;
  position: relative !important;
  width: fit-content !important;
}
${card} > *:first-child > *:first-child {
  background-color: transparent !important;
}`;
}

function render(state: UserCardStyleState): void {
  if (state.style) state.style.textContent = stylesheet(state.colors);
}

/**
 * Keeps the baseline user-card skin independent of daemon ownership and DOM
 * timing. Every installed bundle shares one stylesheet in the Paseo window;
 * the observer-based pass only adds image, Markdown, and sizing refinements.
 */
export function retainUserCardStyles(
  host = globalThis as UserCardStyleHost,
): symbol {
  const owner = Symbol("inline-review-user-card-styles");
  const state = stateFor(host);
  state.owners.add(owner);
  const document = host.document;
  if (!document?.head) return owner;
  if (state.document !== document || !state.style?.parentElement) {
    state.style?.remove();
    const style = document.createElement("style");
    style.dataset.inlineReviewUserCardStyles = "1";
    state.document = document;
    state.style = style;
    render(state);
    document.head.appendChild(style);
  }
  return owner;
}

export function updateUserCardStyles(
  colors: UserCardStyleColors,
  host = globalThis as UserCardStyleHost,
): void {
  const state = stateFor(host);
  state.colors = { ...state.colors, ...colors };
  render(state);
}

export function releaseUserCardStyles(
  owner: symbol,
  host = globalThis as UserCardStyleHost,
): void {
  const state = stateFor(host);
  if (!state.owners.delete(owner) || state.owners.size > 0) return;
  state.style?.remove();
  state.style = null;
  state.document = null;
}
