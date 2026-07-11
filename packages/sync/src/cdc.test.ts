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
import { createDedupRegistry } from './dedup.js';
import { createSyncHost } from './host.js';
import {
  runWrite,
  type ClientMessage,
  type HostMessage,
  type SyncWrite,
  type WritesMessage,
} from './protocol.js';
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

  test('reconnect (replay) resumes from the cursor without double-applying', async () => {
    const s = server();
    const a = s.client();
    const b = s.client();
    const seen: string[] = [];
    a.subscribeWrites((w) => seen.push(...w.map((x) => x.text)));

    await b.mutate('INSERT (:Widget {id: 1})');
    expect(seen).toEqual(['INSERT (:Widget {id: 1})']);

    // Simulate reconnect: replay re-subscribes the write stream from the cursor.
    // The cursor is current, so nothing is re-delivered (no double-apply)…
    a.replay();
    expect(seen).toEqual(['INSERT (:Widget {id: 1})']);

    // …and live delivery continues afterward.
    await b.mutate('INSERT (:Widget {id: 2})');
    expect(seen).toEqual(['INSERT (:Widget {id: 1})', 'INSERT (:Widget {id: 2})']);
  });

  test('a live subscriber receives every write regardless of ring capacity', async () => {
    const s = server(createWriteLog({ capacity: 1 })); // a tiny ring
    const a = s.client();
    const b = s.client();
    const seen: string[] = [];
    a.subscribeWrites((w) => seen.push(...w.map((x) => x.text)));

    for (const id of [1, 2, 3, 4]) {
      await b.mutate(`INSERT (:Widget {id: ${id}})`);
    }

    // The ring bounds CATCH-UP, not live delivery — a live subscriber sees them all.
    expect(seen).toEqual([1, 2, 3, 4].map((id) => `INSERT (:Widget {id: ${id}})`));
  });

  test('interleaved writes from multiple writers arrive in seq order', async () => {
    const s = server();
    const watcher = s.client();
    const b = s.client();
    const c = s.client();
    const seen: string[] = [];
    watcher.subscribeWrites((w) => seen.push(...w.map((x) => x.text)));

    await b.mutate('INSERT (:Widget {id: 1})');
    await c.mutate('INSERT (:Widget {id: 2})');
    await b.mutate('INSERT (:Widget {id: 3})');
    await c.mutate('INSERT (:Widget {id: 4})');

    expect(seen).toEqual([1, 2, 3, 4].map((id) => `INSERT (:Widget {id: ${id}})`));
  });

  test('subscribeWrites against a host with no writeLog is a silent no-op', async () => {
    const store = newStore();
    const link: { c?: SyncClient } = {};
    const host = createSyncHost(store, { send: (m) => link.c?.receive(m) }); // NO writeLog
    link.c = createSyncClient({ send: (m) => host.receive(m) });
    const seen: SyncWrite[] = [];
    link.c.subscribeWrites((w) => seen.push(...w));

    await link.c.mutate('INSERT (:Widget {id: 1})'); // the mutate still works…

    expect(seen).toEqual([]); // …but no CDC is delivered
    expect(widgets(store)).toBe(1);
  });

  test("interest routing: only writes touching the client's subscription deps are forwarded", () => {
    const store = newStore();
    const writeLog = createWriteLog();
    const sent: HostMessage[] = [];
    const host = createSyncHost(store, { send: (m) => sent.push(m), writeLog });

    // The client declares a live query over :User (deps ['User']) + opts into CDC.
    host.receive({
      type: 'subscribe',
      sub: 's1',
      query: 'MATCH (u:User) RETURN u.id',
      deps: ['User'],
    });
    host.receive({ type: 'subscribeWrites' });
    sent.length = 0; // drop the setup pushes

    // Another participant commits a User write and a Team write to the shared log.
    const other = writeLog.register();
    writeLog.append(other, { text: 'INSERT (:User {id: 1})' }, ['User']);
    writeLog.append(other, { text: 'INSERT (:Team {id: 1})' }, ['Team']);

    const forwarded = sent
      .filter((m): m is WritesMessage => m.type === 'writes')
      .flatMap((m) => m.writes.map((w) => w.text));
    expect(forwarded).toEqual(['INSERT (:User {id: 1})']); // the Team write is filtered out
  });

  test('dedupe: a re-sent write (same req) applies once across a reconnect', () => {
    const store = newStore();
    const dedup = createDedupRegistry();
    const writeLog = createWriteLog();
    const sent1: HostMessage[] = [];
    const sent2: HostMessage[] = [];
    const h1 = createSyncHost(store, { send: (m) => sent1.push(m), dedup, writeLog });
    const h2 = createSyncHost(store, { send: (m) => sent2.push(m), dedup, writeLog });

    const req = 'm-client-1';
    h1.receive({ type: 'mutate', req, text: 'INSERT (:Widget {id: 1})' }); // lands on conn 1
    h2.receive({ type: 'mutate', req, text: 'INSERT (:Widget {id: 1})' }); // replayed on conn 2 (lost ack)

    expect(widgets(store)).toBe(1); // applied exactly once
    expect(writeLog.head()).toBe(1); // and broadcast exactly once (no double CDC)
    expect([...sent1, ...sent2].filter((m) => m.type === 'ack' && m.ok).length).toBe(2); // both acked ok
  });

  test('dedupe: distinct writes both apply; a failed write is not recorded', () => {
    const store = newStore();
    const dedup = createDedupRegistry();
    const sent: HostMessage[] = [];
    const h = createSyncHost(store, { send: (m) => sent.push(m), dedup });

    h.receive({ type: 'mutate', req: 'm-a-1', text: 'INSERT (:Widget {id: 1})' });
    h.receive({ type: 'mutate', req: 'm-a-2', text: 'INSERT (:Widget {id: 2})' });
    expect(widgets(store)).toBe(2); // distinct reqs → both apply

    h.receive({ type: 'mutate', req: 'm-a-3', text: 'NOT VALID GQL' });
    expect(sent.some((m) => m.type === 'ack' && !m.ok)).toBe(true); // failed
    expect(dedup.seen('m-a-3')).toBe(false); // not recorded → a retry can still apply
  });
});

// The ordering/idempotence guard is pure client logic — drive receive() directly,
// so these run without the native lib.
describe('CDC write stream — client ordering guard (transport-free)', () => {
  test('a duplicate or stale batch is ignored; the cursor never regresses', () => {
    const sent: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => sent.push(m) });
    const seen: string[] = [];
    client.subscribeWrites((w) => seen.push(...w.map((x) => x.text)));

    client.receive({ type: 'writes', writes: [{ text: 'a' }], cursor: 1 });
    client.receive({ type: 'writes', writes: [{ text: 'a-dup' }], cursor: 1 }); // duplicate seq
    client.receive({ type: 'writes', writes: [{ text: 'stale' }], cursor: 0 }); // stale (< cursor)
    client.receive({ type: 'writes', writes: [{ text: 'b' }], cursor: 2 });

    expect(seen).toEqual(['a', 'b']); // duplicate + stale dropped, no double-apply

    // The cursor held at 2 (never regressed) — a resume asks from there.
    client.replay();
    expect(sent.filter((m) => m.type === 'subscribeWrites').at(-1)).toEqual({
      type: 'subscribeWrites',
      since: 2,
    });
  });

  test('a resync message fires onResync and moves the resume cursor', () => {
    const sent: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => sent.push(m) });
    let resynced = false;
    client.subscribeWrites(() => {}, { onResync: () => (resynced = true) });

    client.receive({ type: 'writes', writes: [], cursor: 42, resync: true });

    expect(resynced).toBe(true);
    client.replay();
    expect(sent.filter((m) => m.type === 'subscribeWrites').at(-1)).toEqual({
      type: 'subscribeWrites',
      since: 42,
    });
  });

  test('mutate reqs are globally unique (stable per-client prefix, for dedupe)', () => {
    const sentA: ClientMessage[] = [];
    const sentB: ClientMessage[] = [];
    const a = createSyncClient({ send: (m) => sentA.push(m) });
    const b = createSyncClient({ send: (m) => sentB.push(m) });
    void a.mutate('INSERT (:W)');
    void b.mutate('INSERT (:W)');

    const reqOf = (sent: ClientMessage[]): string =>
      (sent.find((m) => m.type === 'mutate') as { req: string }).req;
    // Two clients issuing "the same" write get distinct reqs → no false dedupe.
    expect(reqOf(sentA)).not.toEqual(reqOf(sentB));
  });
});
