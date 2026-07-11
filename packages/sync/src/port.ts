/**
 * Port lifecycle helpers — the copy-paste boilerplate every `MessagePort`-based
 * sync app otherwise reimplements (and easily gets wrong).
 *
 * A `MessagePort` can't reliably signal its tab's death (only recent Chromium
 * fires a `close` event), so a SharedWorker that keeps one host per connection
 * would leak hosts — each dead tab's standing queries re-run on every change
 * forever. The fix is a two-sided handshake:
 *
 * - the tab posts a `bye` on `pagehide` and re-`replay()`s on bfcache revival
 *   ({@link connectSharedWorker}), and
 * - the worker tears the host down on `bye` OR a `close` event, and revives a
 *   fresh host if a bye'd port speaks again ({@link servePort}).
 *
 * {@link serveSharedWorker} wires `self.onconnect` to {@link servePort} for
 * every connecting tab and (given the upstream link) broadcasts status on
 * connectivity flips — collapsing the whole worker-side `onconnect` block.
 */

import { createSyncClient, type SyncClient, type SyncClientOptions } from './client.js';
import type { SyncEngine } from './engine.js';
import type { SyncHost } from './host.js';

/** The sentinel a tab posts so the worker tears its host down promptly. */
export type ByeMessage = { readonly type: 'bye' };
const BYE: ByeMessage = { type: 'bye' };
const isBye = (m: unknown): m is ByeMessage => (m as { type?: unknown } | null)?.type === 'bye';

/**
 * The subset of `MessagePort` these helpers drive (a real `MessagePort` — and so
 * `SharedWorker.port` — satisfies it). `onmessage` takes a `MessageEvent` so the
 * DOM port assigns cleanly; the helpers only read `event.data`.
 */
export type PortLike = {
  postMessage: (message: unknown) => void;
  start?: () => void;
  onmessage?: ((event: MessageEvent) => void) | null;
  // MessagePort has no typed 'close' event (only Chromium fires one at runtime),
  // so this stays optional and a real port satisfies it via its general overload.
  addEventListener?: (type: 'close', listener: () => void) => void;
};

/** Just the engine capability {@link servePort} needs — one host per connection. */
type HostFactory = Pick<SyncEngine, 'createHost'>;

/** A served connection: `sendStatus` pushes to its current host; `close` tears it down. */
export type ServedPort = { sendStatus: () => void; close: () => void };

/**
 * Serve ONE connection (a `MessagePort`) with the full host lifecycle: open a
 * host, pump inbound messages to it, tear it down on `bye` (revivable) or a
 * `close` event (terminal, fires `onClose`), and revive a fresh host if a bye'd
 * port speaks again (bfcache). The returned `sendStatus` always targets the live
 * host (a no-op while shut).
 */
export const servePort = (
  engine: HostFactory,
  port: PortLike,
  opts: { onClose?: () => void } = {},
): ServedPort => {
  let host: SyncHost | null = null;

  const open = (): void => {
    host = engine.createHost({ send: (m) => port.postMessage(m) });
  };
  const shut = (): void => {
    if (host) {
      host.close();
      host = null;
    }
  };

  port.onmessage = (event) => {
    if (isBye(event.data)) {
      shut();

      return;
    }

    if (host === null) {
      open(); // bfcache revival: the tab came back after its bye
    }

    host?.receive(event.data);
  };

  const close = (): void => {
    shut();
    opts.onClose?.();
  };
  // Only recent Chromium fires 'close'; where present it's the terminal signal.
  port.addEventListener?.('close', close);
  open();
  port.start?.();

  return { sendStatus: () => host?.sendStatus(), close };
};

/** A running SharedWorker service — one host per tab, with a status broadcast. */
export type SharedWorkerService = {
  /** Push a fresh `status` to every live connection (call on connectivity flips). */
  broadcastStatus: () => void;
  /** Live connection count (for tests/diagnostics). */
  connectionCount: () => number;
};

/**
 * Wire `self.onconnect` (the SharedWorker global) to {@link servePort} for every
 * connecting tab — one host per connection, torn down correctly — collapsing the
 * whole worker-side `onconnect` block. `self.onconnect` is set synchronously (so
 * no early connection is missed), while the `engine` may still be booting: pass
 * a promise and each connection is served the moment it resolves. Use the
 * returned `broadcastStatus` to push status to every tab on an upstream
 * connectivity flip (`server.onConnectivity(() => svc.broadcastStatus())`).
 */
export const serveSharedWorker = (
  engine: HostFactory | Promise<HostFactory>,
): SharedWorkerService => {
  const served = new Set<ServedPort>();
  const ready = Promise.resolve(engine);

  const onconnect = (event: { ports: readonly PortLike[] }): void => {
    const [port] = event.ports;

    if (!port) {
      return;
    }

    // Defer until the engine is ready; the port queues inbound messages until
    // `servePort` attaches its `onmessage`, so nothing is dropped.
    void ready.then((e) => {
      const conn = servePort(e, port, { onClose: () => served.delete(conn) });
      served.add(conn);
    });
  };

  (globalThis as unknown as { onconnect: (e: { ports: readonly PortLike[] }) => void }).onconnect =
    onconnect;

  return {
    broadcastStatus: () => {
      for (const conn of served) {
        conn.sendStatus();
      }
    },
    connectionCount: () => served.size,
  };
};

/**
 * Connect a tab to its SharedWorker: create a {@link SyncClient} over the port,
 * pump messages both ways, and install the tab-side lifecycle — post `bye` on
 * `pagehide` (so the worker drops this tab's host) and `replay()` standing
 * queries on bfcache revival (`pageshow` persisted). Accepts a `SharedWorker`
 * (uses its `.port`) or a bare `MessagePort`.
 */
export const connectSharedWorker = (
  worker: { port: PortLike } | PortLike,
  clientOpts: Omit<SyncClientOptions, 'send'> = {},
): SyncClient => {
  const port: PortLike = 'port' in worker ? worker.port : worker;
  const client = createSyncClient({ ...clientOpts, send: (m) => port.postMessage(m) });

  port.onmessage = (event) => client.receive(event.data);
  port.start?.();

  // `pagehide` fires on close, navigation, AND bfcache entry; `pageshow`
  // persisted marks a bfcache revival. Guard `addEventListener` so a non-DOM
  // host (tests, Node) is a harmless no-op.
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: (e: { persisted?: boolean }) => void) => void;
  };
  target.addEventListener?.('pagehide', () => port.postMessage(BYE));
  target.addEventListener?.('pageshow', (e) => {
    if (e.persisted) {
      client.replay();
    }
  });

  return client;
};
