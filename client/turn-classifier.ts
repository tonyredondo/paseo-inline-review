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

type AgentTurns = {
  /** Latest assistant messageId observed per turnId. */
  lastAssistant: Map<string, string>;
  finalIds: Set<string>;
  intermediateIds: Set<string>;
  /** Version bump used as the useSyncExternalStore snapshot. */
  version: number;
  ready: boolean;
};

type TimelineItemLike = {
  type: string;
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
    if (item.type !== "assistant_message") return;
    const key = turnId ?? "";
    const messageId = item.messageId ?? null;
    if (messageId === null) return;
    const previous = state.lastAssistant.get(key);
    if (previous && previous !== messageId) {
      // A newer assistant message arrived for this turn: the previous one is
      // intermediate narration between tool calls.
      state.intermediateIds.add(previous);
      state.finalIds.delete(previous);
    }
    state.lastAssistant.set(key, messageId);
    state.finalIds.add(messageId);
    state.intermediateIds.delete(messageId);
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
            refetch(options?: { direction?: string }): Promise<{
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
      const payload = await client.agents.ref(agentId).timeline.refetch({ direction: "tail" });
      const entries = [...payload.entries].reverse(); // refetch tail = oldest last
      // Rebuild: a turn starts at each user message (fallback when entries
      // carry no turnId).
      let currentKey = "turn-0";
      const lastByTurn = new Map<string, string>();
      const finalIds = new Set<string>();
      const intermediateIds = new Set<string>();
      for (const entry of entries) {
        const item = entry.item;
        if (item.type === "user_message") {
          currentKey = `turn-${currentKey + 1}`;
          continue;
        }
        if (item.type !== "assistant_message" || !item.messageId) continue;
        const key = entry.turnId ?? currentKey;
        const previous = lastByTurn.get(key);
        if (previous && previous !== item.messageId) {
          intermediateIds.add(previous);
          finalIds.delete(previous);
        }
        lastByTurn.set(key, item.messageId);
        finalIds.add(item.messageId);
        intermediateIds.delete(item.messageId);
      }
      state.lastAssistant = lastByTurn;
      state.finalIds = finalIds;
      state.intermediateIds = intermediateIds;
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
