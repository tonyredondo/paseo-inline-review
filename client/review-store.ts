import { compareReviewCommentVersions, type ReviewComment } from "../shared/review.ts";

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

function touchComment(comment: ReviewComment, patch: Partial<ReviewComment>): ReviewComment {
  return {
    ...comment,
    ...patch,
    revision: (comment.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
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
  /** Zero-based list item index when the comment targets one list item. */
  itemIndex?: number | null;
  paragraphText: string;
  text: string;
  sourceKey?: string | null;
}): ReviewComment {
  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: `c${Date.now()}-${nextId++}`,
    agentId: input.agentId,
    messageId: input.messageId,
    paragraphIndex: input.paragraphIndex,
    itemIndex: input.itemIndex ?? null,
    paragraphText: input.paragraphText,
    text: input.text,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sourceKey: input.sourceKey ?? null,
    status: "pending",
  };
  // Guard against accidental duplicates from double submissions.
  const duplicate = comments.find(
    (existing) =>
      existing.agentId === comment.agentId &&
      existing.messageId === comment.messageId &&
      existing.sourceKey === comment.sourceKey &&
      existing.paragraphIndex === comment.paragraphIndex &&
      existing.itemIndex === comment.itemIndex &&
      existing.paragraphText === comment.paragraphText &&
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
  const updated = touchComment(existing, { text: trimmed, status: "pending" });
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
  if (
    existing.messageId === messageId &&
    existing.paragraphIndex === paragraphIndex &&
    (messageId === null || existing.sourceKey === null)
  ) {
    return existing;
  }
  const updated = touchComment(existing, {
    messageId,
    paragraphIndex,
    sourceKey: messageId === null ? existing.sourceKey : null,
  });
  comments = comments.map((comment) => (comment.id === id ? updated : comment));
  emit();
  autoSave(existing.agentId);
  return updated;
}

/** Marks only the exact comment versions included in a successful send. */
export function markCommentsSent(
  sentComments: readonly Pick<ReviewComment, "id" | "text" | "revision">[],
): void {
  const expected = new Map(sentComments.map((comment) => [
    comment.id,
    { text: comment.text, revision: comment.revision },
  ]));
  const changedAgents = new Set<string>();
  comments = comments.map((comment) => {
    const sentVersion = expected.get(comment.id);
    if (
      comment.status !== "pending" ||
      sentVersion?.text !== comment.text ||
      sentVersion.revision !== comment.revision
    ) {
      return comment;
    }
    changedAgents.add(comment.agentId);
    return touchComment(comment, { status: "sent" as const });
  });
  if (changedAgents.size === 0) return;
  emit();
  for (const agentId of changedAgents) autoSave(agentId);
}

/** Marks every pending comment for one agent as sent without messaging it. */
export function markAgentCommentsSent(agentId: string): void {
  markCommentsSent(
    comments.filter((comment) => comment.agentId === agentId && comment.status === "pending"),
  );
}

/** Updates one comment locally, then uses the same autosave path as edits. */
export function setCommentStatus(id: string, status: "pending" | "sent"): void {
  const existing = comments.find((comment) => comment.id === id);
  if (!existing || existing.status === status) return;
  comments = comments.map((comment) =>
    comment.id === id ? touchComment(comment, { status }) : comment,
  );
  emit();
  autoSave(existing.agentId);
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

type PersistFn = (input: {
  agentId: string;
  comments: ReviewComment[];
  deleted?: string[];
}) => Promise<unknown>;

/**
 * Save function registered by the app shell (client.rpc is only available on
 * the client context, not inside React). Every mutation auto-saves so statuses
 * survive device switches even when the panel is not open.
 */
let persistFn: PersistFn | null = null;

export function registerPersist(fn: PersistFn): () => Promise<void> {
  persistFn = fn;
  for (const agentId of dirtyAgents) scheduleSave(agentId, 0);
  return async () => {
    if (persistFn !== fn) return;
    persistFn = null;
    const agents = new Set<string>([
      ...dirtyAgents,
      ...saveTimers.keys(),
      ...saveChains.keys(),
    ]);
    for (const [agentId, timer] of saveTimers) {
      clearTimeout(timer);
      saveTimers.delete(agentId);
    }
    await Promise.all([...agents].map((agentId) => flushAgentOnCleanup(agentId, fn)));
  };
}

function autoSave(agentId: string): void {
  dirtyAgents.add(agentId);
  localVersions.set(agentId, (localVersions.get(agentId) ?? 0) + 1);
  if (persistFn) scheduleSave(agentId, SAVE_DEBOUNCE_MS);
}

// --- Server sync ------------------------------------------------------------

type LoadFn = (input: { agentId: string }) => Promise<{ comments: ReviewComment[]; deleted?: string[] }>;

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveChains = new Map<string, Promise<void>>();
const dirtyAgents = new Set<string>();
const localVersions = new Map<string, number>();
const retryAttempts = new Map<string, number>();
const SAVE_DEBOUNCE_MS = 300;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
const FINAL_SAVE_ATTEMPTS = 3;

async function flushAgentOnCleanup(agentId: string, save: PersistFn): Promise<void> {
  // Let any already-issued RPC settle first. Its completion may have cleared
  // the dirty bit, avoiding a duplicate final write.
  await (saveChains.get(agentId) ?? Promise.resolve()).catch(() => {});
  let lastError: unknown;
  for (let attempt = 0; attempt < FINAL_SAVE_ATTEMPTS && dirtyAgents.has(agentId); attempt += 1) {
    const snapshot = saveSnapshot(agentId);
    try {
      await save(snapshot.payload);
      retryAttempts.delete(agentId);
      if ((localVersions.get(agentId) ?? 0) === snapshot.version) {
        dirtyAgents.delete(agentId);
      }
    } catch (error) {
      lastError = error;
      dirtyAgents.add(agentId);
      if (attempt + 1 < FINAL_SAVE_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }
  if (dirtyAgents.has(agentId)) {
    console.error("inline-review: final comment save failed", lastError);
    throw lastError instanceof Error ? lastError : new Error("Final comment save failed");
  }
}

/**
 * True while local mutations have not reached the daemon yet: refreshes wait
 * so a stale response cannot overwrite an edit or resurrect a deletion.
 */
export function hasPendingSaves(agentId: string): boolean {
  return dirtyAgents.has(agentId) || saveTimers.has(agentId) || saveChains.has(agentId);
}

function saveSnapshot(agentId: string): {
  payload: { agentId: string; comments: ReviewComment[]; deleted: string[] };
  version: number;
} {
  return {
    payload: {
      agentId,
      comments: getComments().filter((comment) => comment.agentId === agentId),
      deleted: [...(tombstones.get(agentId) ?? [])],
    },
    version: localVersions.get(agentId) ?? 0,
  };
}

function queueSave(agentId: string, save: PersistFn, retry = true): Promise<void> {
  const snapshot = saveSnapshot(agentId);
  const previous = saveChains.get(agentId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await save(snapshot.payload);
  });
  saveChains.set(agentId, operation);
  void operation.then(
    () => finishSave(agentId, operation, snapshot.version, true, save, retry),
    (error) => finishSave(agentId, operation, snapshot.version, false, save, retry, error),
  );
  return operation;
}

function finishSave(
  agentId: string,
  operation: Promise<void>,
  savedVersion: number,
  succeeded: boolean,
  save: PersistFn,
  retry: boolean,
  error?: unknown,
): void {
  if (succeeded) {
    retryAttempts.delete(agentId);
    if ((localVersions.get(agentId) ?? 0) === savedVersion) dirtyAgents.delete(agentId);
  } else {
    dirtyAgents.add(agentId);
    console.error("inline-review: comment save failed", error);
  }
  if (saveChains.get(agentId) === operation) saveChains.delete(agentId);
  if (persistFn !== save || !dirtyAgents.has(agentId)) return;
  if (succeeded) {
    scheduleSave(agentId, 0);
  } else if (retry) {
    const attempt = (retryAttempts.get(agentId) ?? 0) + 1;
    retryAttempts.set(agentId, attempt);
    scheduleSave(agentId, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)));
  }
}

/** Pushes the agent's comments to the daemon store, debounced per agent. */
function scheduleSave(agentId: string, delayMs: number): void {
  const previous = saveTimers.get(agentId);
  if (previous) clearTimeout(previous);
  saveTimers.set(
    agentId,
    setTimeout(() => {
      saveTimers.delete(agentId);
      const save = persistFn;
      if (!save || !dirtyAgents.has(agentId)) return;
      void queueSave(agentId, save).catch(() => {
        // finishSave retains dirty state and schedules the retry.
      });
    }, delayMs),
  );
}

/** Flushes the latest local snapshot and reports persistence failures. */
export function persistAgentNow(agentId: string): Promise<void> {
  const save = persistFn;
  if (!save) return Promise.reject(new Error("Comment persistence is not registered"));
  const timer = saveTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(agentId);
  }
  return queueSave(agentId, save);
}

/**
 * Merges persisted comments into the client store for one agent. The server
 * list is authoritative for ids the client does not have. For shared ids the
 * newest revision wins, preventing a stale device from overwriting an edit.
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
      merged.push(compareReviewCommentVersions(serverComment, local) >= 0 ? serverComment : local);
      known.delete(serverComment.id);
    } else {
      merged.push(serverComment);
    }
  }
  // Local comments the server has never seen (unsynced edits) stay pending.
  for (const local of known.values()) merged.push(local);
  const previous = getComments().filter((comment) => comment.agentId === agentId);
  if (
    previous.length === merged.length &&
    previous.every((comment, index) => sameComment(comment, merged[index]))
  ) {
    return;
  }
  comments = [...comments.filter((comment) => comment.agentId !== agentId), ...merged];
  emit();
}

function sameComment(a: ReviewComment, b: ReviewComment): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.text === b.text &&
    a.paragraphIndex === b.paragraphIndex &&
    a.itemIndex === b.itemIndex &&
    a.messageId === b.messageId &&
    a.paragraphText === b.paragraphText &&
    a.sourceKey === b.sourceKey &&
    a.revision === b.revision &&
    a.updatedAt === b.updatedAt
  );
}

/** Hydrates one agent from the daemon when the client store has nothing yet. */
export function hydrateFromServer(agentId: string, load: LoadFn): void {
  // Do not refresh while local mutations are still landing on the daemon: a
  // poll in that window would resurrect a just-deleted comment. The next poll
  // tick retries.
  if (hasPendingSaves(agentId)) return;
  void load({ agentId })
    .then((result) => {
      if (hasPendingSaves(agentId)) return;
      hydrate(agentId, result.comments, result.deleted ?? []);
    })
    .catch((error) => {
      console.error("inline-review: comment hydration failed", error);
    });
}
