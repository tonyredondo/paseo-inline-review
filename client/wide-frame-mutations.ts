type MutationNode = {
  parentElement: MutationNode | null;
  style?: Record<string, string>;
  dataset?: Record<string, string>;
  querySelectorAll?(selector: string): ArrayLike<MutationNode>;
};

export type WideFrameMutation = {
  addedNodes: ArrayLike<MutationNode>;
  target: MutationNode;
  attributeName?: string;
};

/**
 * Reduces a MutationObserver batch to the exact repair work it requires.
 * Keeping this DOM-independent makes the hot-path routing executable in Node:
 * unrelated mutations never trigger a timeline scan, while a host style
 * rewrite repairs only the existing widened set.
 */
export function classifyWideFrameMutations<T extends MutationNode>({
  mutations,
  markerSelector,
  getMaxWidth,
}: {
  mutations: readonly WideFrameMutation[];
  markerSelector: string;
  getMaxWidth(node: T): string;
}): { repairWidenedStyles: boolean; scopes: T[] } {
  let repairWidenedStyles = false;
  const scopes = new Set<T>();

  for (const mutation of mutations) {
    if (
      mutation.attributeName === "style" &&
      mutation.target.dataset?.inlineReviewWide === "1"
    ) {
      repairWidenedStyles = true;
    }
    for (const node of Array.from(mutation.addedNodes)) {
      const element = node.style && node.dataset ? node : node.parentElement;
      if (!element?.style || !element.dataset) continue;
      const typed = element as T;
      if (
        typed.dataset!.inlineReviewWide === "1" ||
        getMaxWidth(typed) === "820px" ||
        (typed.querySelectorAll?.(markerSelector).length ?? 0) > 0
      ) {
        scopes.add(typed);
      }
    }
  }

  return { repairWidenedStyles, scopes: [...scopes] };
}
