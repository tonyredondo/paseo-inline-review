export type WideFrameOwnerCandidate = {
  id: number | symbol;
  root: { clientWidth: number; clientHeight: number } | null;
};

type RegisteredWideFrameOwner = WideFrameOwnerCandidate & {
  setActive(active: boolean): void;
};

type WideFrameRoot = NonNullable<WideFrameOwnerCandidate["root"]>;
type RootWatch = {
  owners: Set<number | symbol>;
  observer: { disconnect(): void } | null;
};

type WideFrameOwnerRegistry = {
  owners: RegisteredWideFrameOwner[];
  activeOwnerId: number | symbol | null;
  rootWatches: Map<WideFrameRoot, RootWatch>;
};

type WideFrameOwnerHost = {
  [key: symbol]: unknown;
  ResizeObserver?: new (callback: () => void) => {
    observe(target: object): void;
    disconnect(): void;
  };
};

const OWNER_REGISTRY = Symbol.for("paseo.inline-review.wide-frame-owners.v1");

function ownerRegistry(host: WideFrameOwnerHost): WideFrameOwnerRegistry {
  const existing = host[OWNER_REGISTRY] as WideFrameOwnerRegistry | undefined;
  if (existing?.owners instanceof Array) {
    existing.rootWatches ??= new Map();
    return existing;
  }
  const created: WideFrameOwnerRegistry = {
    owners: [],
    activeOwnerId: null,
    rootWatches: new Map(),
  };
  host[OWNER_REGISTRY] = created;
  return created;
}

/**
 * Keeps the current owner while it is visible, otherwise hands ownership to
 * the newest visible timeline. Hidden workspaces stay mounted in Paseo, so
 * mount order alone cannot identify the timeline the user is looking at.
 */
export function selectVisibleWideFrameOwner(
  owners: readonly WideFrameOwnerCandidate[],
  currentOwnerId: number | symbol | null,
): number | symbol | null {
  const current = owners.find((owner) => owner.id === currentOwnerId);
  if (current?.root && current.root.clientWidth > 0 && current.root.clientHeight > 0) {
    return current.id;
  }
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const owner = owners[index];
    if (owner.root && owner.root.clientWidth > 0 && owner.root.clientHeight > 0) {
      return owner.id;
    }
  }
  return null;
}

function reconcileWideFrameOwners(state: WideFrameOwnerRegistry): void {
  const nextOwnerId = selectVisibleWideFrameOwner(state.owners, state.activeOwnerId);
  if (nextOwnerId === state.activeOwnerId) return;
  state.owners.find((owner) => owner.id === state.activeOwnerId)?.setActive(false);
  state.activeOwnerId = nextOwnerId;
  state.owners.find((owner) => owner.id === state.activeOwnerId)?.setActive(true);
}

function retainRootWatch(
  state: WideFrameOwnerRegistry,
  host: WideFrameOwnerHost,
  owner: RegisteredWideFrameOwner,
): () => void {
  const root = owner.root;
  if (!root) return () => {};
  let watch = state.rootWatches.get(root);
  if (!watch) {
    const observer = host.ResizeObserver
      ? new host.ResizeObserver(() => reconcileWideFrameOwners(ownerRegistry(host)))
      : null;
    observer?.observe(root);
    watch = { owners: new Set(), observer };
    state.rootWatches.set(root, watch);
  }
  watch.owners.add(owner.id);
  return () => {
    const current = ownerRegistry(host);
    const currentWatch = current.rootWatches.get(root);
    if (!currentWatch) return;
    currentWatch.owners.delete(owner.id);
    if (currentWatch.owners.size > 0) return;
    currentWatch.observer?.disconnect();
    current.rootWatches.delete(root);
  };
}

/**
 * Registers an owner in a cross-bundle registry. Every connected daemon can
 * load its own copy of this module into the same Paseo window, so module-local
 * arrays cannot arbitrate which mounted timeline owns the shared DOM runtime.
 */
export function registerWideFrameOwner(
  root: WideFrameOwnerCandidate["root"],
  setActive: (active: boolean) => void,
  host = globalThis as unknown as WideFrameOwnerHost,
): {
  id: symbol;
  reconcile(): void;
  release(): void;
} {
  const state = ownerRegistry(host);
  const owner: RegisteredWideFrameOwner = {
    id: Symbol("inline-review-wide-frame-candidate"),
    root,
    setActive,
  };
  state.owners.push(owner);
  const releaseRootWatch = retainRootWatch(state, host, owner);
  reconcileWideFrameOwners(state);
  let live = true;
  return {
    id: owner.id as symbol,
    reconcile: () => reconcileWideFrameOwners(ownerRegistry(host)),
    release: () => {
      if (!live) return;
      live = false;
      releaseRootWatch();
      const current = ownerRegistry(host);
      const index = current.owners.findIndex((candidate) => candidate.id === owner.id);
      if (index >= 0) current.owners.splice(index, 1);
      if (current.activeOwnerId === owner.id) current.activeOwnerId = null;
      reconcileWideFrameOwners(current);
    },
  };
}
