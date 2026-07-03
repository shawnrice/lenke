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
 * Reconnect/resume is deliberately NOT here (a v1 boundary): resumable
 * subscriptions are a protocol extension. On a new connection, create a new
 * client.
 */

import { ErrorCode, LenkeError } from '@lenke/errors';
import type { QueryParams, Row } from '@lenke/native';

import { isHostMessage, type ClientMessage, type WireError } from './protocol.js';

/** What a standing query currently knows. Stable reference between pushes. */
export type ClientSnapshot = {
  /** Last pushed rows (a stable `[]` before the first push). */
  rows: Row[];
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
    opts?: { params?: QueryParams; deps?: readonly string[] },
  ) => ClientLiveQuery;
  /** One-shot query → rows. */
  query: (query: string, params?: QueryParams) => Promise<Row[]>;
  /** Apply a mutation; resolves on `ack ok`, rejects with the coded error. */
  mutate: (gql: string, params?: QueryParams) => Promise<void>;
  /** The host's last `status` message, if any. */
  getStatus: () => { connected: boolean; pendingWrites: number } | null;
  /** Live wire-subscription count — for tests and debugging. */
  subscriptionCount: () => number;
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

type Entry = {
  /** Wire sub id — reassigned when a torn-down handle is revived. */
  sub: string;
  snapshot: ClientSnapshot;
  listeners: Set<() => void>;
  handle: ClientLiveQuery;
};

type Pending = {
  resolve: (value: never) => void;
  reject: (reason: LenkeError) => void;
  kind: 'query' | 'mutate';
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

  const liveQuery = (
    query: string,
    opts?: { params?: QueryParams; deps?: readonly string[] },
  ): ClientLiveQuery => {
    const signature = canonical([query, opts?.params ?? null, opts?.deps ?? null]);
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
      send({ type: 'subscribe', sub: entry.sub, query, params: opts?.params, deps: opts?.deps });
    };

    entries.set(signature, entry);
    activate();

    return entry.handle;
  };

  const query = (text: string, params?: QueryParams): Promise<Row[]> =>
    new Promise<Row[]>((resolve, reject) => {
      const req = `q${++nextId}`;
      pending.set(req, { resolve: resolve as (v: never) => void, reject, kind: 'query' });
      send({ type: 'query', req, query: text, params });
    });

  const mutate = (gql: string, params?: QueryParams): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const req = `m${++nextId}`;
      pending.set(req, { resolve: resolve as (v: never) => void, reject, kind: 'mutate' });
      send({ type: 'mutate', req, gql, params });
    });

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
          settle(entry, { rows: EMPTY_ROWS, complete: false, error: msg.error });

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
        status = { connected: msg.connected, pendingWrites: msg.pendingWrites };

        return;
      }
      default:
    }
  };

  return {
    receive,
    liveQuery,
    query,
    mutate,
    getStatus: () => status,
    subscriptionCount: () => bySub.size,
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
    },
  };
};
