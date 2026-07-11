// The CDC write stream end-to-end: several clients share one authoritative
// Store + one WriteLog (the multiplayer server topology). One client mutates;
// the others' stream subscribers receive the raw write and ingest it into their
// OWN local store — cross-client optimism over the wire, which the rows-only
// protocol couldn't do. Also covers origin-skip, catch-up replay, and resync.
// Run: bun test packages/sync/src/cdc.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { createStore, graphFromNdjson, type Store } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';

import { createSyncClient, type SyncClient } from './client.js';
import { createSyncHost } from './host.js';
import { runWrite, type SyncWrite } from './protocol.js';
import { createWriteLog, type WriteLog } from './writelog.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  // eslint-disable-next-line no-console
  console.warn(`[cdc.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const suite = hasLib ? describe : describe.skip;

const SEED = '{"type":"node","id":"seed","labels":["Seed"],"properties":{}}';
const newStore = (): Store =>
  createStore(graphFromNdjson(createFfiBackend(LIB), new TextEncoder().encode(SEED)));

/** Count of `Widget` nodes — a cheap way to read a store's state. */
const widgets = (s: Store): number =>
  s.mutate((g) => g.query<{ c: number }>('MATCH (n:Widget) RETURN count(*) AS c'))[0].c;

/** A server: one authoritative store + one shared op log; `client()` attaches a
 *  fresh connection (its own host) to it. */
const server = (writeLog: WriteLog = createWriteLog()) => {
  const store = newStore();
  const client = (): SyncClient => {
    // Circular wiring (host.send → client, client.send → host); a box lets both
    // stay `const` while the client is assigned after the host is built.
    const link: { c?: SyncClient } = {};
    const host = createSyncHost(store, { send: (m) => link.c?.receive(m), writeLog });
    link.c = createSyncClient({ send: (m) => host.receive(m) });

    return link.c;
  };

  return { store, writeLog, client };
};

suite('CDC write stream (TS vs native store)', () => {
  test("a client ingests another client's write into its own local store", async () => {
    const s = server();
    const a = s.client();
    const b = s.client();

    // A pipes the CDC stream into a local store — exactly what engine.ingest does.
    const localA = newStore();
    a.subscribeWrites((writes) => {
      localA.mutate((g) => {
        for (const w of writes) {
          runWrite(g, w);
        }
      });
    });

    expect(widgets(localA)).toBe(0);
    await b.mutate('INSERT (:Widget {id: 1})');

    // Delivered over the write stream — A's local store now reflects B's write,
    // and so does the authoritative server.
    expect(widgets(localA)).toBe(1);
    expect(widgets(s.store)).toBe(1);
  });

  test('the writer does not receive its own write (origin-skip)', async () => {
    const s = server();
    const a = s.client();
    const b = s.client();
    const aSeen: SyncWrite[] = [];
    const bSeen: SyncWrite[] = [];
    a.subscribeWrites((w) => aSeen.push(...w));
    b.subscribeWrites((w) => bSeen.push(...w));

    await b.mutate('INSERT (:Widget {id: 1})');

    expect(aSeen.map((w) => w.text)).toEqual(['INSERT (:Widget {id: 1})']);
    expect(bSeen).toEqual([]); // B applied it optimistically; no self-echo
  });

  test('catch-up: a late subscriber replays the retained tail', async () => {
    const s = server();
    const a = s.client();
    const b = s.client();

    await b.mutate('INSERT (:Widget {id: 1})');
    await b.mutate('INSERT (:Widget {id: 2})');

    // A subscribes AFTER both writes → the host replays them from the log.
    const seen: SyncWrite[] = [];
    a.subscribeWrites((w) => seen.push(...w));

    expect(seen.map((w) => w.text)).toEqual([
      'INSERT (:Widget {id: 1})',
      'INSERT (:Widget {id: 2})',
    ]);
  });

  test('resync: subscribing after the retained tail dropped triggers cold-boot', async () => {
    const s = server(createWriteLog({ capacity: 1 }));
    const a = s.client();
    const b = s.client();

    await b.mutate('INSERT (:Foo)'); // seq 1
    await b.mutate('INSERT (:Bar)'); // seq 2 — ring (cap 1) now holds only seq 2

    let resynced = false;
    const seen: SyncWrite[] = [];
    a.subscribeWrites((w) => seen.push(...w), { onResync: () => (resynced = true) });

    expect(resynced).toBe(true); // since=0 fell off the tail
    expect(seen).toEqual([]);
  });
});
