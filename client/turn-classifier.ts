/**
 * Classifies assistant messages as the final answer of their turn or
 * intermediate narration between tool calls. The daemon timeline entries carry
 * a turnId, so the rule is: the LAST assistant message of a turn is final;
 * earlier ones in the same turn are intermediate.
 *
 * State is rebuilt from timeline.refetch() on first use per agent and kept
 * current through timeline.subscribe(); nothing persists (a reload rebuilds).
 */

type Listener = () => void;

export type IntermediateMessage = { messageId: string; text: string };

export type TurnGroup = {
  turnKey: string;
  /** Ordered intermediate messages of the turn. */
  messages: IntermediateMessage[];
};

type AgentTurns = {
  /** Latest assistant messageId observed per turnId. */
  lastAssistant: Map<string, string>;
  finalIds: Set<string>;
  intermediateIds: Set<string>;
  /** Intermediate texts per turn key, in arrival order. */
  turnGroups: Map<string, IntermediateMessage[]>;
  /** messageId -> turn key, for group lookup. */
  messageTurn: Map<string, string>;
  /** Assistant message texts, to fill group cards. */
  texts: Map<string, string>;
  /** Version bump used as the useSyncExternalStore snapshot. */
  version: number;
  ready: boolean;
};

type TimelineItemLike = {
  type: string;
  text?: string | null;
  messageId?: string | null;
  turnId?: string | null;
};

type TimelineEntryLike = {
  item: TimelineItemLike;
  turnId?: string | null;
};

class TurnClassifier {
  private agents = new Map<string, AgentTurns>();
  private listeners = new Map<string, Set<Listener>>();
  private subscriptions = new Map<string, () => void>();
  private loading = new Set<string>();

  private state(agentId: string): AgentTurns {
    let state = this.agents.get(agentId);
    if (!state) {
      state = {
        lastAssistant: new Map(),
        finalIds: new Set(),
        intermediateIds: new Set(),
        turnGroups: new Map(),
        messageTurn: new Map(),
        texts: new Map(),
        version: 0,
        ready: false,
      };
      this.agents.set(agentId, state);
    }
    return state;
  }

  private notify(agentId: string): void {
    const state = this.state(agentId);
    state.version += 1;
    const listeners = this.listeners.get(agentId);
    if (listeners) {
      for (const listener of listeners) listener();
    }
  }

  subscribe(agentId: string, listener: Listener): () => void {
    let set = this.listeners.get(agentId);
    if (!set) {
      set = new Set();
      this.listeners.set(agentId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(agentId);
    };
  }

  /** Last turn key that saw an assistant message (streaming fallback). */
  private currentTurn(agentId: string): string {
    for (const [turnKey] of [...this.state(agentId).lastAssistant].reverse()) {
      return turnKey;
    }
    return "";
  }

  /** Version counter usable as a useSyncExternalStore snapshot. */
  roleVersion(agentId: string): number {
    return this.state(agentId).version;
  }

  /** Snapshot for useSyncExternalStore: the role of this message or "unknown". */
  role(agentId: string, messageId: string | null): "final" | "intermediate" | "unknown" {
    const state = this.agents.get(agentId);
    if (!state || messageId === null || messageId === undefined) return "unknown";
    if (state.intermediateIds.has(messageId)) return "intermediate";
    if (state.finalIds.has(messageId)) return "final";
    return "unknown";
  }

  /** Feeds one item in timeline order (live event or refetch replay). */
  observe(
    agentId: string,
    item: TimelineItemLike,
    turnId?: string | null,
  ): void {
    const state = this.state(agentId);
    // Projected timelines replace raw items with our own plugin items: a sent
    // review card closes the turn (like a user message); an assistant overlay
    // counts as an assistant message.
    if (item.type === "plugin") {
      const kind = (item as { kind?: string }).kind;
      if (kind === "inline-review-sent") {
        const turnKey = turnId ?? this.currentTurn(agentId);
        const previous = state.lastAssistant.get(turnKey);
        if (previous) {
          // The review closes the turn: the last assistant message is final,
          // and the next assistant message starts fresh even with the same id.
          state.finalIds.add(previous);
          state.lastAssistant.delete(turnKey);
        }
      }
      return;
    }
    if (item.type !== "assistant_message") return;
    if (item.text) state.texts.set(item.messageId ?? "", item.text);
    const key = turnId ?? "";
    const messageId = item.messageId ?? null;
    if (messageId === null) return;
    const previous = state.lastAssistant.get(key);
    if (previous && previous !== messageId) {
      // A newer assistant message arrived for this turn: the previous one is
      // intermediate narration between tool calls.
      state.intermediateIds.add(previous);
      state.finalIds.delete(previous);
      this.recordIntermediate(state, key, previous, state.texts.get(previous) ?? "");
    }
    state.lastAssistant.set(key, messageId);
    state.finalIds.add(messageId);
    state.intermediateIds.delete(messageId);
    state.messageTurn.set(messageId, key);
    if (state.intermediateIds.has(messageId)) {
      this.recordIntermediate(state, key, messageId, item.text ?? "");
    }
  }

  /** Keeps the per-turn intermediate list (ordered, texts for the group card). */
  private recordIntermediate(
    state: AgentTurns,
    turnKey: string,
    messageId: string,
    text: string,
  ): void {
    const group = state.turnGroups.get(turnKey) ?? [];
    if (!group.some((message) => message.messageId === messageId)) {
      group.push({ messageId, text });
    } else {
      const index = group.findIndex((message) => message.messageId === messageId);
      if (index !== -1 && text !== "intermediate text unavailable") group[index] = { messageId, text };
    }
    state.turnGroups.set(turnKey, group);
    state.messageTurn.set(messageId, turnKey);
  }

  /**
   * Group card for an intermediate message: only the FIRST intermediate of the
   * turn anchors the group; the others collapse to nothing in the renderer.
   */
  turnGroup(agentId: string, messageId: string | null): TurnGroup | null {
    const state = this.agents.get(agentId);
    if (!state || messageId === null || messageId === undefined) return null;
    if (!state.intermediateIds.has(messageId)) return null;
    const turnKey = state.messageTurn.get(messageId);
    if (!turnKey) return null;
    const group = state.turnGroups.get(turnKey) ?? [];
    if (group.length === 0) return { turnKey, messages: [] };
    const isFirst = group[0].messageId === messageId;
    if (!isFirst) return null;
    return { turnKey, messages: group };
  }

  /** True when this intermediate message is hidden inside its turn group. */
  isGroupedAway(agentId: string, messageId: string | null): boolean {
    const state = this.agents.get(agentId);
    if (!state || messageId === null || messageId === undefined) return false;
    if (!state.intermediateIds.has(messageId)) return false;
    const turnKey = state.messageTurn.get(messageId);
    if (!turnKey) return false;
    const group = state.turnGroups.get(turnKey) ?? [];
    return group.length > 0 && group[0].messageId !== messageId;
  }

  /**
   * Rebuilds classification from the full ordered timeline and starts the live
   * subscription for this agent. Idempotent per agent.
   */
  async ensure(
    client: {
      agents: {
        ref: (agent: string) => {
          timeline: {
            refetch(options?: {
              direction?: string;
              projection?: string;
            }): Promise<{
              entries: TimelineEntryLike[];
            }>;
            subscribe(handler: (event: unknown) => void): (() => void) & {
              ready: Promise<void>;
              release(): Promise<void>;
            };
          };
        };
      };
    },
    agentId: string,
  ): Promise<void> {
    const state = this.state(agentId);
    if (state.ready || this.loading.has(agentId)) return;
    this.loading.add(agentId);
    try {
      // Canonical projection: raw timeline items, so user_message turn
      // boundaries survive even when plugin renderers replace items.
      const payload = await client.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", projection: "canonical" });
      const entries = [...payload.entries].reverse(); // refetch tail = oldest last
      // Rebuild: a turn starts at each user message (fallback when entries
      // carry no turnId).
      let currentKey = "turn-0";
      let previousText = "";
      const lastByTurn = new Map<string, string>();
      const finalIds = new Set<string>();
      const intermediateIds = new Set<string>();
      const turnGroups = new Map<string, IntermediateMessage[]>();
      const messageTurn = new Map<string, string>();
      const texts = new Map<string, string>();
      for (const entry of entries) {
        const item = entry.item;
        // Projected timelines can carry our own plugin items instead of raw
        // ones: a sent-review card is a user message; an assistant overlay is
        // an assistant message.
        const pluginKind = item.type === "plugin" ? (item as { kind?: string }).kind : null;
        const effectiveType = pluginKind === "inline-review-sent"
          ? "user_message"
          : pluginKind === "inline-review"
            ? "assistant_message"
            : item.type;
        if (effectiveType === "user_message") {
          currentKey = `turn-${Number(currentKey.replace("turn-", "")) + 1}`;
          continue;
        }
        if (effectiveType !== "assistant_message" || !item.messageId) continue;
        const key = entry.turnId ?? currentKey;
        const previous = lastByTurn.get(key);
        if (previous && previous !== item.messageId) {
          intermediateIds.add(previous);
          finalIds.delete(previous);
          const group = turnGroups.get(key) ?? [];
          group.push({ messageId: previous, text: previousText ?? "" });
          turnGroups.set(key, group);
          messageTurn.set(previous, key);
        }
        lastByTurn.set(key, item.messageId);
        finalIds.add(item.messageId);
        intermediateIds.delete(item.messageId);
        messageTurn.set(item.messageId, key);
        previousText = item.text ?? "";
        texts.set(item.messageId, previousText);
      }
      state.lastAssistant = lastByTurn;
      state.finalIds = finalIds;
      state.intermediateIds = intermediateIds;
      state.turnGroups = turnGroups;
      state.messageTurn = messageTurn;
      state.texts = texts;
      state.ready = true;
      this.notify(agentId);
    } catch {
      // Classification stays unknown; the renderer renders normally.
    } finally {
      this.loading.delete(agentId);
    }
    if (!this.subscriptions.has(agentId)) {
      const subscription = client.agents
        .ref(agentId)
        .timeline.subscribe((raw: unknown) => {
          const event = raw as {
            event?: {
              type?: string;
              item?: TimelineItemLike;
              turnId?: string | null;
            };
          };
          const streamEvent = event.event;
          if (!streamEvent || streamEvent.type !== "timeline") return;
          this.observe(agentId, streamEvent.item ?? { type: "" }, streamEvent.turnId ?? null);
        });
      await subscription.ready.catch(() => {});
      this.subscriptions.set(agentId, () => {
        void subscription.release();
      });
    }
  }
}

export const turnClassifier = new TurnClassifier();
