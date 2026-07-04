// createReconnectingClient over a controllable in-process transport: a real
// createSyncHost sits on one shared store (the "server"); the transport can be
// cut and will re-dial. Proves the three guarantees — standing queries
// re-subscribe after a reconnect, a write issued while offline lands once the
// wire returns, and connectivity flips are observable — without a real socket.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { createStore, graphFromNdjson } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';

import { createSyncHost } from './host.js';
import type { HostMessage } from './protocol.js';
import { createReconnectingClient } from './reconnect.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[reconnect.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const NDJSON = ['a', 'b']
  .map((id) => `{"type":"node","id":"${id}","labels":["Person"],"properties":{"name":"${id}"}}`)
  .join('\n');

/** Spin until `pred()` holds, pumping micro/macro tasks; fails loudly on timeout. */
const until = async (pred: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (pred()) {
      return;
    }

    await new Promise((r) => setTimeout(r, 1));
  }

  throw new Error(`until: condition never held — ${label}`);
};

const suite = hasLib ? describe : describe.skip;

suite('createReconnectingClient', () => {
  if (!hasLib) {
    return;
  }

  // A controllable transport: each connection gets a fresh host over the shared
  // store (exactly the per-socket-host topology a server runs). `cut()` drops
  // the live connection, which triggers the manager's re-dial.
  const makeTransport = (store: ReturnType<typeof createStore>) => {
    let liveClosed: (() => void) | null = null;
    let liveHost: ReturnType<typeof createSyncHost> | null = null;
    let allow = true; // when false, every dial fails to open (a held outage)
    let connects = 0;

    const connect: Parameters<typeof createReconnectingClient>[0]['connect'] = ({
      opened,
      received,
      closed,
    }) => {
      if (!allow) {
        queueMicrotask(closed); // dial fails; the manager backs off and retries

        return { send: () => {}, close: () => {} };
      }

      connects++;
      const host = createSyncHost(store, {
        send: (m: HostMessage) => queueMicrotask(() => received(m)),
      });
      liveHost = host;
      liveClosed = closed;
      queueMicrotask(opened);

      return {
        send: (m) => {
          if (liveHost === host) {
            queueMicrotask(() => host.receive(m));
          }
        },
        close: () => {
          if (liveHost === host) {
            liveHost = null;
            liveClosed = null;
            host.close();
          }
        },
      };
    };

    const cut = (): void => {
      const closed = liveClosed;
      liveHost?.close();
      liveHost = null;
      liveClosed = null;
      closed?.(); // the manager schedules a re-dial
    };

    // Hold the wire down (drop the live socket, refuse new dials) / let it back.
    const goOffline = (): void => {
      allow = false;
      cut();
    };
    const goOnline = (): void => {
      allow = true;
    };

    return { connect, cut, goOffline, goOnline, connects: () => connects };
  };

  test('re-subscribes a standing query after a reconnect', async () => {
    const store = createStore(
      graphFromNdjson(createFfiBackend(LIB), new TextEncoder().encode(NDJSON)),
    );
    const t = makeTransport(store);
    const client = createReconnectingClient({ connect: t.connect, retry: { baseMs: 1, maxMs: 5 } });

    const live = client.liveQuery('MATCH (p:Person) RETURN p.name');
    live.subscribe(() => {}); // one persistent subscriber keeps the wire sub alive
    await until(() => live.getSnapshot().rows.length === 2, 'initial rows');

    // Drop the socket, then write to the shared store while offline.
    t.cut();
    await until(() => !client.connected(), 'goes offline on cut');
    store.mutate((g) => g.query("INSERT (:Person {name: 'carol'})"));

    // The manager re-dials; the re-subscribed query re-answers current rows.
    await until(() => client.connected(), 'reconnects');
    await until(() => live.getSnapshot().rows.length === 3, 'rows reflect the offline write');
    expect(t.connects()).toBeGreaterThanOrEqual(2);

    client.close();
  });

  test('a mutate issued while offline lands after reconnect', async () => {
    const store = createStore(
      graphFromNdjson(createFfiBackend(LIB), new TextEncoder().encode(NDJSON)),
    );
    const t = makeTransport(store);
    const client = createReconnectingClient({ connect: t.connect, retry: { baseMs: 1, maxMs: 5 } });

    const live = client.liveQuery('MATCH (p:Person) RETURN p.name');
    live.subscribe(() => {});
    await until(() => live.getSnapshot().rows.length === 2, 'initial rows');

    // Hold the wire down so the write genuinely parks (not a timing race).
    t.goOffline();
    await until(() => !client.connected(), 'offline');
    let acked = false;
    const done = client.mutate("INSERT (:Person {name: 'dave'})").then(() => {
      acked = true;
    });
    // While the outage is held open, the parked write must not settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(acked).toBe(false);

    t.goOnline(); // the next re-dial succeeds; replay re-sends the parked write
    await done; // resolves only once the wire returns and the ack arrives
    expect(acked).toBe(true);
    await until(() => live.getSnapshot().rows.length === 3, 'the parked write is visible');

    client.close();
  });

  test('reports connectivity flips and stops re-dialing on close', async () => {
    const store = createStore(
      graphFromNdjson(createFfiBackend(LIB), new TextEncoder().encode(NDJSON)),
    );
    const t = makeTransport(store);
    const flips: boolean[] = [];
    const client = createReconnectingClient({ connect: t.connect, retry: { baseMs: 1, maxMs: 5 } });
    client.onConnectivity((u) => flips.push(u));

    await until(() => client.connected(), 'first open');
    t.cut();
    await until(() => !client.connected(), 'drop observed');
    await until(() => client.connected(), 'auto-reconnect');

    expect(flips).toEqual([true, false, true]);

    client.close();
    expect(client.connected()).toBe(false);

    // After close, a cut must not resurrect the connection.
    const before = t.connects();
    t.cut();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.connects()).toBe(before);
  });
});
