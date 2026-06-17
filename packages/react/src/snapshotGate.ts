/**
 * The pure decision logic behind `useGraphSelector`, factored out so it can be
 * unit-tested without a React renderer.
 *
 * `useSyncExternalStore` requires `getSnapshot` to return a referentially-stable
 * value until the data actually changes. We gate recomputation on the graph's
 * O(1) change signals: the global `version` (coarse) or, when `deps` are given,
 * the sum of those tokens' `epoch`s (selective — recompute only when a label /
 * edge-type / property-key the selector depends on changed). If the fingerprint
 * is unchanged we return the cached cell *without even running the selector*;
 * that's the performance win over re-running + `isEqual` on every mutation.
 */

/** The minimal slice of the graph the gate reads — satisfied by `@pl-graph/core` `Graph`. */
export type GraphLike = {
  epoch: (name: string) => number;
};

export type CacheCell<T> = { value: T; fingerprint: number };

/**
 * Given the previous cache cell (or `null`), return the next one.
 *
 * - **With `deps`** (selective): fingerprint = sum of the deps' epochs. The
 *   selector is skipped entirely when no dependency moved — the performance win.
 * - **Without `deps`** (coarse, the safe default): the selector always runs
 *   (it's only invoked on a mutation notify anyway), and `isEqual` preserves the
 *   reference when the value is unchanged. Coarse mode reads nothing version-y,
 *   so it can't go stale.
 *
 * Either way, when a recompute yields an `isEqual` value the previous reference
 * is kept, so React short-circuits the re-render.
 */
export const nextSnapshot = <T, G extends GraphLike>(
  cache: CacheCell<T> | null,
  graph: G,
  selector: (graph: G) => T,
  isEqual: (a: T, b: T) => boolean,
  deps?: readonly string[],
): CacheCell<T> => {
  if (deps?.length) {
    const fingerprint = deps.reduce((acc, token) => acc + graph.epoch(token), 0);

    if (cache?.fingerprint === fingerprint) {
      return cache; // no dependency moved — skip the selector entirely
    }

    const value = selector(graph);

    return cache && isEqual(cache.value, value)
      ? { value: cache.value, fingerprint }
      : { value, fingerprint };
  }

  // Coarse mode: run the selector and stabilize on value equality.
  const value = selector(graph);

  return cache && isEqual(cache.value, value) ? cache : { value, fingerprint: 0 };
};
