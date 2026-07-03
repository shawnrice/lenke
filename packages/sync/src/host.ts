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
 * or a future CDC ingest) bumps the graph version; each subscription's
 * epoch-gated `getSnapshot` recomputes only if its dependency tokens moved;
 * a push goes out only when the snapshot reference actually changed.
 */

import { isLenkeError } from '@lenke/errors';
import { inferDeps, type LiveQuery, type Store } from '@lenke/native';

import {
  isClientMessage,
  type ClientMessage,
  type HostMessage,
  type MutateMessage,
  type QueryMessage,
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
};

export type SyncHostOptions = {
  /** Deliver one message to this host's client. */
  send: (msg: HostMessage) => void;
};

/** Shape any thrown failure into the wire's coded-error contract. */
const toWireError = (e: unknown): WireError => {
  if (isLenkeError(e)) {
    return { code: e.code, message: e.message };
  }

  return { code: 'Unknown', message: e instanceof Error ? e.message : String(e) };
};

/** v1 hosts do not evaluate params (no binding exposes GQL params yet). */
const rejectsParams = (msg: SubscribeMessage | QueryMessage): WireError | null =>
  msg.params && Object.keys(msg.params).length > 0
    ? { code: 'Unsupported', message: 'query params are reserved in protocol v1' }
    : null;

export const createSyncHost = (store: Store, options: SyncHostOptions): SyncHost => {
  const { send } = options;

  type Subscription = { live: LiveQuery; last: unknown; stop: () => void };
  const subs = new Map<string, Subscription>();

  const drop = (sub: string): void => {
    const s = subs.get(sub);

    if (s) {
      s.stop();
      subs.delete(sub);
    }
  };

  // Push the subscription's current rows iff the snapshot reference moved —
  // liveQuery's referential stability makes "did it change" a === check. A
  // snapshot failure (e.g. a query that parses lazily) closes the subscription.
  const push = (sub: string, s: Subscription): void => {
    let rows;

    try {
      rows = s.live.getSnapshot();
    } catch (e) {
      drop(sub);
      send({ type: 'rows', sub, error: toWireError(e) });

      return;
    }

    if (rows === s.last) {
      return;
    }

    s.last = rows;
    send({ type: 'rows', sub, rows, version: store.version, complete: true });
  };

  const subscribe = (msg: SubscribeMessage): void => {
    const rejected = rejectsParams(msg);

    if (rejected) {
      send({ type: 'rows', sub: msg.sub, error: rejected });

      return;
    }

    // Re-subscribing an existing id replaces it (how a windowed grid scrolls).
    drop(msg.sub);

    const live = store.liveQuery(msg.query, { deps: msg.deps ?? inferDeps(msg.query) });
    const s: Subscription = { live, last: null, stop: () => {} };
    s.stop = live.subscribe(() => push(msg.sub, s));
    subs.set(msg.sub, s);
    push(msg.sub, s); // initial rows, now
  };

  // One-shot reads run through `mutate` too: the engine executes whatever GQL
  // it is handed, so a write smuggled in a `query` message must still notify
  // this store's subscribers (mutate() is version-gated — pure reads stay silent).
  const query = (msg: QueryMessage): void => {
    const rejected = rejectsParams(msg);

    if (rejected) {
      send({ type: 'result', req: msg.req, error: rejected });

      return;
    }

    try {
      send({ type: 'result', req: msg.req, rows: store.mutate((g) => g.query(msg.query)) });
    } catch (e) {
      send({ type: 'result', req: msg.req, error: toWireError(e) });
    }
  };

  const mutate = (msg: MutateMessage): void => {
    try {
      store.mutate((g) => g.query(msg.gql));
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

  send({ type: 'status', connected: true, pendingWrites: 0, protocol: 1 });

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
  };
};
