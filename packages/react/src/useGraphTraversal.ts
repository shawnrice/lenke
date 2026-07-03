import { bind, type GremlinBound } from '@lenke/gremlin';
import { arraysAreEqual } from '@lenke/utils';

import { useGraphSelector } from './useGraphSelector.js';

type Equality<T> = (a: T, b: T) => boolean;

const defaultIsEqual = <T>(a: T, b: T): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return arraysAreEqual(a, b);
  }

  return Object.is(a, b);
};

/**
 * Run a gremlin query against the current graph snapshot, re-running on
 * each graph change. The query receives a `GremlinBound` facade closed
 * over the latest snapshot — call `g.toArray(plan)`, `g.toSet(plan)`, or
 * iterate the lazy `g.query(plan)` inside the callback.
 *
 * Results are stabilized by `isEqual` (default: elementwise equality for
 * arrays, otherwise `Object.is`) so React can short-circuit re-renders
 * when the materialized value didn't change even though the snapshot
 * reference did.
 *
 * @example
 *   const names = useGraphTraversal((g) =>
 *     g.toArray(traversal(V(), values('name'))) as string[],
 *   );
 */
export const useGraphTraversal = <T>(
  query: (g: GremlinBound) => T,
  isEqual: Equality<T> = defaultIsEqual,
): T => useGraphSelector((graph) => query(bind(graph.snapshot())), isEqual);
