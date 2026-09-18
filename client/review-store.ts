import { loadCommentsRpc, reviewCommentSchema, saveCommentsRpc, type ReviewComment } from "../shared/review";

type Listener = () => void;

let comments: ReviewComment[] = [];
const listeners = new Set<Listener>();

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
  return updated;
}

export function removeComment(id: string): void {
  comments = comments.filter((comment) => comment.id !== id);
  emit();
}

export function clearAgent(agentId: string): void {
  comments = comments.filter((comment) => comment.agentId !== agentId);
  emit();
}

// --- Server sync ------------------------------------------------------------

type SaveFn = (input: { agentId: string; comments: ReviewComment[] }) => Promise<unknown>;
type LoadFn = (input: { agentId: string }) => Promise<{ comments: ReviewComment[] }>;

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Pushes the agent's comments to the daemon store, debounced per agent. */
export function scheduleSave(
  agentId: string,
  save: (input: { agentId: string; comments: ReviewComment[] }) => Promise<unknown>,
): void {
  const previous = saveTimers.get(agentId);
  if (previous) clearTimeout(previous);
  saveTimers.set(
    agentId,
    setTimeout(() => {
      saveTimers.delete(agentId);
      void save({ agentId, comments: getComments().filter((comment) => comment.agentId === agentId) });
    }, 300),
  );
}

/**
 * Merges persisted comments into the client store for one agent. The server
 * list is authoritative for ids the client does not have (fresh app start) and
 * for status changes; client-only comments survive.
 */
export function hydrate(agentId: string, serverComments: ReviewComment[]): void {
  const known = new Map(getComments().filter((comment) => comment.agentId === agentId).map((comment) => [comment.id, comment]));
  const merged: ReviewComment[] = [];
  for (const serverComment of serverComments) {
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
  void load({ agentId })
    .then((result) => hydrate(agentId, result.comments))
    .catch(() => {});
}
