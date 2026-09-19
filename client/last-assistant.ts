/**
 * Marks the FINAL assistant message of every COMPLETED turn: the border goes
 * on the message that answered each user interaction, never on intermediate
 * narration and never on a turn that is still running.
 *
 * Sources: canonical timeline refetch (ordered; entries carry turnId, or turn
 * boundaries are derived from user_message items) plus live events (timeline
 * items with turnId, turn_started/turn_completed). A sent-review plugin item
 * closes the turn like a user message does.
 */

type Listener = () => void;

type AgentTurns = {
  /** turnKey -> latest assistant messageId seen for that turn. */
  lastByTurn: Map<string, string>;
  /** Turns known to have completed (user reply, sent review, turn_completed). */
  completedTurns: Set<string>;
  /** messageId -> turnKey. */
  turnOfMessage: Map<string, string>;
  /** Turn key currently streaming, if any. */
  activeTurnKey: string;
};

class LastAssistantTracker {
  private agents = new Map<string, AgentTurns>();
  private listeners = new Map<string, Set<Listener>>();
  private subscriptions = new Map<string, () => void>();
  private loading = new Set<string>();

  private state(agentId: string): AgentTurns {
    let state = this.agents.get(agentId);
    if (!state) {
      state = {
        lastByTurn: new Map(),
        completedTurns: new Set(),
        turnOfMessage: new Map(),
        activeTurnKey: "",
      };
      this.agents.set(agentId, state);
    }
    return state;
  }

  private listenersFor(agentId: string): Set<Listener> {
    let set = this.listeners.get(agentId);
    if (!set) {
      set = new Set();
      this.listeners.set(agentId, set);
    }
    return set;
  }

  private notify(agentId: string): void {
    const set = this.listeners.get(agentId);
    if (!set) return;
    for (const listener of set) listener();
  }

  subscribe(agentId: string, listener: Listener): () => void {
    const set = this.listenersFor(agentId);
    set.add(listener);
    return () => {
      const current = this.listeners.get(agentId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(agentId);
    };
  }

  /** Snapshot for useSyncExternalStore: the final ids as one string. */
  version(agentId: string): string {
    const state = this.agents.get(agentId);
    if (!state) return "";
    const finals: string[] = [];
    for (const [turnKey, messageId] of state.lastByTurn) {
      if (state.completedTurns.has(turnKey)) finals.push(messageId);
    }
    return finals.sort().join(",");
  }

  /** Is this message the answered final of a completed turn? */
  isFinal(agentId: string, messageId: string | null): boolean {
    if (!messageId) return false;
    const state = this.agents.get(agentId);
    if (!state) return false;
    const turnKey = state.turnOfMessage.get(messageId);
    if (!turnKey) return false;
    if (!state.completedTurns.has(turnKey)) return false;
    return state.lastByTurn.get(turnKey) === messageId;
  }

  /** Feeds one timeline item in arrival order (live path). */
  observe(
    agentId: string,
    item: { type?: string; kind?: string; messageId?: string | null },
    turnId?: string | null,
  ): void {
    const state = this.state(agentId);
    if (item.type === "plugin") {
      if (item.kind === "inline-review-sent") {
        this.completeTurn(agentId, state);
      }
      return;
    }
    if (item.type === "user_message") {
      this.completeTurn(agentId, state);
      return;
    }
    if (item.type !== "assistant_message") return;
    const messageId = item.messageId ?? null;
    if (messageId === null) return;
    const turnKey = turnId ?? state.activeTurnKey;
    state.lastByTurn.set(turnKey, messageId);
    state.turnOfMessage.set(messageId, turnKey);
    state.activeTurnKey = turnKey;
    this.notify(agentId);
  }

  /** Live: the turn with this id completed; its last assistant gets the mark. */
  turnCompleted(agentId: string, turnId?: string | null): void {
    const state = this.state(agentId);
    const turnKey = turnId ?? state.activeTurnKey;
    if (turnKey) {
      state.completedTurns.add(turnKey);
      this.notify(agentId);
    }
  }

  private completeTurn(agentId: string, state: AgentTurns): void {
    const turnKey = state.activeTurnKey || [...state.lastByTurn.keys()].pop() || "";
    if (turnKey) {
      state.completedTurns.add(turnKey);
      this.notify(agentId);
    }
    state.activeTurnKey = "";
  }

  /**
   * Rebuilds from the canonical timeline and starts the live subscription.
   * Idempotent per agent.
   */
  async ensure(
    client: {
      agents: {
        ref: (agent: string) => {
          status: string | null;
          timeline: {
            refetch(options?: {
              direction?: string;
              projection?: string;
            }): Promise<{
              entries: {
                item: {
                  type?: string;
                  kind?: string;
                  messageId?: string | null;
                };
                turnId?: string | null;
              }[];
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
    if (this.loading.has(agentId)) return;
    if (this.subscriptions.has(agentId)) return;
    // Subscribe BEFORE refetching: no gap for events during the fetch.
    const subscription = client.agents.ref(agentId).timeline.subscribe((raw: unknown) => {
      const event = raw as {
        event?: {
          type?: string;
          item?: { type?: string; kind?: string; messageId?: string | null };
          turnId?: string | null;
        };
      };
      const streamEvent = event.event;
      if (!streamEvent) return;
      if (streamEvent.type === "timeline") {
        this.observe(agentId, streamEvent.item ?? {}, streamEvent.turnId ?? null);
      } else if (streamEvent.type === "turn_completed") {
        this.turnCompleted(agentId, streamEvent.turnId ?? null);
      } else if (streamEvent.type === "turn_started") {
        this.state(agentId).activeTurnKey = streamEvent.turnId ?? "";
      }
    });
    this.subscriptions.set(agentId, () => {
      void subscription.release();
    });
    await subscription.ready.catch(() => {});
    this.loading.add(agentId);
    try {
      const handle = client.agents.ref(agentId);
      const payload = await handle.timeline.refetch({
        direction: "tail",
        projection: "canonical",
      });
      const entries = [...payload.entries].reverse(); // oldest last
      // Walk the history and record, per turn, its last assistant message and
      // whether a turn boundary (user message / sent review) came after it.
      const lastByTurn = new Map<string, string>();
      const turnOfMessage = new Map<string, string>();
      const lastIndexByTurn = new Map<string, number>();
      const boundaryAfter = new Map<string, boolean>();
      const seenTurns: string[] = [];
      let implicit = 0;
      let sawBoundaryForCurrent = false;
      let lastTurnKey = "";
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const item = entry.item;
        const pluginKind = item.type === "plugin" ? item.kind : null;
        const effectiveType = pluginKind === "inline-review-sent"
          ? "user_message"
          : pluginKind === "inline-review"
            ? "assistant_message"
            : item.type;
        const isBoundary = effectiveType === "user_message";
        if (isBoundary) {
          if (lastTurnKey) lastIndexByTurn.set(lastTurnKey, index);
          sawBoundaryForCurrent = true;
          implicit += 1;
          continue;
        }
        if (effectiveType !== "assistant_message" || !item.messageId) continue;
        const turnKey = entry.turnId ?? `turn-${implicit}`;
        const previous = lastByTurn.get(turnKey);
        if (previous !== undefined && previous !== item.messageId) {
          sawBoundaryForCurrent = sawBoundaryForCurrent || false;
        }
        lastByTurn.set(turnKey, item.messageId);
        turnOfMessage.set(item.messageId, turnKey);
        if (!seenTurns.includes(turnKey)) seenTurns.push(turnKey);
        lastIndexByTurn.set(turnKey, index);
        lastTurnKey = turnKey;
      }
      void sawBoundaryForCurrent;
      // A turn is completed when a boundary came after its last assistant
      // message, or it is the final turn and the agent is idle.
      const agentIdle = handle.status === "idle";
      const finalTurn = lastTurnKey;
      const completed = new Set<string>();
      for (const turnKey of lastByTurn.keys()) {
        const lastIndex = lastIndexByTurn.get(turnKey) ?? -1;
        let hasBoundaryAfter = false;
        for (const [otherTurnKey, otherIndex] of lastIndexByTurn) {
          if (otherIndex <= lastIndex) continue;
          // Any later turn implies a user reply happened in between.
          if (otherTurnKey !== turnKey) hasBoundaryAfter = true;
        }
        if (hasBoundaryAfter || (turnKey === finalTurn && agentIdle)) completed.add(turnKey);
      }
      const state = this.state(agentId);
      state.lastByTurn = lastByTurn;
      state.turnOfMessage = turnOfMessage;
      state.completedTurns = completed;
      this.notify(agentId);
    } catch {
      // Live events still drive the tracker.
    } finally {
      this.loading.delete(agentId);
    }
  }
}

export const lastAssistantTracker = new LastAssistantTracker();
