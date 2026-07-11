import * as React from 'react';

import type { Row } from './StoreContext.js';

/**
 * The `{ rows, complete, error }` snapshot a standing sync-client query pushes —
 * the honest loading model: `complete` is `false` until the host first answers,
 * so a UI renders skeletons, not empty-looking lies. Mirrors `@lenke/sync`'s
 * `ClientSnapshot` (declared structurally here so this connector doesn't
 * hard-depend on `@lenke/sync`).
 */
export type ClientSnapshot = {
  /** Last pushed rows (a stable `[]` before the first push; empty for a Gremlin query). */
  rows: Row[];
  /** A `lang: 'gremlin'` subscription's result values; `undefined` for a GQL query. */
  values?: unknown[];
  /** `false` until the host has answered (and on error). */
  complete: boolean;
  /** Graph version at snapshot time, when known. */
  version?: number;
  /** Set when the host closed the subscription with an error. */
  error?: { code: string; message: string };
};

/** A `useSyncExternalStore`-ready handle over one standing sync-client query. */
export type ClientLiveQueryHandle = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => ClientSnapshot;
};

/** Options for a standing sync-client query (mirrors `@lenke/sync`'s `liveQuery`). */
export type ClientLiveQueryOptions = {
  /**
   * Dependency posture — **required**: a token array (epoch-gated), `[]` (never
   * recomputes), or `null` (recompute on every change). Derive it with
   * `inferDeps(query)` from `@lenke/sync` if you don't want to hand-declare.
   */
  deps: readonly string[] | null;
  params?: Record<string, unknown>;
  /** Row-identity column → keyed diff pushes instead of full rows. */
  key?: string;
  /** `'gremlin'` makes this a standing traversal — results ride `values`, not `rows`. */
  lang?: 'gql' | 'gremlin';
  /** Windowed read for grids (keyless GQL only). */
  window?: { offset: number; limit: number };
};

/**
 * The minimal sync-client shape the wire connector drives — satisfied by
 * `@lenke/sync`'s `createSyncClient(...)` / `createReconnectingClient(...)`.
 * Declared *structurally* (like {@link ReactiveStore}) so `@lenke/react` doesn't
 * hard-depend on `@lenke/sync`: any value exposing `liveQuery` works.
 */
export type SyncClientLike = {
  liveQuery: (query: string, opts: ClientLiveQueryOptions) => ClientLiveQueryHandle;
};

/**
 * React context for the **sync-client** connector — the port/WebSocket path
 * (`@lenke/sync`), a third connector alongside {@link GraphContext} (in-process
 * `Graph`) and {@link StoreContext} (local native `Store`). Unlike the local
 * store, this client's snapshot carries completeness + demand-fill + offline
 * behavior, so its hook returns the whole `{ rows, complete, error }` snapshot.
 *
 * Defaults to `null`; {@link useSyncClient} throws a clear error when a hook is
 * used outside a {@link SyncClientProvider}.
 */
export const SyncClientContext = React.createContext<SyncClientLike | null>(null);
SyncClientContext.displayName = 'SyncClientContext';

/**
 * Read the {@link SyncClientLike} from context. Throws if there is no
 * {@link SyncClientProvider} ancestor — a missing provider is a wiring error, so
 * it fails loudly with an actionable message.
 */
export const useSyncClient = (): SyncClientLike => {
  const client = React.useContext(SyncClientContext);

  if (!client) {
    throw new Error(
      'useSyncClient (and useClientLiveQuery) must be used within a <SyncClientProvider>. ' +
        'Create a client with `createSyncClient(...)` / `createReconnectingClient(...)` from @lenke/sync ' +
        'and pass it as <SyncClientProvider client={client}>.',
    );
  }

  return client;
};
