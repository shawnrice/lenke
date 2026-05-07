import { useRef, useSyncExternalStore } from 'react';

import type { Graph } from '@pl-graph/core';

import { useGraphContext } from './GraphContext.js';

type Equality<T> = (a: T, b: T) => boolean;

/**
 * Subscribe to a derived value from the graph. The selector runs on every
 * graph change; if its return value is `isEqual` to the previous one, the
 * cached reference is preserved so React's reconciler short-circuits the
 * re-render. Default equality is `Object.is` — supply a custom comparator
 * for selectors that build new objects/arrays each call.
 */
export const useGraphSelector = <T>(
  selector: (graph: Graph) => T,
  isEqual: Equality<T> = Object.is,
): T => {
  const { graph } = useGraphContext();

  // Memoize the latest accepted value so getSnapshot returns a stable
  // reference until the selector's output actually differs. Without this,
  // selectors that allocate (e.g. `g => [...g.vertices]`) would trigger
  // useSyncExternalStore's "snapshot is changing more often than expected"
  // path and re-render every commit.
  const cache = useRef<{ value: T } | null>(null);

  const getSnapshot = (): T => {
    const next = selector(graph);
    if (cache.current && isEqual(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { value: next };
    return next;
  };

  return useSyncExternalStore(
    (onChange) => graph.subscribe(onChange),
    getSnapshot,
    getSnapshot,
  );
};
