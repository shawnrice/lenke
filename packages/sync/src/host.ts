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

import { ErrorCode, isLenkeError, LenkeError } from '@lenke/errors';
import type { LiveQuery, QueryParams, Row, Store } from '@lenke/native';

import {
  isClientMessage,
  keyOf,
  runWrite,
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
   * Apply one client mutation. Defaults to running `text` on the store —
   * `g.query(text, params)` for GQL, `g.gremlin(text)` for `lang: 'gremlin'`.
   * The sync loop overrides this to also enqueue the write for upstream
   * (`engine.mutate`).
   */
  applyMutation?: (text: string, params: QueryParams | undefined, lang?: 'gql' | 'gremlin') => void;
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

type RowDiff = {
  patch: RowPatch[];
  remove: unknown[];
  /** New key order — set only when the key sequence changed. */
  order?: unknown[];
  /** The next `prev` state: rows by canonical key, and the canonical key order. */
  byKey: Map<string, Row>;
  orderKeys: string[];
};

// Did a cell's value change? Identity for primitives; structural (JSON) for
// object/array-valued columns — `graph.query` returns those as fresh references
// each recompute, so `Object.is` alone would re-ship them on every push.
const cellChanged = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return false;
  }

  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  return true;
};

/**
 * Diff the previous keyed result against the current rows: new/changed rows
 * become `patch` (only the changed columns; all columns when the row is new),
 * vanished keys become `remove`, and `order` rides along when the key sequence
 * moved (a pure cell change leaves it untouched → nothing extra crosses) — or
 * when `forceOrder` is set, which the host does on a subscription's first
 * *complete* push so the client always receives an authoritative key set, even
 * an empty one (an incomplete first push is skipped, to preserve warm rows).
 */
const diffRows = (
  keyCol: string,
  prevByKey: Map<string, Row>,
  prevOrder: readonly string[],
  rows: readonly Row[],
  forceOrder: boolean,
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
      if (cellChanged(row[col], prev[col])) {
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

  return {
    patch,
    remove,
    order: orderChanged || forceOrder ? orderValues : undefined,
    byKey,
    orderKeys,
  };
};

export const createSyncHost = (store: Store, options: SyncHostOptions): SyncHost => {
  const { send } = options;
  const applyMutation =
    options.applyMutation ??
    ((text: string, params: QueryParams | undefined, lang?: 'gql' | 'gremlin') =>
      store.mutate((g) => runWrite(g, { text, params, lang })));
  const isComplete = options.isComplete ?? (() => true);
  const pendingWrites = options.pendingWrites ?? (() => 0);

  type Subscription = {
    live: LiveQuery<unknown>;
    deps: readonly string[] | null;
    params?: QueryParams;
    /** Row-identity column → this subscription sends keyed diffs, not full rows. */
    key?: string;
    /** A Gremlin standing query → pushes carry `values`, not `rows`/diffs. */
    lang?: 'gremlin';
    /** Windowed read (keyless GQL only): push `rows.slice(offset, offset+limit)`. */
    window?: { offset: number; limit: number };
    /** Prior keyed result, for diffing the next push (keyed subscriptions only). */
    prevByKey: Map<string, Row>;
    prevOrder: string[];
    last: unknown;
    lastComplete: boolean | null;
    /** Has an authoritative (complete) push gone out yet this (re)subscribe? */
    authoritativeSent: boolean;
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
    let rows: unknown[];

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
    // The first *complete* push of a (re)subscribe must be authoritative — the
    // client may hold stale rows from before a reconnect, and an empty result
    // would otherwise carry no ops and leave them on screen. Gate on "no
    // complete push has gone out yet" (NOT "first push ever"): a reconnected
    // host typically pushes incomplete-and-empty first (still loading its
    // scope) — that push legitimately carries no order so the client keeps its
    // warm rows — and only the LATER push, when the scope finishes loading and
    // `complete` flips true, is the authoritative one that must ship the key
    // set (even an empty one, to clear rows that were deleted while away).
    const firstAuthoritativePush = !s.authoritativeSent && complete;

    s.last = rows;
    s.lastComplete = complete;

    if (complete) {
      s.authoritativeSent = true;
    }

    // Gremlin: full result values every push (no `rows`, no keyed diffs).
    if (s.lang === 'gremlin') {
      send({ type: 'rows', sub, values: rows, version: store.version, complete });

      return;
    }

    // Keyless GQL: the full result every push, or a window slice for a grid.
    // Change detection above still keys off the FULL rows ref (`s.last`), so a
    // windowed slice never breaks it; `complete` reflects the whole scope.
    if (s.key === undefined) {
      const full = rows as Row[];
      const out = s.window ? full.slice(s.window.offset, s.window.offset + s.window.limit) : full;
      send({ type: 'rows', sub, rows: out, version: store.version, complete });

      return;
    }

    // Keyed GQL: send only what moved. When just `complete` flipped (rows ref
    // unchanged), an empty diff carries the new flag without re-shipping rows.
    const msg: RowsMessage = { type: 'rows', sub, version: store.version, complete };

    // Also diff when this is the first complete push even if the rows ref didn't
    // move: a scope that finished loading to an EMPTY result (no writes → same
    // empty ref) must still emit its authoritative (empty) order, or a client
    // holding warm rows across the reconnect would keep showing them as complete.
    if (rowsChanged || firstAuthoritativePush) {
      const d = diffRows(s.key, s.prevByKey, s.prevOrder, rows as Row[], firstAuthoritativePush);
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

    // Gremlin standing queries push full `values`; the `key` (keyed diffs) is a
    // GQL-rows notion and is ignored for them.
    const gremlin = msg.lang === 'gremlin';
    const live: LiveQuery<unknown> = gremlin
      ? store.liveGremlin(msg.query, { deps })
      : store.liveQuery(msg.query, { deps, params: msg.params });
    // Window applies to keyless GQL only (a keyed diff or a Gremlin value stream
    // has no stable slice); clamp to non-negative so a bad offset/limit can't
    // reach `slice`'s from-the-end semantics.
    const window =
      msg.window && !gremlin && msg.key === undefined
        ? { offset: Math.max(0, msg.window.offset | 0), limit: Math.max(0, msg.window.limit | 0) }
        : undefined;
    const s: Subscription = {
      live,
      deps,
      params: msg.params,
      key: gremlin ? undefined : msg.key,
      lang: gremlin ? 'gremlin' : undefined,
      window,
      prevByKey: new Map(),
      prevOrder: [],
      last: null,
      lastComplete: null,
      authoritativeSent: false,
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

      if (msg.format === 'arrow') {
        // Columnar blob instead of JSON rows (the client decodes it). Binary
        // transports only — the transport must carry the Uint8Array.
        send({
          type: 'result',
          req: msg.req,
          arrow: store.mutate((g) => g.queryArrow(msg.query, msg.params)),
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
    // Wire-skew shim, mirroring the snapshot layer's: a pre-`lang` client (a
    // stale tab against an upgraded SharedWorker, an old app build against a
    // new server) still sends the write text under `gql`. Honor it rather than
    // rejecting a perfectly valid write with a baffling parse error.
    const text = msg.text ?? (msg as { gql?: unknown }).gql;

    try {
      if (typeof text !== 'string') {
        throw new LenkeError('lenke: mutate carried no query text', {
          code: ErrorCode.InvalidShape,
        });
      }

      applyMutation(text, msg.params, msg.lang);
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
