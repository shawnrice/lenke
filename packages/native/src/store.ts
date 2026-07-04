import type { QueryParams, RustGraph, Row } from './graph.js';

/**
 * A framework-agnostic reactive store over a {@link RustGraph}, built for React's
 * `useSyncExternalStore` (and anything with the same `subscribe`/`getSnapshot`
 * contract). It is *not* React-coupled — the package has no React dependency.
 *
 * The hard requirement `useSyncExternalStore` imposes is that `getSnapshot()`
 * return a **referentially-stable** value — the same reference until the data
 * actually changes — or React re-renders forever. The wasm/native graph is
 * mutable state behind a handle, so we bridge it with the engine's O(1) mutation
 * `version`: `getSnapshot` re-runs its query only when the version moved, and
 * caches the result otherwise. With declared `deps`, it goes finer still — it
 * recomputes only when one of its dependency *epochs* (per label / edge-type /
 * property-key) changed, so an unrelated mutation doesn't recompute it.
 *
 * @example
 * ```ts
 * const store = createStore(graph);
 * const people = store.liveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
 * // in a component:
 * const rows = useSyncExternalStore(people.subscribe, people.getSnapshot);
 * // mutate (this notifies subscribers iff the graph actually changed):
 * store.mutate((g) => g.query("INSERT (:Person {name: 'zoe'})"));
 * ```
 */
export type LiveQuery<T = Row> = {
  /** Register a change callback; returns an unsubscribe function. */
  subscribe: (onChange: () => void) => () => void;
  /** Current result — a stable reference until a relevant mutation occurs. */
  getSnapshot: () => T[];
};

export type Store = {
  /** The underlying graph (read it directly for one-off queries). */
  readonly graph: RustGraph;
  /** The graph's current mutation version. */
  readonly version: number;
  /**
   * Run a mutating operation and notify subscribers **iff** it actually changed
   * the graph (decided by the version counter, so a read-only call is silent).
   */
  mutate: <T>(fn: (graph: RustGraph) => T) => T;
  /**
   * A `useSyncExternalStore`-ready live query. `deps` is **required** — declare
   * the dependency posture explicitly (React's array semantics, no silent
   * omission):
   * - `[...]` — recompute only when one of these label/property/edge-type
   *   epochs moves (`graph.epoch(token)`).
   * - `[]` — depends on nothing → computed once, never recomputed.
   * - `null` — depends on everything → recompute on every graph change.
   *
   * `params` are `$name` bindings for the query text — part of the standing
   * query's identity, bound safely at execute time (never spliced). Use
   * {@link inferDeps} if you want to derive `deps` from the query text rather
   * than hand-declare it.
   */
  liveQuery: (
    text: string,
    opts: { deps: readonly string[] | null; params?: QueryParams },
  ) => LiveQuery<Row>;
  /**
   * The Gremlin twin of {@link liveQuery}: a standing traversal whose result
   * values (arbitrary JSON, not rows) are recomputed under the same `deps`
   * gating. Gremlin has no engine param binding, so interpolate values with the
   * {@link gremlin} tag / {@link escapeGremlin} (safe literals). The traversal
   * must be a **read**; a mutating step in a live query would rewrite the graph
   * on every recompute.
   */
  liveGremlin: (text: string, opts: { deps: readonly string[] | null }) => LiveQuery<unknown>;
};

export const createStore = (graph: RustGraph): Store => {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const l of listeners) {
      l();
    }
  };

  // Shared epoch-gated caching for both liveQuery (rows) and liveGremlin
  // (values): `run` is the only difference. The gating is language-agnostic —
  // it keys off the graph version and the declared `deps` epochs, not the query.
  const makeLive = <T>(deps: readonly string[] | null, run: () => T[]): LiveQuery<T> => {
    // -1 is unreachable for a u64 version/epoch, so the first call always primes.
    let seenVersion = -1;
    let seenFingerprint = -1;
    let cached: T[] = [];

    return {
      subscribe: (onChange) => {
        listeners.add(onChange);

        return () => {
          listeners.delete(onChange);
        };
      },
      getSnapshot: () => {
        const v = graph.version;

        if (v === seenVersion) {
          return cached; // nothing mutated since last read → stable reference
        }

        seenVersion = v;
        // A mutation happened. `null` deps → gate on the global version
        // (recompute every change). `[]` → a constant fingerprint, so it never
        // recomputes after the first prime. Otherwise sum the declared epochs
        // and recompute only when one of them moved.
        let fingerprint: number;

        if (deps === null) {
          fingerprint = v;
        } else if (deps.length === 0) {
          fingerprint = 0;
        } else {
          fingerprint = deps.reduce((acc, d) => acc + graph.epoch(d), 0);
        }

        if (fingerprint === seenFingerprint) {
          return cached; // the mutation didn't touch our dependencies
        }

        seenFingerprint = fingerprint;
        cached = run();

        return cached;
      },
    };
  };

  return {
    graph,
    get version() {
      return graph.version;
    },
    mutate: (fn) => {
      const before = graph.version;
      const result = fn(graph);

      if (graph.version !== before) {
        notify();
      }

      return result;
    },
    liveQuery: (text, opts) => makeLive(opts.deps, () => graph.query(text, opts.params)),
    liveGremlin: (text, opts) => makeLive(opts.deps, () => graph.gremlin(text)),
  };
};

/**
 * Best-effort extraction of a query's dependency tokens — the `:Label` / `:TYPE`
 * names and `.key` property keys it references. **Over-grabbing is safe**
 * (causes an unnecessary recompute); under-grabbing risks a stale snapshot, so
 * prefer passing `deps` explicitly for correctness-critical live queries, and
 * use `null` deps (recompute-always) for whole-element returns like `RETURN n`.
 */
export const inferDeps = (text: string): string[] => {
  const tokens = new Set<string>();

  // :Label or :TYPE   and   [:TYPE]
  for (const m of text.matchAll(/:([A-Za-z_]\w*)/g)) {
    tokens.add(m[1]);
  }

  // .key property access
  for (const m of text.matchAll(/\.([A-Za-z_]\w*)/g)) {
    tokens.add(m[1]);
  }

  return [...tokens];
};
