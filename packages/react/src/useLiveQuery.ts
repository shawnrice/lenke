import { useMemo, useSyncExternalStore } from 'react';

import { type Row, useStore } from './StoreContext.js';

/**
 * Subscribe to a live GQL query against the wasm/native graph. Returns the
 * current `Row[]`, re-rendering only when a mutation actually changes the
 * result.
 *
 * This is the native connector's analogue of {@link useGraphSelector}: where the
 * TS-`Graph` hook runs a JS closure over a live object, here the "selector" is a
 * **query string** that crosses the FFI boundary. The gating (recompute only on
 * a version/epoch change) already lives inside the {@link Store}'s `liveQuery`,
 * so this hook is a thin `useSyncExternalStore` wrapper.
 *
 * Pass `deps` (label / edge-type / property-key names the query reads) for
 * **selective** invalidation — the query re-runs only when one of those tokens'
 * epochs moved. Omit `deps` (or pass `null`) for the always-correct coarse mode
 * (recompute on any mutation). Over-declaring `deps` is safe (an extra
 * recompute); under-declaring risks a stale result.
 *
 * Pass `params` to bind `$name` placeholders — bound safely at execute time,
 * never spliced into the text, so an id from the UI can't inject.
 *
 * @example
 *   const rows = useLiveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
 *   const backlinks = useLiveQuery(
 *     'MATCH (:Note {id: $id})<-[:LINKS_TO]-(n) RETURN n.title',
 *     { deps: ['Note', 'LINKS_TO'], params: { id: current } },
 *   );
 */
export const useLiveQuery = <R extends Row = Row>(
  text: string,
  opts?: { deps?: readonly string[] | null; params?: Record<string, unknown> },
): R[] => {
  const store = useStore();
  // Omitted OR `null` both mean coarse (recompute-always); the store's contract
  // is `deps: string[] | null`, so normalize `undefined` → `null` here. Passing
  // `undefined` straight through would throw (the store derefs `opts.deps`).
  const deps = opts?.deps ?? null;
  const params = opts?.params;

  // A `LiveQuery` carries its own cache, so it must be stable across renders —
  // recreating it every render would reset that cache and break the
  // referential-stability contract `useSyncExternalStore` depends on. Memoize on
  // the *content* of `deps`/`params` (not array/object identity), so an inline
  // `deps={['Person']}` / `params={{ id }}` doesn't churn a new query each
  // render. Tokens can't contain spaces, and params serialize stably.
  const depsKey = deps === null ? ' null' : deps.join(' ');
  const paramsKey = params ? JSON.stringify(params) : '';
  const live = useMemo(
    () => store.liveQuery<R>(text, { deps, params }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the *Key strings are the stable proxies
    [store, text, depsKey, paramsKey],
  );

  return useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
};
