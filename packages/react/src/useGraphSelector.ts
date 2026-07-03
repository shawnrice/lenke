import type { Graph } from '@lenke/core';
import { useRef, useSyncExternalStore } from 'react';

import { useGraphContext } from './GraphContext.js';
import { type CacheCell, nextSnapshot } from './snapshotGate.js';

type Equality<T> = (a: T, b: T) => boolean;

/**
 * Subscribe to a derived value from the graph.
 *
 * Recomputation is gated on the graph's O(1) change signals. By default it
 * tracks the global mutation `version`, so the selector re-runs at most once per
 * mutation (not once per render); if its result is `isEqual` to the previous
 * one, the cached reference is preserved so React short-circuits the re-render.
 *
 * Pass `deps` (label / edge-type / property-key names the selector reads) for
 * **selective** invalidation: the selector then re-runs only when one of those
 * tokens' epochs moved, so a mutation to an unrelated label/key doesn't even run
 * it. Omit `deps` for the always-correct coarse mode (use it for selectors that
 * read whole elements, e.g. `g => [...g.vertices]`). `deps` is not inferred —
 * under-declaring it risks a stale snapshot.
 */
export const useGraphSelector = <T>(
  selector: (graph: Graph) => T,
  isEqual: Equality<T> = Object.is,
  deps?: readonly string[],
): T => {
  const { graph } = useGraphContext();

  // The accepted cell (value + fingerprint) persists across renders; the gate
  // decides whether to reuse it or recompute. getSnapshot is recreated each
  // render (capturing the latest selector/deps), but the value it returns is
  // stable across calls while the relevant graph epochs are unchanged.
  const cache = useRef<CacheCell<T> | null>(null);

  const getSnapshot = (): T => {
    cache.current = nextSnapshot(cache.current, graph, selector, isEqual, deps);

    return cache.current.value;
  };

  return useSyncExternalStore((onChange) => graph.subscribe(onChange), getSnapshot, getSnapshot);
};
