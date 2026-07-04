/**
 * The client half of the v1 protocol — `liveQuery`'s port-crossing shadow.
 *
 * Where {@link createSyncHost} sits next to the store, the client sits next to
 * the UI and speaks the same tagged messages over the same transport seam: you
 * hand it a `send` function and feed inbound messages to `receive`.
 *
 * ```ts
 * // Browser ↔ Worker:
 * const client = createSyncClient({ send: (m) => worker.postMessage(m) });
 * worker.onmessage = (e) => client.receive(e.data);
 *
 * // Browser/Node ↔ server WebSocket:
 * const client = createSyncClient({ send: (m) => ws.send(JSON.stringify(m)) });
 * ws.onmessage = (e) => client.receive(JSON.parse(String(e.data)));
 * ```
 *
 * What it manages (the design doc's client registry):
 * - **Dedupe by query signature** — N local consumers of the same
 *   `(query, params, deps)` share ONE wire subscription.
 * - **Refcounted unsubscribe** — the wire subscription is torn down when the
 *   last local subscriber leaves.
 * - **Referentially-stable snapshots** — `getSnapshot()` returns the same
 *   object until a push replaces it, so `useSyncExternalStore(h.subscribe,
 *   h.getSnapshot)` plugs in directly (no React dependency here, same as
 *   `@lenke/native`'s store).
 * - **Honest loading state** — a snapshot is `{ rows, complete, error? }`;
 *   before the first push `complete` is `false`, so a UI can render skeletons
 *   instead of lying with an empty result.
 * - **Promise-shaped one-shots** — `query()` resolves rows, `mutate()`
 *   resolves on `ack ok` and rejects with the coded error otherwise. The UI
 *   effect of a mutation arrives via subscription pushes, exactly as if
 *   another client had written.
 *
 * Reconnect *policy* is deliberately NOT here: back-off, re-dial, and request
 * parking live in {@link createReconnectingClient}, which composes this client
 * and drives its one seam — {@link SyncClient.replay} re-emits every active
 * subscription and unanswered one-shot over a fresh transport. Resumable
 * subscriptions (server-side cursor catch-up) remain a later protocol
 * extension; replay re-runs standing queries from scratch, which the snapshot
 * model makes correct (the host just re-answers current rows).
 */

import { ErrorCode, LenkeError } from '@lenke/errors';
import type { QueryParams, Row } from '@lenke/native';

import { isHostMessage, type ClientMessage, type RowsMessage, type WireError } from './protocol.js';

/** What a standing query currently knows. Stable reference between pushes. */
export type ClientSnapshot = {
  /** Last pushed rows (a stable `[]` before the first push). Empty for a Gremlin query. */
  rows: Row[];
  /** A `lang: 'gremlin'` subscription's result values; `undefined` for a GQL query. */
  values?: unknown[];
  /** False until the host has answered (and on error) — render skeletons, not lies. */
  complete: boolean;
  /** Graph version at snapshot time, when known. */
  version?: number;
  /** Set when the host closed the subscription with an error. */
  error?: WireError;
};

/** A `useSyncExternalStore`-ready handle over one standing query. */
export type ClientLiveQuery = {
  /** Register a change callback; returns an unsubscribe fn (refcounted). */
  subscribe: (onChange: () => void) => () => void;
  /** Current snapshot — the same reference until a push replaces it. */
  getSnapshot: () => ClientSnapshot;
};

export type SyncClient = {
  /** Feed one inbound (already-parsed) host message. Unknown tags are ignored. */
  receive: (msg: unknown) => void;
  /**
   * A standing query. Consumers with the same `(query, params, deps)` share
   * one wire subscription; the wire teardown happens when the last local
   * subscriber unsubscribes.
   */
  liveQuery: (
    query: string,
    opts: {
      /**
       * Dependency posture — **required**: token array (epoch-gated), `[]`
       * (never recomputes), or `null` (recompute on every change). No inference.
       */
      deps: readonly string[] | null;
      params?: QueryParams;
      /** Row-identity column → keyed diff pushes (patch/remove) instead of full rows. */
      key?: string;
      /**
       * `'gremlin'` makes this a standing Gremlin traversal — the snapshot's
       * `values` (not `rows`) carry the result. No param binding; `key` ignored.
       */
      lang?: 'gql' | 'gremlin';
    },
  ) => ClientLiveQuery;
  /** One-shot GQL query → rows. */
  query: (query: string, params?: QueryParams) => Promise<Row[]>;
  /**
   * One-shot Gremlin traversal → its JSON result values. Gremlin has no
   * parameter binding (the text runs as-is), so never build a traversal from
   * untrusted input — reach for {@link query} with `params` when values come
   * from the user.
   */
  gremlin: (traversal: string) => Promise<unknown[]>;
  /** Apply a mutation; resolves on `ack ok`, rejects with the coded error. */
  mutate: (gql: string, params?: QueryParams) => Promise<void>;
  /** The host's last `status` message, if any. */
  getStatus: () => { connected: boolean; pendingWrites: number } | null;
  /**
   * Subscribe to host `status` pushes (connectivity, pending-write count);
   * returns an unsubscribe fn. Pairs with {@link getStatus} for a poll-free
   * `useSyncExternalStore(onStatus, getStatus)` — the snapshot reference is
   * stable between pushes.
   */
  onStatus: (cb: () => void) => () => void;
  /** Live wire-subscription count — for tests and debugging. */
  subscriptionCount: () => number;
  /**
   * Re-emit every active subscription and every unanswered one-shot over the
   * current transport. A reconnect manager calls this once a fresh connection
   * is open: subscribes are idempotent (the host replaces by `sub` id), reads
   * re-run harmlessly, and writes replay at-least-once (host/engine dedupe is
   * the deferred protocol concern). Pending promises are untouched — they
   * settle when the replayed request is answered.
   */
  replay: () => void;
  /** Tear down every subscription and reject every pending request. */
  close: () => void;
};

export type SyncClientOptions = {
  /** Deliver one message to the host. */
  send: (msg: ClientMessage) => void;
};

const wireToError = (e: WireError): LenkeError =>
  // Wire codes are the shared ErrorCode vocabulary; the cast keeps the
  // ecosystem's one error type without re-validating strings at this layer.
  new LenkeError(`lenke: ${e.message}`, { code: e.code as ErrorCode });

/** Stable JSON for the dedupe key: object keys sorted, arrays kept in order. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
};

const EMPTY_ROWS: Row[] = [];
const INITIAL: ClientSnapshot = { rows: EMPTY_ROWS, complete: false };

/** Canonical, collision-free string for a key column's value (matches the host). */
const keyOf = (value: unknown): string => JSON.stringify(value) ?? 'null';

type Entry = {
  /** Wire sub id — reassigned when a torn-down handle is revived. */
  sub: string;
  /** The subscribe payload, retained so {@link SyncClient.replay} can re-emit it. */
  query: string;
  params?: QueryParams;
  deps: readonly string[] | null;
  /** Row-identity column, if this subscription requested keyed diffs. */
  key?: string;
  /** `'gremlin'` → snapshots carry `values`, applied whole (no keyed diffs). */
  lang?: 'gql' | 'gremlin';
  /** Current rows by canonical key — the base each keyed diff is applied onto. */
  rowsByKey?: Map<string, Row>;
  snapshot: ClientSnapshot;
  listeners: Set<() => void>;
  handle: ClientLiveQuery;
};

type Pending = {
  resolve: (value: never) => void;
  reject: (reason: LenkeError) => void;
  kind: 'query' | 'gremlin' | 'mutate';
  /** The exact message sent, retained for replay across a reconnect. */
  msg: ClientMessage;
};

/** Replace an entry's snapshot and wake its subscribers. */
const settle = (entry: Entry, snapshot: ClientSnapshot): void => {
  entry.snapshot = snapshot;

  for (const l of entry.listeners) {
    l();
  }
};

export const createSyncClient = (options: SyncClientOptions): SyncClient => {
  const { send } = options;

  const entries = new Map<string, Entry>(); // signature → entry
  const bySub = new Map<string, Entry>(); // wire sub id → entry
  const pending = new Map<string, Pending>(); // req id → resolver
  let nextId = 0;
  let status: { connected: boolean; pendingWrites: number } | null = null;
  const statusListeners = new Set<() => void>();

  const liveQuery = (
    query: string,
    opts: {
      deps: readonly string[] | null;
      params?: QueryParams;
      key?: string;
      lang?: 'gql' | 'gremlin';
    },
  ): ClientLiveQuery => {
    const signature = canonical([
      query,
      opts.params ?? null,
      opts.deps,
      opts.key ?? null,
      opts.lang ?? null,
    ]);
    const existing = entries.get(signature);

    if (existing) {
      return existing.handle;
    }

    // The entry is the canonical, permanent handle for its signature; only its
    // WIRE subscription activates/deactivates ('' = inactive). This makes a
    // subscribe/unsubscribe/subscribe cycle (React StrictMode's mount dance)
    // revive cleanly — fresh wire sub, last snapshot kept as the
    // stale-but-honest starting point — with no duplicate-entry races.
    const entry: Entry = {
      sub: '',
      query,
      params: opts.params,
      deps: opts.deps,
      key: opts.key,
      lang: opts.lang,
      snapshot: INITIAL,
      listeners: new Set(),
      handle: {
        subscribe: (onChange) => {
          if (entry.sub === '') {
            activate();
          }

          entry.listeners.add(onChange);

          return () => {
            entry.listeners.delete(onChange);

            // Last local subscriber gone → tear down the wire subscription.
            // (Keep-alive grace is a later optimization, not v1.)
            if (entry.listeners.size === 0 && entry.sub !== '') {
              bySub.delete(entry.sub);
              send({ type: 'unsubscribe', sub: entry.sub });
              entry.sub = '';
            }
          };
        },
        getSnapshot: () => entry.snapshot,
      },
    };

    const activate = (): void => {
      entry.sub = `s${++nextId}`;
      bySub.set(entry.sub, entry);
      // A fresh wire sub means the host diffs from empty — reset our diff base so
      // the initial (full) diff rebuilds cleanly, while the last snapshot stays
      // on screen as the stale-but-honest starting point.
      entry.rowsByKey = undefined;
      send({
        type: 'subscribe',
        sub: entry.sub,
        query,
        deps: opts.deps,
        params: opts.params,
        key: opts.key,
        lang: opts.lang,
      });
    };

    entries.set(signature, entry);
    activate();

    return entry.handle;
  };

  const query = (text: string, params?: QueryParams): Promise<Row[]> =>
    new Promise<Row[]>((resolve, reject) => {
      const req = `q${++nextId}`;
      const msg: ClientMessage = { type: 'query', req, query: text, params };
      pending.set(req, { resolve: resolve as (v: never) => void, reject, kind: 'query', msg });
      send(msg);
    });

  const gremlin = (traversal: string): Promise<unknown[]> =>
    new Promise<unknown[]>((resolve, reject) => {
      const req = `g${++nextId}`;
      const msg: ClientMessage = { type: 'query', req, query: traversal, lang: 'gremlin' };
      pending.set(req, { resolve: resolve as (v: never) => void, reject, kind: 'gremlin', msg });
      send(msg);
    });

  const mutate = (gql: string, params?: QueryParams): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const req = `m${++nextId}`;
      const msg: ClientMessage = { type: 'mutate', req, gql, params };
      pending.set(req, { resolve: resolve as (v: never) => void, reject, kind: 'mutate', msg });
      send(msg);
    });

  // Apply a keyed diff (patch / remove / order) onto the entry's retained rows.
  // Unchanged rows keep their object identity (pulled from the map untouched),
  // so React list reconciliation skips them; only patched rows are new objects.
  const applyDiff = (entry: Entry, msg: RowsMessage): void => {
    const key = entry.key as string;
    const structural =
      (msg.patch?.length ?? 0) > 0 || (msg.remove?.length ?? 0) > 0 || msg.order !== undefined;

    // A complete/version-only push carries no ops: keep the same rows array so
    // the reference stays stable, and just refresh the flags.
    if (!structural) {
      settle(entry, {
        rows: entry.snapshot.rows,
        complete: msg.complete ?? true,
        version: msg.version,
      });

      return;
    }

    const map = entry.rowsByKey ?? new Map<string, Row>();
    entry.rowsByKey = map;

    for (const kv of msg.remove ?? []) {
      map.delete(keyOf(kv));
    }

    for (const p of msg.patch ?? []) {
      const ck = keyOf(p.key);
      const prev = map.get(ck);
      map.set(ck, prev ? { ...prev, ...p.set } : { ...p.set });
    }

    // With `order`, rebuild in the given key order; without it (a pure cell
    // change), keep the prior order and swap in the updated row objects.
    const rows =
      msg.order !== undefined
        ? msg.order.map((kv) => map.get(keyOf(kv))).filter((r): r is Row => r !== undefined)
        : entry.snapshot.rows.map((r) => map.get(keyOf(r[key])) ?? r);

    settle(entry, { rows, complete: msg.complete ?? true, version: msg.version });
  };

  const receive = (msg: unknown): void => {
    if (!isHostMessage(msg)) {
      return; // forward-compat: unknown tags fall through silently
    }

    switch (msg.type) {
      case 'rows': {
        const entry = bySub.get(msg.sub);

        if (!entry) {
          return; // a push that raced our unsubscribe — drop it
        }

        if (msg.error) {
          // The host closed this subscription: surface the error and go wire-
          // inactive. The handle stays canonical — a later subscribe retries.
          bySub.delete(msg.sub);
          entry.sub = '';
          entry.rowsByKey = undefined;
          settle(entry, { rows: EMPTY_ROWS, complete: false, error: msg.error });

          return;
        }

        if (entry.lang === 'gremlin') {
          // Gremlin pushes carry full `values` (no rows, no diffs) each time.
          settle(entry, {
            rows: EMPTY_ROWS,
            values: msg.values ?? [],
            complete: msg.complete ?? true,
            version: msg.version,
          });

          return;
        }

        if (entry.key !== undefined) {
          applyDiff(entry, msg); // keyed subscription → diff push

          return;
        }

        settle(entry, {
          rows: msg.rows ?? EMPTY_ROWS,
          complete: msg.complete ?? true,
          version: msg.version,
        });

        return;
      }
      case 'result': {
        const p = pending.get(msg.req);

        if (p) {
          pending.delete(msg.req);

          if (msg.error) {
            p.reject(wireToError(msg.error));
          } else if (p.kind === 'gremlin') {
            (p.resolve as (values: unknown[]) => void)(msg.values ?? []);
          } else {
            (p.resolve as (rows: Row[]) => void)(msg.rows ?? []);
          }
        }

        return;
      }
      case 'ack': {
        const p = pending.get(msg.req);

        if (p) {
          pending.delete(msg.req);

          if (msg.ok) {
            (p.resolve as () => void)();
          } else {
            // A not-ok ack without a report is itself a boundary fault.
            p.reject(
              msg.error
                ? wireToError(msg.error)
                : new LenkeError('lenke: mutate failed', { code: ErrorCode.Ffi }),
            );
          }
        }

        return;
      }
      case 'status': {
        // A fresh object only on an actual push, so getStatus() stays a stable
        // reference between messages (useSyncExternalStore-safe).
        status = { connected: msg.connected, pendingWrites: msg.pendingWrites };

        for (const l of statusListeners) {
          l();
        }

        return;
      }
      default:
    }
  };

  return {
    receive,
    liveQuery,
    query,
    gremlin,
    mutate,
    getStatus: () => status,
    onStatus: (cb) => {
      statusListeners.add(cb);

      return () => statusListeners.delete(cb);
    },
    subscriptionCount: () => bySub.size,
    replay: () => {
      // Re-subscribe every active standing query (inactive entries — no local
      // subscribers — stay silent), then re-send every unanswered one-shot. A
      // fresh transport means the host diffs from empty, so reset each keyed
      // diff base; the last snapshot stays on screen until the initial push.
      for (const entry of bySub.values()) {
        entry.rowsByKey = undefined;
        send({
          type: 'subscribe',
          sub: entry.sub,
          query: entry.query,
          params: entry.params,
          deps: entry.deps,
          key: entry.key,
          lang: entry.lang,
        });
      }

      for (const p of pending.values()) {
        send(p.msg);
      }
    },
    close: () => {
      for (const entry of bySub.values()) {
        send({ type: 'unsubscribe', sub: entry.sub });
        entry.sub = '';
      }

      entries.clear();
      bySub.clear();

      // The transport seam is gone from under these requests — a boundary fault.
      const closing = new LenkeError('lenke: client closed', { code: ErrorCode.Ffi });

      for (const p of pending.values()) {
        p.reject(closing);
      }

      pending.clear();
      statusListeners.clear();
    },
  };
};
