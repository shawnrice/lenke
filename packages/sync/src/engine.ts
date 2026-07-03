/**
 * The sync loop — the worker-side machinery between the local store and the
 * network. One producer and one mechanism per arrow of the design's full loop:
 *
 *   frontend declares interest      → host `onSubscribe` fires `ensure`
 *   worker fills what that implies  → collection loaders write into the graph
 *   server pushes what changed      → `ingest` applies writes; epochs route
 *   local writes go back up         → `mutate` applies optimistically + queues
 *
 * **Collections** are the completeness unit: an app-defined scope
 * (`"people"`, `"cycle-2026"`) declaring which labels it covers and how to
 * load itself. Demand-fill needs no protocol addition — a subscription's
 * dependency tokens already name the labels it reads, so `ensure(deps)` fires
 * the loaders for every intersecting collection that isn't loaded. Deps no
 * collection covers are local-only data, complete by definition.
 *
 * **Loaders return writes, not graphs**: `GqlWrite[]` (GQL text + `$name`
 * bindings), applied in one `store.mutate`. That keeps the loader an ordinary
 * async function next to the data (fetch, decode, map), keeps values on the
 * params path (never spliced), and lets epochs route the resulting pushes
 * with no knowledge of subscriptions.
 *
 * **Write-back** is optimistic and FIFO: `mutate` applies locally at once
 * (subscribers see it immediately), then queues the write for
 * `upstream.push`, one in flight at a time, with exponential backoff. A write
 * that exhausts its retries is dropped and reported via `onWriteError` —
 * rollback-and-correct arrives with server cursors (a later step), not v1.
 *
 * The loop is persistence-agnostic: hydrate by building the store from a
 * snapshot before constructing the engine, and pass `initiallyComplete` for
 * the collections that snapshot already covers.
 */

import type { QueryParams, Store } from '@lenke/native';

import { createSyncHost, type SyncHost, type SyncHostOptions } from './host.js';

/** One replicable write: GQL text plus its `$name` bindings. */
export type GqlWrite = {
  gql: string;
  params?: QueryParams;
};

export type CollectionState = 'empty' | 'loading' | 'complete' | 'error';

export type CollectionDefinition = {
  /** Labels / edge-types this scope covers — matched against subscription deps. */
  labels: readonly string[];
  /** Fetch the scope and return the writes that materialize it locally. */
  load: () => Promise<GqlWrite[]>;
};

export type SyncEngineOptions = {
  store: Store;
  /** The app's demand-fill scopes, keyed by collection name. */
  collections?: Record<string, CollectionDefinition>;
  /** Collections the boot snapshot already covers (skip their first load). */
  initiallyComplete?: readonly string[];
  /**
   * Pending writes restored from a snapshot. Their effects are already IN the
   * snapshot's graph (they were applied optimistically before it was saved),
   * so they re-enqueue for upstream without re-applying locally.
   */
  initialWrites?: readonly GqlWrite[];
  /** Where local writes replicate to. Omit for a local-only engine. */
  upstream?: {
    push: (write: GqlWrite) => Promise<void>;
  };
  /**
   * Write-back retry policy: `attempts` tries, `baseMs * 2^n` between them,
   * capped at `maxMs` (default 30s) so long outages back off politely instead
   * of exploding the wait.
   */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number };
  /** A write exhausted its retries and was dropped from the queue. */
  onWriteError?: (write: GqlWrite, error: unknown) => void;
  /** A collection load failed (state → 'error'; the next demand re-triggers). */
  onLoadError?: (collection: string, error: unknown) => void;
};

export type SyncEngine = {
  readonly store: Store;
  /** Per-collection completeness (for status surfaces and tests). */
  collectionState: (name: string) => CollectionState | undefined;
  /** Are the collections these deps imply all complete? */
  isComplete: (deps: readonly string[]) => boolean;
  /** Fire loaders for every intersecting, unloaded collection. */
  ensure: (deps: readonly string[]) => void;
  /** Apply a local write optimistically and queue it for upstream. */
  mutate: (gql: string, params?: QueryParams) => void;
  /** Apply server-pushed writes locally (never re-replicated upstream). */
  ingest: (writes: readonly GqlWrite[]) => void;
  /** Queued-or-in-flight write count (feeds the status message). */
  pendingWrites: () => number;
  /** The queue's current contents — persist these in the snapshot. */
  queuedWrites: () => readonly GqlWrite[];
  /** Loads and queue-length changes re-notify here (hosts refresh on it). */
  onChange: (cb: () => void) => () => void;
  /** A host for one client connection, wired into this loop. */
  createHost: (options: Pick<SyncHostOptions, 'send'>) => SyncHost;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createSyncEngine = (options: SyncEngineOptions): SyncEngine => {
  const { store, upstream } = options;
  const collections = options.collections ?? {};
  const attempts = options.retry?.attempts ?? 5;
  const baseMs = options.retry?.baseMs ?? 250;
  const maxMs = options.retry?.maxMs ?? 30_000;

  const states = new Map<string, CollectionState>();

  for (const name of Object.keys(collections)) {
    states.set(name, options.initiallyComplete?.includes(name) ? 'complete' : 'empty');
  }

  const changeListeners = new Set<() => void>();
  const notifyChange = (): void => {
    for (const l of changeListeners) {
      l();
    }
  };

  // ---- demand-fill -----------------------------------------------------

  const collectionsFor = (deps: readonly string[]): string[] =>
    Object.entries(collections)
      .filter(([, def]) => def.labels.some((l) => deps.includes(l)))
      .map(([name]) => name);

  const isComplete = (deps: readonly string[]): boolean =>
    collectionsFor(deps).every((name) => states.get(name) === 'complete');

  const load = async (name: string): Promise<void> => {
    states.set(name, 'loading');

    try {
      const writes = await collections[name].load();

      // One mutate for the whole scope: subscribers hear a single version
      // bump, and epochs route it to exactly the affected live queries.
      store.mutate((g) => {
        for (const w of writes) {
          g.query(w.gql, w.params);
        }
      });
      states.set(name, 'complete');
    } catch (e) {
      // The next demand re-triggers the load; completeness stays honest.
      states.set(name, 'error');
      options.onLoadError?.(name, e);
    }

    // Even an empty or failed load changes what `complete` means for standing
    // queries — hosts must re-push. (A non-empty load also bumped the version,
    // but the flip itself must be observable either way.)
    notifyChange();
  };

  const ensure = (deps: readonly string[]): void => {
    for (const name of collectionsFor(deps)) {
      const state = states.get(name);

      if (state === 'empty' || state === 'error') {
        void load(name);
      }
    }
  };

  // ---- write-back ------------------------------------------------------

  // Restored writes re-enqueue as-is: their effects are already in the
  // snapshot's graph, they just never reached upstream.
  const queue: GqlWrite[] = [...(options.initialWrites ?? [])];
  let pumping = false;

  const pump = async (): Promise<void> => {
    if (pumping) {
      return;
    }

    pumping = true;

    while (queue.length > 0) {
      const [write] = queue; // FIFO; stays queued (and counted) until settled
      let sent = false;

      for (let attempt = 0; attempt < attempts && !sent; attempt += 1) {
        try {
          // upstream is present by construction: writes only enqueue when it is.
          await upstream!.push(write);
          sent = true;
        } catch (e) {
          if (attempt + 1 >= attempts) {
            // Terminal: drop and report. Roll-back-and-correct needs server
            // cursors (a later step) — silently retrying forever would just
            // hide a dead upstream.
            options.onWriteError?.(write, e);
          } else {
            await sleep(Math.min(maxMs, baseMs * 2 ** attempt));
          }
        }
      }

      queue.shift();
      notifyChange(); // pendingWrites moved
    }

    pumping = false;
  };

  const mutate = (gql: string, params?: QueryParams): void => {
    const before = store.version;
    store.mutate((g) => g.query(gql, params)); // optimistic: local readers see it now

    // Version-gated enqueue: a write that changed nothing replicates nothing.
    if (upstream && store.version !== before) {
      queue.push(params ? { gql, params } : { gql });
      notifyChange();
      void pump();
    }
  };

  const ingest = (writes: readonly GqlWrite[]): void => {
    store.mutate((g) => {
      for (const w of writes) {
        g.query(w.gql, w.params);
      }
    });
  };

  // ---- assembly --------------------------------------------------------

  // Flush aggressively: restored writes start replicating immediately, not on
  // the next local mutation.
  if (upstream && queue.length > 0) {
    void pump();
  }

  return {
    store,
    collectionState: (name) => states.get(name),
    isComplete,
    ensure,
    mutate,
    ingest,
    pendingWrites: () => queue.length,
    queuedWrites: () => [...queue],
    onChange: (cb) => {
      changeListeners.add(cb);

      return () => {
        changeListeners.delete(cb);
      };
    },
    createHost: ({ send }) => {
      const host = createSyncHost(store, {
        send,
        applyMutation: mutate,
        isComplete,
        onSubscribe: ensure,
        pendingWrites: () => queue.length,
      });

      // Completeness flips and queue movement must reach standing queries and
      // the status surface even when the graph version never moved.
      const refresh = (): void => {
        host.refresh();
        host.sendStatus();
      };
      changeListeners.add(refresh);

      return {
        ...host,
        close: () => {
          changeListeners.delete(refresh);
          host.close();
        },
      };
    },
  };
};
