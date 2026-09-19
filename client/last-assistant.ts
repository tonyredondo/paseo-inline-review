/**
 * Tracks the id of the LAST assistant message seen per agent, in timeline
 * order. Rebuilt from timeline.refetch (canonical projection, ordered) and
 * kept current with live timeline events. The renderer uses it to mark the
 * latest assistant message (e.g. with a border) without touching the rest.
 */

type Listener = () => void;

class LastAssistantTracker {
  private lastIds = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  private subscriptions = new Map<string, () => void>();
  private loading = new Set<string>();

  private listenersFor(agentId: string): Set<Listener> {
    let set = this.listeners.get(agentId);
    if (!set) {
      set = new Set();
      this.listeners.set(agentId, set);
    }
    return set;
  }

  private notify(agentId: string): void {
    for (const listener of this.listenersFor(agentId)) listener();
  }

  subscribe(agentId: string, listener: Listener): () => void {
    this.listenersFor(agentId).add(listener);
    return () => {
      const set = this.listeners.get(agentId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(agentId);
    };
  }

  /** Snapshot for useSyncExternalStore: the id itself (null-safe). */
  version(agentId: string): string {
    return this.lastIds.get(agentId) ?? "";
  }

  get(agentId: string): string | null {
    return this.lastIds.get(agentId) ?? null;
  }

  /** Is this messageId the latest assistant message of the agent? */
  isLast(agentId: string, messageId: string | null): boolean {
    if (messageId === null || messageId === undefined) return false;
    return this.lastIds.get(agentId) === messageId;
  }

  /** Feeds one item in timeline order (live event). */
  observe(agentId: string, item: { type?: string; messageId?: string | null }): void {
    if (item.type !== "assistant_message") return;
    const messageId = item.messageId ?? null;
    if (messageId === null || this.lastIds.get(agentId) === messageId) return;
    this.lastIds.set(agentId, messageId);
    this.notify(agentId);
  }

  /**
   * Rebuilds from the full ordered timeline and starts the live subscription.
   * Idempotent per agent.
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
              entries: {
                item: {
                  type?: string;
                  messageId?: string | null;
                };
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
    this.loading.add(agentId);
    try {
      // Canonical projection: raw items, so ids are the real ones.
      const payload = await client.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", projection: "canonical" });
      const entries = [...payload.entries].reverse(); // oldest last
      let last: string | null = null;
      for (const entry of entries) {
        const item = entry.item;
        const type = item.type === "plugin" ? "assistant_message" : item.type;
        if (type === "assistant_message" && item.messageId) last = item.messageId;
      }
      if (last && this.lastIds.get(agentId) !== last) {
        this.lastIds.set(agentId, last);
        this.notify(agentId);
      }
    } catch {
      // Unknown until a live event arrives; the renderer renders normally.
    } finally {
      this.loading.delete(agentId);
    }
    if (!this.subscriptions.has(agentId)) {
      const subscription = client.agents.ref(agentId).timeline.subscribe((raw: unknown) => {
        const event = raw as {
          event?: {
            type?: string;
            item?: { type?: string; messageId?: string | null };
          };
        };
        if (event.event?.type !== "timeline") return;
        this.observe(agentId, event.event.item ?? {});
      });
      await subscription.ready.catch(() => {});
      this.subscriptions.set(agentId, () => {
        void subscription.release();
      });
    }
  }
}

export const lastAssistantTracker = new LastAssistantTracker();
