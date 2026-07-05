/**
 * A reconnecting {@link SyncClient} — connection lifecycle around the v1 client.
 *
 * The v1 client (see {@link createSyncClient}) is bound to one transport: it
 * cannot outlive a dropped socket, and its pending requests reject when the
 * transport closes. That is the right primitive, but a real app on a flaky
 * network wants one durable handle whose live queries survive an outage and
 * whose writes wait for the wire to come back. This wraps the client with that
 * policy and nothing more:
 *
 * - **Re-dial with back-off** — a `connect` callback establishes one transport;
 *   on close the manager re-dials with exponential back-off (reset on success).
 * - **Re-subscribe on reconnect** — every active standing query is re-emitted
 *   against the fresh transport via {@link SyncClient.replay}; the host
 *   re-answers current rows. Snapshots hold their last value meanwhile (warm,
 *   marked stale by `connected()` / the status line), so the UI never blanks.
 * - **Park, don't reject** — a `query` / `mutate` issued while offline is held;
 *   `replay` re-sends it once reconnected, and the original promise settles on
 *   the eventual answer.
 *
 * **This assumes a durable engine sits behind it.** The manager gives you
 * at-least-once delivery (a write whose ack was lost on a dying socket replays
 * and may apply twice); exactly-once needs server-side request-id dedupe, a
 * protocol concern this layer does not own. The persisted write-back queue that
 * makes an outage lossless lives in {@link createSyncEngine}, not here — this is
 * connection lifecycle, not durability.
 *
 * ```ts
 * const client = createReconnectingClient({
 *   connect: ({ opened, received, closed }) => {
 *     const ws = new WebSocket(url);
 *     ws.onopen = opened;
 *     ws.onmessage = (e) => received(JSON.parse(String(e.data)));
 *     ws.onclose = closed;
 *     ws.onerror = () => ws.close();
 *     return { send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
 *   },
 * });
 * ```
 */

import { createSyncClient, type SyncClient } from './client.js';
import type { ClientMessage, HostMessage } from './protocol.js';

/** One live transport, from the manager's point of view. */
export type ReconnectingConnection = {
  /** Post one client message over this transport. */
  send: (msg: ClientMessage) => void;
  /** Abandon this transport (the manager calls this on teardown). */
  close: () => void;
};

/**
 * Establish one transport, wiring its lifecycle to the manager's handlers.
 * Called once per connection attempt. `opened` is expected to fire
 * asynchronously (as every real socket does); `closed` covers both clean close
 * and error and triggers a re-dial.
 */
export type ReconnectingConnect = (handlers: {
  /** The transport is open and ready to carry messages. */
  opened: () => void;
  /** One inbound host message arrived, already parsed to an object. */
  received: (msg: HostMessage) => void;
  /** The transport closed or errored — the manager will re-dial. */
  closed: () => void;
}) => ReconnectingConnection;

export type ReconnectingClientOptions = {
  connect: ReconnectingConnect;
  /**
   * Re-dial back-off. Delay is `min(maxMs, baseMs * 2 ** attempt)`, reset to
   * attempt 0 on every successful open. Defaults: `baseMs` 500, `maxMs` 5000.
   */
  retry?: { baseMs?: number; maxMs?: number };
};

/**
 * The client surface plus connectivity. `receive` is absent — the manager owns
 * the transport, so inbound messages are fed internally, never by the caller.
 */
export type ReconnectingClient = Pick<
  SyncClient,
  | 'liveQuery'
  | 'query'
  | 'gremlin'
  | 'mutate'
  | 'getStatus'
  | 'onStatus'
  | 'subscriptionCount'
  | 'close'
> & {
  /** Is a transport currently open? */
  connected: () => boolean;
  /** Observe connectivity flips (open/close); returns an unsubscribe fn. */
  onConnectivity: (cb: (up: boolean) => void) => () => void;
};

export const createReconnectingClient = (
  options: ReconnectingClientOptions,
): ReconnectingClient => {
  const baseMs = options.retry?.baseMs ?? 500;
  const maxMs = options.retry?.maxMs ?? 5000;

  let conn: ReconnectingConnection | null = null;
  let up = false;
  let stopped = false;
  let attempt = 0;
  let redial: ReturnType<typeof setTimeout> | null = null;
  const connectivity = new Set<(up: boolean) => void>();

  // One inner client for the manager's whole life: its entries and pending
  // requests survive transport drops. While offline `send` drops the message —
  // the state stays in the client, and replay() re-emits it on reconnect.
  const inner = createSyncClient({
    send: (m) => {
      if (up && conn) {
        conn.send(m);
      }
    },
  });

  const setUp = (next: boolean): void => {
    if (up === next) {
      return;
    }

    up = next;

    for (const cb of connectivity) {
      cb(next);
    }
  };

  const dial = (): void => {
    if (stopped) {
      return;
    }

    // A holder so the `opened`/`closed` handlers can reference this attempt's
    // connection without a temporal-dead-zone crash if a transport fires a
    // handler synchronously *during* connect() (real sockets fire async, but a
    // MessagePort/test double can be synchronous). `held.c` is filled in by the
    // assignment right after connect() returns.
    const held: { c: ReconnectingConnection | null } = { c: null };
    held.c = options.connect({
      opened: () => {
        conn = held.c;
        attempt = 0;
        setUp(true);
        inner.replay(); // re-subscribe + re-send parked one-shots
      },
      received: (m) => inner.receive(m),
      closed: () => {
        if (conn === held.c) {
          conn = null;
        }

        setUp(false);

        if (stopped) {
          return;
        }

        redial = setTimeout(dial, Math.min(maxMs, baseMs * 2 ** attempt++));
      },
    });
    conn = held.c;
  };

  dial();

  return {
    liveQuery: inner.liveQuery,
    query: inner.query,
    gremlin: inner.gremlin,
    mutate: inner.mutate,
    getStatus: inner.getStatus,
    onStatus: inner.onStatus,
    subscriptionCount: inner.subscriptionCount,
    connected: () => up,
    onConnectivity: (cb) => {
      connectivity.add(cb);

      return () => connectivity.delete(cb);
    },
    close: () => {
      stopped = true;

      if (redial) {
        clearTimeout(redial);
        redial = null;
      }

      conn?.close();
      conn = null;
      setUp(false);
      inner.close(); // rejects any still-pending request — the app is tearing down
    },
  };
};
