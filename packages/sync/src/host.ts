/**
 * The transport-agnostic live-query host — the server half of the v1 protocol.
 *
 * A host is attached to one client connection and one {@link Store}. It is
 * deliberately not coupled to any transport type: you hand it a `send`
 * function and feed inbound messages to `receive`, which is exactly the shape
 * of every port-like channel —
 *
 * ```ts
 * // Worker (browser):
 * const host = createSyncHost(store, { send: (m) => self.postMessage(m) });
 * self.onmessage = (e) => host.receive(e.data);
 *
 * // WebSocket (server, e.g. Bun.serve / ws):
 * const host = createSyncHost(store, { send: (m) => ws.send(JSON.stringify(m)) });
 * ws.onmessage = (e) => host.receive(JSON.parse(String(e.data)));
 * ```
 *
 * That symmetry is the design's load-bearing claim: a WebSocket is
 * structurally a port, so the server-embedded host and the browser worker host
 * are one implementation.
 *
 * Change routing is epoch-driven and ignorant of transports: any write through
 * `store.mutate` (this connection's, another connection's on the same store,
 * or a sync-loop ingest) bumps the graph version; each subscription's
 * epoch-gated `getSnapshot` recomputes only if its dependency tokens moved;
 * a push goes out only when the snapshot reference (or its completeness)
 * actually changed.
 *
 * The optional hooks are the sync loop's seams (see `engine.ts` —
 * `engine.createHost()` wires them): `onSubscribe` triggers demand-fill,
 * `isComplete` computes the honest `complete` flag from per-collection state,
 * `applyMutation` routes client writes through the write-back queue, and
 * `pendingWrites` feeds the status message. A bare host (no hooks) behaves as
 * a complete, local-only store.
 */

import { isLenkeError } from '@lenke/errors';
import type { LiveQuery, QueryParams, Row, Store } from '@lenke/native';

import {
  isClientMessage,
  type ClientMessage,
  type HostMessage,
  type MutateMessage,
  type QueryMessage,
  type RowPatch,
  type RowsMessage,
  type SubscribeMessage,
  type WireError,
} from './protocol.js';

export type SyncHost = {
  /** Feed one inbound (already-parsed) client message. Unknown tags are ignored. */
  receive: (msg: unknown) => void;
  /** Tear down every subscription (call on disconnect). */
  close: () => void;
  /** Live standing-query count — for tests and status reporting. */
  subscriptionCount: () => number;
  /**
   * Re-evaluate every standing query and push anything whose rows or
   * completeness changed. The sync loop calls this when a collection load
   * lands (an empty scope flips `complete` without moving the graph version,
   * which store listeners alone would never surface).
   */
  refresh: () => void;
  /** Send a fresh `status` message (queue-length changes ride this). */
  sendStatus: () => void;
};

export type SyncHostOptions = {
  /** Deliver one message to this host's client. */
  send: (msg: HostMessage) => void;
  /**
   * Apply one client mutation. Defaults to `store.mutate(g => g.query(gql,
   * params))` — the sync loop overrides this to also enqueue the write for
   * upstream (`engine.mutate`).
   */
  applyMutation?: (gql: string, params?: QueryParams) => void;
  /**
   * Is the data a query with these dependency tokens (and params, which scope
   * value-keyed collections) needs fully loaded? Defaults to `true` (a bare
   * host is a complete local store). `null` deps declare no collection to fill.
   */
  isComplete?: (deps: readonly string[] | null, params?: QueryParams) => boolean;
  /**
   * Called on every subscribe with its declared deps and params — the
   * demand-fill trigger (params carry the scope of value-keyed collections).
   */
  onSubscribe?: (deps: readonly string[] | null, params?: QueryParams) => void;
  /** Pending write-back count for the status message. Defaults to 0. */
  pendingWrites?: () => number;
};

/** Shape any thrown failure into the wire's coded-error contract. */
const toWireError = (e: unknown): WireError => {
  if (isLenkeError(e)) {
    return { code: e.code, message: e.message };
  }

  return { code: 'Unknown', message: e instanceof Error ? e.message : String(e) };
};

/** Canonical, collision-free string for a key column's value. */
const keyOf = (value: unknown): string => JSON.stringify(value) ?? 'null';

type RowDiff = {
  patch: RowPatch[];
  remove: unknown[];
  /** New key order — set only when the key sequence changed. */
  order?: unknown[];
  /** The next `prev` state: rows by canonical key, and the canonical key order. */
  byKey: Map<string, Row>;
  orderKeys: string[];
};

/**
 * Diff the previous keyed result against the current rows: new/changed rows
 * become `patch` (only the changed columns; all columns when the row is new),
 * vanished keys become `remove`, and `order` rides along only when the key
 * sequence actually moved (a pure cell change leaves it untouched → nothing
 * extra crosses).
 */
const diffRows = (
  keyCol: string,
  prevByKey: Map<string, Row>,
  prevOrder: readonly string[],
  rows: readonly Row[],
): RowDiff => {
  const byKey = new Map<string, Row>();
  const orderKeys: string[] = [];
  const orderValues: unknown[] = [];
  const patch: RowPatch[] = [];

  for (const row of rows) {
    const keyValue = row[keyCol];
    const ck = keyOf(keyValue);
    byKey.set(ck, row);
    orderKeys.push(ck);
    orderValues.push(keyValue);

    const prev = prevByKey.get(ck);

    if (prev === undefined) {
      patch.push({ key: keyValue, set: { ...row } }); // first sighting → every column
      continue;
    }

    const set: Row = {};
    let changed = false;

    for (const col of Object.keys(row)) {
      if (!Object.is(row[col], prev[col])) {
        set[col] = row[col];
        changed = true;
      }
    }

    if (changed) {
      patch.push({ key: keyValue, set });
    }
  }

  const remove: unknown[] = [];

  for (const [ck, prevRow] of prevByKey) {
    if (!byKey.has(ck)) {
      remove.push(prevRow[keyCol]);
    }
  }

  const orderChanged =
    orderKeys.length !== prevOrder.length || orderKeys.some((k, i) => k !== prevOrder[i]);

  return { patch, remove, order: orderChanged ? orderValues : undefined, byKey, orderKeys };
};

export const createSyncHost = (store: Store, options: SyncHostOptions): SyncHost => {
  const { send } = options;
  const applyMutation =
    options.applyMutation ??
    ((gql: string, params?: QueryParams) => store.mutate((g) => g.query(gql, params)));
  const isComplete = options.isComplete ?? (() => true);
  const pendingWrites = options.pendingWrites ?? (() => 0);

  type Subscription = {
    live: LiveQuery;
    deps: readonly string[] | null;
    params?: QueryParams;
    /** Row-identity column → this subscription sends keyed diffs, not full rows. */
    key?: string;
    /** Prior keyed result, for diffing the next push (keyed subscriptions only). */
    prevByKey: Map<string, Row>;
    prevOrder: string[];
    last: unknown;
    lastComplete: boolean | null;
    stop: () => void;
  };
  const subs = new Map<string, Subscription>();

  const drop = (sub: string): void => {
    const s = subs.get(sub);

    if (s) {
      s.stop();
      subs.delete(sub);
    }
  };

  // Push the subscription's current state iff the snapshot reference OR the
  // completeness flag moved — liveQuery's referential stability makes the rows
  // check a === compare; the completeness pair-check is what lets an empty
  // scope's load flip `complete` without any rows change. A snapshot failure
  // (e.g. a query that parses lazily) closes the subscription.
  const push = (sub: string, s: Subscription): void => {
    let rows: Row[];

    try {
      rows = s.live.getSnapshot();
    } catch (e) {
      drop(sub);
      send({ type: 'rows', sub, error: toWireError(e) });

      return;
    }

    const complete = isComplete(s.deps, s.params);

    if (rows === s.last && complete === s.lastComplete) {
      return;
    }

    const rowsChanged = rows !== s.last;

    s.last = rows;
    s.lastComplete = complete;

    // Keyless: the full result every push (v1's shape, unchanged).
    if (s.key === undefined) {
      send({ type: 'rows', sub, rows, version: store.version, complete });

      return;
    }

    // Keyed: send only what moved. When just `complete` flipped (rows ref
    // unchanged), an empty diff carries the new flag without re-shipping rows.
    const msg: RowsMessage = { type: 'rows', sub, version: store.version, complete };

    if (rowsChanged) {
      const d = diffRows(s.key, s.prevByKey, s.prevOrder, rows);
      s.prevByKey = d.byKey;
      s.prevOrder = d.orderKeys;

      if (d.patch.length > 0) {
        msg.patch = d.patch;
      }

      if (d.remove.length > 0) {
        msg.remove = d.remove;
      }

      if (d.order !== undefined) {
        msg.order = d.order;
      }
    }

    send(msg);
  };

  const subscribe = (msg: SubscribeMessage): void => {
    // Re-subscribing an existing id replaces it (how a windowed grid scrolls).
    drop(msg.sub);

    // Deps are declared on the wire, never inferred here (null = recompute on
    // every change; [] = never; [...] = epoch-gated). The type requires the
    // field; a malformed message that omits it degrades to the safe coarse
    // default (recompute-always), never a crash.
    const deps = msg.deps ?? null;
    options.onSubscribe?.(deps, msg.params);

    const live = store.liveQuery(msg.query, { deps, params: msg.params });
    const s: Subscription = {
      live,
      deps,
      params: msg.params,
      key: msg.key,
      prevByKey: new Map(),
      prevOrder: [],
      last: null,
      lastComplete: null,
      stop: () => {},
    };
    s.stop = live.subscribe(() => push(msg.sub, s));
    subs.set(msg.sub, s);
    push(msg.sub, s); // initial rows, now (possibly stale/incomplete — that's the contract)
  };

  // One-shot reads run through `mutate` too: the engine executes whatever it
  // is handed, so a write smuggled in a `query` message (GQL or a Gremlin
  // `addV`/`drop`) must still notify this store's subscribers (mutate() is
  // version-gated — pure reads stay silent). Smuggled writes do NOT replicate
  // upstream: replicated writes must arrive as `mutate` messages.
  //
  // `lang: 'gremlin'` runs the text through the Gremlin engine and answers with
  // `values`; GQL (the default) answers with `rows`. Gremlin has no param
  // binding — the text is executed as-is (`params` are a GQL-only safety path).
  const query = (msg: QueryMessage): void => {
    try {
      if (msg.lang === 'gremlin') {
        send({
          type: 'result',
          req: msg.req,
          values: store.mutate((g) => g.gremlin(msg.query)),
        });

        return;
      }

      send({
        type: 'result',
        req: msg.req,
        rows: store.mutate((g) => g.query(msg.query, msg.params)),
      });
    } catch (e) {
      send({ type: 'result', req: msg.req, error: toWireError(e) });
    }
  };

  const mutate = (msg: MutateMessage): void => {
    try {
      applyMutation(msg.gql, msg.params);
      send({ type: 'ack', req: msg.req, ok: true });
    } catch (e) {
      send({ type: 'ack', req: msg.req, ok: false, error: toWireError(e) });
    }
  };

  const dispatch: { [T in ClientMessage['type']]: (msg: never) => void } = {
    subscribe,
    unsubscribe: (msg: { sub: string }) => drop(msg.sub),
    query,
    mutate,
  };

  const sendStatus = (): void => {
    send({ type: 'status', connected: true, pendingWrites: pendingWrites(), protocol: 1 });
  };

  sendStatus();

  return {
    receive: (msg) => {
      if (isClientMessage(msg)) {
        (dispatch[msg.type] as (m: ClientMessage) => void)(msg);
      }
      // Unknown tags fall through silently: forward-compat with protocol extensions.
    },
    close: () => {
      for (const s of subs.values()) {
        s.stop();
      }

      subs.clear();
    },
    subscriptionCount: () => subs.size,
    refresh: () => {
      for (const [sub, s] of subs) {
        push(sub, s);
      }
    },
    sendStatus,
  };
};
