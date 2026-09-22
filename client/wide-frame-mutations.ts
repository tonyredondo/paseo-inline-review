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
          styled.dataset?.inlineReviewTight === "1" ||
          styled.matches?.(markerSelector)
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
