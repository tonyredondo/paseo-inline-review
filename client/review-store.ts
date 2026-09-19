import { loadCommentsRpc, reviewCommentSchema, saveCommentsRpc, type ReviewComment } from "../shared/review";

type Listener = () => void;

let comments: ReviewComment[] = [];
const listeners = new Set<Listener>();
/**
 * Comment ids deleted on any device (this one included). They travel with
 * every save and block resurrection from stale device copies.
 */
const tombstones = new Map<string, Set<string>>();

function addTombstones(agentId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const set = tombstones.get(agentId) ?? new Set<string>();
  for (const id of ids) set.add(id);
  tombstones.set(agentId, set);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getComments(): ReviewComment[] {
  return comments;
}

let nextId = 0;

export function addComment(input: {
  agentId: string;
  messageId: string | null;
  paragraphIndex: number;
  paragraphText: string;
  text: string;
}): ReviewComment {
  const comment: ReviewComment = {
    id: `c${Date.now()}-${nextId++}`,
    agentId: input.agentId,
    messageId: input.messageId,
    paragraphIndex: input.paragraphIndex,
    paragraphText: input.paragraphText,
    text: input.text,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  // Guard against accidental duplicates from double submissions.
  const duplicate = comments.find(
    (existing) =>
      existing.agentId === comment.agentId &&
      existing.messageId === comment.messageId &&
      existing.paragraphIndex === comment.paragraphIndex &&
      existing.text === comment.text,
  );
  if (duplicate) return duplicate;
  comments = [...comments, comment];
  emit();
  autoSave(comment.agentId);
  return comment;
}

/**
 * Edits a comment's text. Editing a sent comment re-opens it: the new text has
 * not been sent yet. No-op when the text is unchanged.
 */
export function updateComment(id: string, text: string): ReviewComment | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const existing = comments.find((comment) => comment.id === id);
  if (!existing || existing.text === trimmed) return existing ?? null;
  const updated: ReviewComment = { ...existing, text: trimmed, status: "pending" };
  comments = comments.map((comment) => (comment.id === id ? updated : comment));
  emit();
  autoSave(existing.agentId);
  return updated;
}

/**
 * Fixes anchors captured during streaming: once the complete message id and
 * final paragraph layout are known, the comment re-binds to the paragraph its
 * text actually lives in. Keeps the status untouched.
 */
export function relocateComment(
  id: string,
  messageId: string | null,
  paragraphIndex: number,
): ReviewComment | null {
  const existing = comments.find((comment) => comment.id === id);
  if (!existing) return null;
  const updated = { ...existing, messageId, paragraphIndex };
  comments = comments.map((comment) => (comment.id === id ? updated : comment));
  emit();
  autoSave(existing.agentId);
  return updated;
}

/** Marks pending comments of one agent as sent (fastpath pill + panel send). */
export function markAgentCommentsSent(agentId: string): void {
  let changed = false;
  comments = comments.map((comment) => {
    if (comment.agentId !== agentId || comment.status !== "pending") return comment;
    changed = true;
    return { ...comment, status: "sent" as const };
  });
  if (changed) {
    emit();
    autoSave(agentId);
  }
}

export function removeComment(id: string): void {
  const removed = comments.find((comment) => comment.id === id);
  comments = comments.filter((comment) => comment.id !== id);
  emit();
  if (removed) {
    addTombstones(removed.agentId, [removed.id]);
    autoSave(removed.agentId);
  }
}

export function clearAgent(agentId: string): void {
  const removedIds = comments
    .filter((comment) => comment.agentId === agentId)
    .map((comment) => comment.id);
  comments = comments.filter((comment) => comment.agentId !== agentId);
  emit();
  addTombstones(agentId, removedIds);
  autoSave(agentId);
}

// --- Cross-process persistence ----------------------------------------------

type PersistFn = (input: { agentId: string; comments: ReviewComment[] }) => Promise<unknown>;

/**
 * Save function registered by the app shell (client.rpc is only available on
 * the client context, not inside React). Every mutation auto-saves so statuses
 * survive device switches even when the panel is not open.
 */
let persistFn: PersistFn | null = null;

export function registerPersist(fn: PersistFn): void {
  persistFn = fn;
}

function autoSave(agentId: string): void {
  if (persistFn) scheduleSave(agentId, persistFn);
}

// --- Server sync ------------------------------------------------------------

type SaveFn = (input: { agentId: string; comments: ReviewComment[]; deleted?: string[] }) => Promise<unknown>;
type LoadFn = (input: { agentId: string }) => Promise<{ comments: ReviewComment[] }>;

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Saves queued by the debounce or with an RPC in flight. */
let inFlightSaves = 0;
/** When the oldest in-flight save started, to bound the refresh block. */
let oldestInFlightAt: number | null = null;

/**
 * True while local mutations have not reached the daemon yet: refreshes must
 * wait, or a poll would resurrect comments a just-executed delete removed.
 * Bounded at 5s so a hung RPC cannot block hydration forever.
 */
export function hasPendingSaves(): boolean {
  if (saveTimers.size > 0) return true;
  if (inFlightSaves > 0 && Date.now() - (oldestInFlightAt ?? 0) < 5000) return true;
  if (inFlightSaves === 0) oldestInFlightAt = null;
  return false;
}

/** Pushes the agent's comments to the daemon store, debounced per agent. */
export function scheduleSave(
  agentId: string,
  save: (input: { agentId: string; comments: ReviewComment[]; deleted?: string[] }) => Promise<unknown>,
): void {
  const previous = saveTimers.get(agentId);
  if (previous) clearTimeout(previous);
  saveTimers.set(
    agentId,
    setTimeout(() => {
      saveTimers.delete(agentId);
      inFlightSaves += 1;
      if (oldestInFlightAt === null) oldestInFlightAt = Date.now();
      void save({
        agentId,
        comments: getComments().filter((comment) => comment.agentId === agentId),
        deleted: [...(tombstones.get(agentId) ?? [])],
      })
        .catch(() => {})
        .finally(() => {
          inFlightSaves -= 1;
          if (inFlightSaves <= 0) {
            inFlightSaves = 0;
            oldestInFlightAt = null;
          }
        });
    }, 300),
  );
}

/**
 * Merges persisted comments into the client store for one agent. The server
 * list is authoritative for ids the client does not have (fresh app start) and
 * for status changes; client-only comments survive.
 */
export function hydrate(agentId: string, serverComments: ReviewComment[], deleted: string[] = []): void {
  // Deletions from other devices win over local copies, so a stale device
  // cannot resurrect a removed comment.
  addTombstones(agentId, deleted);
  const deletedIds = tombstones.get(agentId) ?? new Set<string>();
  const known = new Map(
    getComments()
      .filter((comment) => comment.agentId === agentId && !deletedIds.has(comment.id))
      .map((comment) => [comment.id, comment]),
  );
  const merged: ReviewComment[] = [];
  for (const serverComment of serverComments) {
    // A tombstone (local delete or deletion from another device) always wins,
    // even when the server copy is still in flight from a stale device save.
    if (deletedIds.has(serverComment.id)) continue;
    const local = known.get(serverComment.id);
    if (local) {
      merged.push({ ...local, status: serverComment.status });
      known.delete(serverComment.id);
    } else {
      merged.push(serverComment);
    }
  }
  // Local comments the server has never seen (unsynced edits) stay pending.
  for (const local of known.values()) merged.push(local);
  comments = [...comments.filter((comment) => comment.agentId !== agentId), ...merged];
  emit();
}

/** Hydrates one agent from the daemon when the client store has nothing yet. */
export function hydrateFromServer(agentId: string, load: LoadFn): void {
  // Do not refresh while local mutations are still landing on the daemon: a
  // poll in that window would resurrect a just-deleted comment. The next poll
  // tick retries.
  if (hasPendingSaves()) return;
  void load({ agentId })
    .then((result) => {
      if (hasPendingSaves()) return;
      hydrate(agentId, result.comments, (result as { deleted?: string[] }).deleted ?? []);
    })
    .catch(() => {});
}
