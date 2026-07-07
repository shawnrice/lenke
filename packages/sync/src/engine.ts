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
 * **Loaders return writes, not graphs**: `SyncWrite[]` (GQL text + `$name`
 * bindings, or a Gremlin mutation traversal), applied in one `store.mutate`.
 * That keeps the loader an ordinary
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

import type { QueryParams, RustGraph, Store } from '@lenke/native';

import { createSyncHost, type SyncHost, type SyncHostOptions } from './host.js';

/** One replicable write: query text, its language, and (GQL only) `$name` bindings. */
export type SyncWrite = {
  /** Query text — GQL DML, or a Gremlin mutation traversal when `lang: 'gremlin'`. */
  text: string;
  /**
   * Language, default `'gql'`. `'gremlin'` executes `text` through the Gremlin
   * engine (mutation steps: `addV` / `addE` / `property` / `drop`). Gremlin has
   * no param binding — pre-escape values with the `gremlin` tag and leave
   * `params` unset.
   */
  lang?: 'gql' | 'gremlin';
  /** `$name` bindings (GQL only). */
  params?: QueryParams;
};

/** Apply one write to a graph: GQL via `query`, Gremlin via `gremlin`. */
const runWrite = (g: RustGraph, w: SyncWrite): void => {
  if (w.lang === 'gremlin') {
    g.gremlin(w.text);
  } else {
    g.query(w.text, w.params);
  }
};

export type CollectionState = 'empty' | 'loading' | 'complete' | 'error';

export type CollectionDefinition = {
  /** Labels / edge-types this scope covers — matched against subscription deps. */
  labels: readonly string[];
  /**
   * Param name(s) that scope this collection to one slice by VALUE. A keyed
   * collection tracks completeness and demand-fills per distinct bound value
   * (`cluster = 'prod-east'` vs `'prod-west'`), reading that value straight off
   * the subscription's `params` — no synthetic label, no side channel. A
   * subscription that omits a key param neither demand-fills nor counts against
   * this collection's completeness: value-scoped collections serve scoped
   * subscriptions. Omit `key` for a single whole-collection scope.
   */
  key?: string | readonly string[];
  /** Fetch the scope (its bound key values, if keyed) → writes that materialize it. */
  load: (scope: QueryParams) => Promise<SyncWrite[]>;
};

/**
 * A collection at one scope: a bare `name` for a whole collection, or
 * `{ name, scope }` (the key params' bound values) for one slice of a keyed one.
 */
export type CollectionScope = { name: string; scope?: QueryParams };

export type SyncEngineOptions = {
  store: Store;
  /** The app's demand-fill scopes, keyed by collection name. */
  collections?: Record<string, CollectionDefinition>;
  /**
   * Collections (or keyed-collection slices) the boot snapshot already covers —
   * their first load is skipped. A bare string names a whole collection;
   * `{ name, scope }` names one slice of a keyed one.
   */
  initiallyComplete?: readonly (string | CollectionScope)[];
  /**
   * Pending writes restored from a snapshot. Their effects are already IN the
   * snapshot's graph (they were applied optimistically before it was saved),
   * so they re-enqueue for upstream without re-applying locally.
   */
  initialWrites?: readonly SyncWrite[];
  /** Where local writes replicate to. Omit for a local-only engine. */
  upstream?: {
    push: (write: SyncWrite) => Promise<void>;
  };
  /**
   * Write-back retry policy: `attempts` tries, `baseMs * 2^n` between them,
   * capped at `maxMs` (default 30s) so long outages back off politely instead
   * of exploding the wait.
   */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number };
  /** A write exhausted its retries and was dropped from the queue. */
  onWriteError?: (write: SyncWrite, error: unknown) => void;
  /** A collection load failed (state → 'error'; the next demand re-triggers). */
  onLoadError?: (collection: string, error: unknown) => void;
};

export type SyncEngine = {
  readonly store: Store;
  /**
   * Completeness of one collection (for status surfaces and tests). Pass
   * `scope` (the key params' values) for a keyed collection; `undefined` for an
   * unknown collection or a keyed one addressed without its scope.
   */
  collectionState: (name: string, scope?: QueryParams) => CollectionState | undefined;
  /** Are the collections these deps + params imply all complete? (`null` deps → yes.) */
  isComplete: (deps: readonly string[] | null, params?: QueryParams) => boolean;
  /** Fire loaders for every intersecting, unloaded (collection, scope). */
  ensure: (deps: readonly string[] | null, params?: QueryParams) => void;
  /**
   * Apply a local write optimistically and queue it for upstream. GQL by default
   * (values ride `params`); pass `lang: 'gremlin'` to run `text` as a Gremlin
   * mutation traversal (no params — pre-escape values with the `gremlin` tag).
   */
  mutate: (text: string, params?: QueryParams, lang?: 'gql' | 'gremlin') => void;
  /** Apply server-pushed writes locally (never re-replicated upstream). */
  ingest: (writes: readonly SyncWrite[]) => void;
  /** Queued-or-in-flight write count (feeds the status message). */
  pendingWrites: () => number;
  /** The queue's current contents — persist these in the snapshot. */
  queuedWrites: () => readonly SyncWrite[];
  /** Loads and queue-length changes re-notify here (hosts refresh on it). */
  onChange: (cb: () => void) => () => void;
  /** A host for one client connection, wired into this loop. */
  createHost: (options: Pick<SyncHostOptions, 'send'>) => SyncHost;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The param name(s) that scope a collection — normalized from `key`. */
const keyNamesOf = (def: CollectionDefinition): readonly string[] => {
  if (def.key === undefined) {
    return [];
  }

  return typeof def.key === 'string' ? [def.key] : def.key;
};

export const createSyncEngine = (options: SyncEngineOptions): SyncEngine => {
  const { store, upstream } = options;
  const collections = options.collections ?? {};
  const attempts = options.retry?.attempts ?? 5;
  const baseMs = options.retry?.baseMs ?? 250;
  const maxMs = options.retry?.maxMs ?? 30_000;

  // State is keyed per (collection, scope value): an unkeyed collection uses its
  // bare name; a keyed one appends its bound key values. Absent → 'empty', so
  // only 'complete' slices need seeding from the snapshot.
  const states = new Map<string, CollectionState>();

  // Resolve a collection + a subscription's params to its state key and scope.
  // null = a keyed collection whose key params the subscription didn't supply:
  // it neither demand-fills nor gates completeness for that subscription.
  const scopeOf = (
    name: string,
    def: CollectionDefinition,
    params?: QueryParams,
  ): { stateKey: string; scope: QueryParams } | null => {
    const keys = keyNamesOf(def);

    if (keys.length === 0) {
      return { stateKey: name, scope: {} };
    }

    const scope: Record<string, unknown> = {};

    for (const k of keys) {
      if (params == null || !(k in params)) {
        return null;
      }

      scope[k] = (params as Record<string, unknown>)[k];
    }

    // Keys are in the definition's fixed order, so this tag is deterministic.
    const tag = keys.map((k) => JSON.stringify(scope[k])).join('\x01');

    return { stateKey: `${name}\u0000${tag}`, scope: scope as QueryParams };
  };

  const stateOf = (stateKey: string): CollectionState => states.get(stateKey) ?? 'empty';

  for (const entry of options.initiallyComplete ?? []) {
    const { name, scope } = typeof entry === 'string' ? { name: entry, scope: undefined } : entry;
    const def = collections[name];
    const resolved = def && scopeOf(name, def, scope);

    if (resolved) {
      states.set(resolved.stateKey, 'complete');
    }
  }

  const changeListeners = new Set<() => void>();
  const notifyChange = (): void => {
    for (const l of changeListeners) {
      l();
    }
  };

  // ---- demand-fill -----------------------------------------------------

  type Match = { name: string; stateKey: string; scope: QueryParams };

  // Collections whose labels a subscription reads, each resolved to the scope
  // its params select. A keyed collection missing its key params drops out.
  // `null`/empty deps declare no label to route on → no collection to fill.
  const matchesFor = (deps: readonly string[] | null, params?: QueryParams): Match[] => {
    const out: Match[] = [];

    if (!deps || deps.length === 0) {
      return out;
    }

    for (const [name, def] of Object.entries(collections)) {
      if (!def.labels.some((l) => deps.includes(l))) {
        continue;
      }

      const resolved = scopeOf(name, def, params);

      if (resolved) {
        out.push({ name, ...resolved });
      }
    }

    return out;
  };

  const isComplete = (deps: readonly string[] | null, params?: QueryParams): boolean =>
    matchesFor(deps, params).every((m) => stateOf(m.stateKey) === 'complete');

  const load = async (match: Match): Promise<void> => {
    states.set(match.stateKey, 'loading');

    try {
      const writes = await collections[match.name].load(match.scope);

      // One mutate for the whole scope: subscribers hear a single version
      // bump, and epochs route it to exactly the affected live queries.
      store.mutate((g) => {
        for (const w of writes) {
          runWrite(g, w);
        }
      });
      states.set(match.stateKey, 'complete');
    } catch (e) {
      // The next demand re-triggers the load; completeness stays honest.
      states.set(match.stateKey, 'error');
      options.onLoadError?.(match.name, e);
    }

    // Even an empty or failed load changes what `complete` means for standing
    // queries — hosts must re-push. (A non-empty load also bumped the version,
    // but the flip itself must be observable either way.)
    notifyChange();
  };

  const ensure = (deps: readonly string[] | null, params?: QueryParams): void => {
    for (const match of matchesFor(deps, params)) {
      const state = stateOf(match.stateKey);

      if (state === 'empty' || state === 'error') {
        void load(match);
      }
    }
  };

  // ---- write-back ------------------------------------------------------

  // Restored writes re-enqueue as-is: their effects are already in the
  // snapshot's graph, they just never reached upstream.
  const queue: SyncWrite[] = [...(options.initialWrites ?? [])];
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

  const mutate = (text: string, params?: QueryParams, lang?: 'gql' | 'gremlin'): void => {
    const before = store.version;
    let write: SyncWrite;

    if (lang === 'gremlin') {
      write = { text, lang };
    } else if (params) {
      write = { text, params };
    } else {
      write = { text };
    }

    store.mutate((g) => runWrite(g, write)); // optimistic: local readers see it now

    // Version-gated enqueue: a write that changed nothing replicates nothing.
    if (upstream && store.version !== before) {
      queue.push(write);
      notifyChange();
      void pump();
    }
  };

  const ingest = (writes: readonly SyncWrite[]): void => {
    store.mutate((g) => {
      for (const w of writes) {
        runWrite(g, w);
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
    collectionState: (name, scope) => {
      const def = collections[name];
      const resolved = def && scopeOf(name, def, scope);

      return resolved ? stateOf(resolved.stateKey) : undefined;
    },
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
