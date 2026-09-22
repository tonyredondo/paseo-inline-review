import type { ReviewComment } from "../shared/review";

type Snapshot = { agentId: string; comments: ReviewComment[]; deleted?: string[] };

function versionKey(comment: ReviewComment): string {
  return `${comment.revision}:${comment.updatedAt}:${comment.status}:${comment.text}`;
}

/** Converts the existing full local snapshot boundary into acknowledged deltas. */
export function createCommentDeltaAdapter(
  send: (input: { agentId: string; upserts: ReviewComment[]; deleted: string[] }) => Promise<unknown>,
) {
  const acknowledged = new Map<string, Map<string, string>>();
  const acknowledgedDeletes = new Map<string, Set<string>>();

  function seed(agentId: string, comments: ReviewComment[], deleted: string[] = []): void {
    const versions = acknowledged.get(agentId) ?? new Map<string, string>();
    for (const comment of comments) versions.set(comment.id, versionKey(comment));
    acknowledged.set(agentId, versions);
    const tombstones = acknowledgedDeletes.get(agentId) ?? new Set<string>();
    for (const id of deleted) tombstones.add(id);
    acknowledgedDeletes.set(agentId, tombstones);
  }

  async function save(snapshot: Snapshot): Promise<void> {
    const versions = acknowledged.get(snapshot.agentId) ?? new Map<string, string>();
    const tombstones = acknowledgedDeletes.get(snapshot.agentId) ?? new Set<string>();
    const upserts = snapshot.comments.filter((comment) => versions.get(comment.id) !== versionKey(comment));
    const deleted = (snapshot.deleted ?? []).filter((id) => !tombstones.has(id));
    if (upserts.length === 0 && deleted.length === 0) return;
    await send({ agentId: snapshot.agentId, upserts, deleted });
    for (const comment of upserts) versions.set(comment.id, versionKey(comment));
    for (const id of deleted) {
      tombstones.add(id);
      versions.delete(id);
    }
    acknowledged.set(snapshot.agentId, versions);
    acknowledgedDeletes.set(snapshot.agentId, tombstones);
  }

  function clear(agentId: string): void {
    acknowledged.delete(agentId);
    acknowledgedDeletes.delete(agentId);
  }

  return { seed, save, clear };
}
