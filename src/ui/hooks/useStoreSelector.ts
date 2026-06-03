/**
 * useStoreSelector — `useSyncExternalStore` wrapper that compares snapshots
 * with shallow array equality, so selectors returning ID arrays (which are
 * identity-unstable across store mutations) don't force re-renders when the
 * actual IDs are unchanged.
 *
 * This mirrors Zustand's `useShallow` discipline but works for any store
 * exposing `subscribe(listener) => unsubscribe`. The discipline is critical:
 * the store contract notes that `selectLaneIds`/`selectCardIds`
 * return fresh arrays on every call.
 */
import * as React from 'react';

type Store = { subscribe: (listener: () => void) => () => void };

function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Cheap structural compare for the small plain objects selectBoardMeta() /
 * inline-meta returns. Falls through to `Object.is` for primitives.
 *
 * A previous implementation cached only by `Object.is`, which
 * means selectors that build a fresh object literal on each call
 * (selectBoardMeta is the load-bearing offender — see store.ts:632) would
 * return a DIFFERENT reference per `getSnapshot()` invocation. React 18's
 * `useSyncExternalStore` warns "getSnapshot should be cached" in that
 * case, and in StrictMode it can cascade into a "Maximum update depth
 * exceeded" error. Comparing one level
 * of own-keys collapses these no-op snapshots back onto the cached
 * reference, breaking the render loop without changing what subscribers
 * actually see.
 *
 * A follow-up refinement: previously this helper
 * EXPLICITLY bailed on arrays (`if (Array.isArray) return false`) on the
 * theory that array selectors should go through `useStoreIdList`. But
 * `useStoreSelector` is also the path Card/Column/BoardRoot take for
 * Card-and-Lane object selectors, and those objects carry array-typed
 * fields (`meta.tags`, `subtasks`). Immer keeps untouched-card refs
 * stable AT THE CARD LEVEL, but during a gesture the per-render selector
 * call still triggers a fresh array literal on any wrapped `.map()` chain
 * upstream (e.g. when a downstream consumer derives a new array from the
 * card's tags). Folding the array-compare path into the structural check
 * makes the cache resilient to that pattern — equal arrays return the
 * cached reference, mismatched arrays bail to a normal re-render. The
 * dedicated `useStoreIdList` still owns the explicit ID-array contract;
 * this only widens what `useStoreSelector` will accept as "no-op
 * snapshot".
 */
function shallowStructuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  // Handle arrays via element-wise compare
  // instead of bailing. Without this, a selector that returns a Card
  // whose `meta.tags` array was reconstructed by a downstream `.map()`
  // (parser canonicalisation, defensive copies) would force a cache
  // miss + re-render every time the subscription fires — exactly the
  // "plain card crashes in a board with structural complexity" path.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    )) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribe to a slice of the store. Primitives compare via `Object.is`;
 * plain objects compare structurally (one level of own-keys) so selectors
 * returning fresh object literals with identical contents are treated as
 * stable — see `shallowStructuralEqual`'s docstring for the rationale.
 *
 * For ID arrays use `useStoreIdList` so element-wise equality applies.
 */
export function useStoreSelector<S extends Store, T>(
  store: S,
  selector: () => T,
): T {
  const lastRef = React.useRef<{ value: T; initialized: boolean }>({
    value: undefined as unknown as T,
    initialized: false,
  });

  const subscribe = React.useCallback(
    (cb: () => void) => store.subscribe(cb),
    [store],
  );

  const getSnapshot = React.useCallback(() => {
    const next = selector();
    if (!lastRef.current.initialized) {
      lastRef.current = { value: next, initialized: true };
      return next;
    }
    // First try strict equality (covers primitives and immer-stable
    // refs). Then fall through to structural compare for object literals
    // that selectors construct anew on each call.
    if (shallowStructuralEqual(lastRef.current.value, next)) {
      return lastRef.current.value;
    }
    lastRef.current.value = next;
    return next;
  }, [selector]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to an ID-array slice with shallow equality. Use this for
 * selectors returning `LaneId[]` / `CardId[]` / similar.
 */
export function useStoreIdList<S extends Store, T>(
  store: S,
  selector: () => readonly T[],
): readonly T[] {
  const lastRef = React.useRef<readonly T[]>([]);
  const initialized = React.useRef(false);

  const subscribe = React.useCallback(
    (cb: () => void) => store.subscribe(cb),
    [store],
  );

  const getSnapshot = React.useCallback(() => {
    const next = selector();
    if (!initialized.current) {
      initialized.current = true;
      lastRef.current = next;
      return next;
    }
    if (arraysShallowEqual(lastRef.current, next)) return lastRef.current;
    lastRef.current = next;
    return next;
  }, [selector]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
