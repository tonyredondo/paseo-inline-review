import type { ReviewComment } from "../shared/review";

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

export function removeComment(id: string): void {
  comments = comments.filter((comment) => comment.id !== id);
  emit();
}

export function clearAgent(agentId: string): void {
  comments = comments.filter((comment) => comment.agentId !== agentId);
  emit();
}
