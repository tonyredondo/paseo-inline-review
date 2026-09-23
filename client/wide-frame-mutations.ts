type MutationNode = {
  parentElement: MutationNode | null;
  style?: Record<string, string>;
  dataset?: Record<string, string>;
  matches?(selector: string): boolean;
  querySelectorAll?(selector: string): ArrayLike<MutationNode>;
};

export type WideFrameMutation = {
  addedNodes: ArrayLike<MutationNode>;
  target: MutationNode;
  attributeName?: string;
};

type ParentLinked<T> = { parentElement: T | null };

/** Drops nodes no longer owned by the current document subtree. */
export function pruneDisconnectedNodes<T extends ParentLinked<T>>(
  nodes: Set<T>,
  root: T,
): number {
  let removed = 0;
  for (const node of nodes) {
    let connected = false;
    for (let current: T | null = node; current; current = current.parentElement) {
      if (current === root) {
        connected = true;
        break;
      }
    }
    if (connected) continue;
    nodes.delete(node);
    removed += 1;
  }
  return removed;
}

/** Returns the lowest node that contains every parent-linked input node. */
export function lowestCommonAncestor<T extends ParentLinked<T>>(nodes: readonly T[]): T | null {
  if (nodes.length === 0) return null;
  for (let candidate: T | null = nodes[0]; candidate; candidate = candidate.parentElement) {
    const containsEveryNode = nodes.every((node) => {
      for (let current: T | null = node; current; current = current.parentElement) {
        if (current === candidate) return true;
      }
      return false;
    });
    if (containsEveryNode) return candidate;
  }
  return null;
}

/**
 * Reduces a MutationObserver batch to the exact repair work it requires.
 * Keeping this DOM-independent makes the hot-path routing executable in Node:
 * unrelated mutations never trigger a timeline scan, while a host style
 * rewrite repairs only the existing widened set.
 */
export function classifyWideFrameMutations<T extends MutationNode>({
  mutations,
  markerSelector,
}: {
  mutations: readonly WideFrameMutation[];
  markerSelector: string;
}): { repairWidenedStyles: boolean; scopes: T[] } {
  let repairWidenedStyles = false;
  const scopes = new Set<T>();

  for (const mutation of mutations) {
    if (
      mutation.attributeName === "data-testid" &&
      mutation.target.matches?.(markerSelector)
    ) {
      scopes.add(mutation.target as T);
    }
    if (
      mutation.attributeName === "style" &&
      mutation.target.dataset?.inlineReviewWide === "1"
    ) {
      repairWidenedStyles = true;
    }
    if (mutation.attributeName === "style") {
      let styled: MutationNode | null = mutation.target;
      while (styled) {
        if (
          styled.dataset?.inlineReviewUser === "1" ||
          styled.dataset?.inlineReviewTight === "1"
        ) {
          if (styled.style && styled.dataset) scopes.add(styled as T);
          break;
        }
        styled = styled.parentElement;
      }
    }
    for (const node of Array.from(mutation.addedNodes)) {
      const element = node.style && node.dataset ? node : node.parentElement;
      if (!element?.style || !element.dataset) continue;
      const typed = element as T;
      if (
        typed.dataset!.inlineReviewWide === "1" ||
        typed.matches?.(markerSelector) ||
        (typed.querySelectorAll?.(markerSelector).length ?? 0) > 0
      ) {
        scopes.add(typed);
      }
    }
  }

  return { repairWidenedStyles, scopes: [...scopes] };
}
