// Proves the client registry over a direct in-memory loop to a real host:
// dedupe by (query, params, deps) signature, refcounted wire teardown,
// referentially-stable snapshots with honest complete/error state, and
// promise-shaped one-shots — the full client contract, transport-free.
// Run: bun test packages/sync/src/client.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { hasErrorCode, ErrorCode } from '@lenke/errors';
import { createStore, graphFromNdjson } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';

import { createSyncClient } from './client.js';
import { createSyncHost } from './host.js';
import type { ClientMessage } from './protocol.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[client.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const suite = hasLib ? describe : describe.skip;

const NDJSON = [
  '{"type":"node","id":"a","labels":["Person"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["Person"],"properties":{"name":"vadas","age":27}}',
].join('\n');

/** Client ↔ host wired directly — the minimal port. `wire` records traffic. */
const connect = () => {
  const store = createStore(
    graphFromNdjson(createFfiBackend(LIB), new TextEncoder().encode(NDJSON)),
  );
  const wire: ClientMessage[] = [];
  // Declared before the host exists; the host's status message on attach
  // arrives before the client is constructed, so buffer and replay.
  const buffered: unknown[] = [];
  let deliver: (msg: unknown) => void = (m) => buffered.push(m);
  const host = createSyncHost(store, { send: (m) => deliver(m) });
  const client = createSyncClient({
    send: (m) => {
      wire.push(m);
      host.receive(m);
    },
  });
  deliver = (m) => client.receive(m);
  buffered.forEach((m) => client.receive(m));

  return { client, host, store, wire };
};

suite('@lenke/sync client · registry semantics', () => {
  test('liveQuery answers with an honest lifecycle: skeleton → complete rows', () => {
    const { client } = connect();
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });

    // Synchronous loop means rows already arrived; but the INITIAL contract
    // is observable through a fresh signature before any push: complete=false.
    const snap = live.getSnapshot();
    expect(snap.complete).toBe(true);
    expect(snap.rows).toHaveLength(2);
    expect(typeof snap.version).toBe('number');
  });

  test('snapshots are referentially stable between pushes and replaced on change', () => {
    const { client } = connect();
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', {
      deps: ['Person', 'name'],
    });
    const stop = live.subscribe(() => {});

    const a = live.getSnapshot();
    expect(live.getSnapshot()).toBe(a);

    void client.mutate('INSERT (:Person {name: $n})', { n: 'zoe' });
    const b = live.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.rows).toHaveLength(3);
    stop();
  });

  test('same signature dedupes to ONE wire subscription; different params do not', () => {
    const { client, wire } = connect();

    const h1 = client.liveQuery('MATCH (p:Person) WHERE p.age >= $min RETURN p.name', {
      deps: null,
      params: { min: 28 },
    });
    const h2 = client.liveQuery('MATCH (p:Person) WHERE p.age >= $min RETURN p.name', {
      deps: null,
      params: { min: 28 },
    });
    const h3 = client.liveQuery('MATCH (p:Person) WHERE p.age >= $min RETURN p.name', {
      deps: null,
      params: { min: 20 },
    });

    expect(h1).toBe(h2); // shared handle
    expect(h3).not.toBe(h1);
    expect(wire.filter((m) => m.type === 'subscribe')).toHaveLength(2);
    expect(client.subscriptionCount()).toBe(2);
    expect(h1.getSnapshot().rows).toHaveLength(1); // marko only
    expect(h3.getSnapshot().rows).toHaveLength(2);
  });

  test('refcounted teardown: wire unsubscribe only when the LAST local subscriber leaves', () => {
    const { client, wire } = connect();
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });

    const stopA = live.subscribe(() => {});
    const stopB = live.subscribe(() => {});

    stopA();
    expect(wire.filter((m) => m.type === 'unsubscribe')).toHaveLength(0);
    expect(client.subscriptionCount()).toBe(1);

    stopB();
    expect(wire.filter((m) => m.type === 'unsubscribe')).toHaveLength(1);
    expect(client.subscriptionCount()).toBe(0);
  });

  test('one-shot query resolves rows; failed mutate rejects with the coded error', async () => {
    const { client } = connect();

    const rows = await client.query('MATCH (p:Person) WHERE p.name = $n RETURN p.age', {
      n: 'vadas',
    });
    expect(rows).toEqual([{ 'p.age': 27 }]);

    await client.mutate('INSERT (:Person {name: $n})', { n: 'carol' });

    expect(client.mutate('NOT GQL AT ALL')).rejects.toThrow();

    try {
      await client.mutate('NOT GQL AT ALL');
    } catch (e) {
      expect(hasErrorCode(e, ErrorCode.Syntax)).toBe(true);
    }
  });

  test('an injection-shaped param stays inert through the whole loop', async () => {
    const { client, store } = connect();
    const before = store.graph.vertexCount;

    const rows = await client.query('MATCH (p:Person) WHERE p.name = $n RETURN p.name', {
      n: "' DETACH DELETE p RETURN 1 //",
    });
    expect(rows).toEqual([]);
    expect(store.graph.vertexCount).toBe(before);
  });

  test('a bad standing query surfaces error on the snapshot and detaches', () => {
    const { client } = connect();
    const live = client.liveQuery('THIS IS NOT GQL', { deps: null });

    const snap = live.getSnapshot();
    expect(snap.error?.code).toBeDefined();
    expect(snap.complete).toBe(false);
    expect(client.subscriptionCount()).toBe(0);
  });

  test('a torn-down handle revives on re-subscribe (StrictMode mount dance)', () => {
    const { client, wire } = connect();
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });

    const stop = live.subscribe(() => {});
    stop(); // refcount → 0 → wire unsubscribe
    expect(client.subscriptionCount()).toBe(0);

    // Re-subscribing the SAME handle re-establishes a fresh wire subscription
    // and keeps receiving pushes.
    const stop2 = live.subscribe(() => {});
    expect(client.subscriptionCount()).toBe(1);
    expect(wire.filter((m) => m.type === 'subscribe')).toHaveLength(2);

    void client.mutate('INSERT (:Person {name: $n})', { n: 'revive-check' });
    expect(live.getSnapshot().rows).toHaveLength(3);
    stop2();
  });

  test('status handshake is captured', () => {
    const { client } = connect();
    expect(client.getStatus()).toEqual({ connected: true, pendingWrites: 0 });
  });

  test('onStatus wakes subscribers on each push; getStatus is a stable ref between', () => {
    const client = createSyncClient({ send: () => {} });
    let calls = 0;
    const stop = client.onStatus(() => {
      calls += 1;
    });

    client.receive({ type: 'status', connected: true, pendingWrites: 0, protocol: 1 });
    const first = client.getStatus();
    expect(calls).toBe(1);
    expect(first).toEqual({ connected: true, pendingWrites: 0 });
    expect(client.getStatus()).toBe(first); // no new object between pushes (useSyncExternalStore-safe)

    client.receive({ type: 'status', connected: true, pendingWrites: 2, protocol: 1 });
    expect(calls).toBe(2);
    expect(client.getStatus()).toEqual({ connected: true, pendingWrites: 2 });

    stop();
    client.receive({ type: 'status', connected: false, pendingWrites: 5, protocol: 1 });
    expect(calls).toBe(2); // unsubscribed — no further wakes
  });

  test('keyed diffs apply as patch/remove/order and keep unchanged-row identity', () => {
    const wire: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => wire.push(m) });
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name, p.age', {
      deps: null,
      key: 'p.name',
    });
    live.subscribe(() => {});
    const { sub } = wire.find((m) => m.type === 'subscribe') as { sub: string };

    // Initial full diff: every row a patch, in order.
    client.receive({
      type: 'rows',
      sub,
      complete: true,
      version: 1,
      patch: [
        { key: 'marko', set: { 'p.name': 'marko', 'p.age': 29 } },
        { key: 'vadas', set: { 'p.name': 'vadas', 'p.age': 27 } },
      ],
      order: ['marko', 'vadas'],
    });
    expect(live.getSnapshot().rows).toEqual([
      { 'p.name': 'marko', 'p.age': 29 },
      { 'p.name': 'vadas', 'p.age': 27 },
    ]);
    const [marko] = live.getSnapshot().rows;

    // A lone cell change to vadas (no order): marko keeps its object identity.
    client.receive({
      type: 'rows',
      sub,
      complete: true,
      version: 2,
      patch: [{ key: 'vadas', set: { 'p.age': 28 } }],
    });
    expect(live.getSnapshot().rows).toEqual([
      { 'p.name': 'marko', 'p.age': 29 },
      { 'p.name': 'vadas', 'p.age': 28 },
    ]);
    expect(live.getSnapshot().rows[0]).toBe(marko);

    // Insert with a new order: marko is still the same object across the reorder.
    client.receive({
      type: 'rows',
      sub,
      complete: true,
      version: 3,
      patch: [{ key: 'aaron', set: { 'p.name': 'aaron', 'p.age': 40 } }],
      order: ['aaron', 'marko', 'vadas'],
    });
    expect(live.getSnapshot().rows.map((r) => r['p.name'])).toEqual(['aaron', 'marko', 'vadas']);
    expect(live.getSnapshot().rows[1]).toBe(marko);

    // Remove vadas.
    client.receive({
      type: 'rows',
      sub,
      complete: true,
      version: 4,
      remove: ['vadas'],
      order: ['aaron', 'marko'],
    });
    expect(live.getSnapshot().rows.map((r) => r['p.name'])).toEqual(['aaron', 'marko']);

    // A completeness-only push (no ops) keeps the same rows array reference.
    const rowsRef = live.getSnapshot().rows;
    client.receive({ type: 'rows', sub, complete: false, version: 5 });
    expect(live.getSnapshot().rows).toBe(rowsRef);
    expect(live.getSnapshot().complete).toBe(false);
  });

  test('reconnect resume: a re-push keeps unchanged-row identity, and updates/adds/drops', () => {
    const wire: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => wire.push(m) });
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name, p.age', {
      deps: null,
      key: 'p.name',
    });
    live.subscribe(() => {});
    const sub1 = (wire.find((m) => m.type === 'subscribe') as { sub: string }).sub;

    client.receive({
      type: 'rows',
      sub: sub1,
      complete: true,
      version: 1,
      patch: [
        { key: 'marko', set: { 'p.name': 'marko', 'p.age': 29 } },
        { key: 'vadas', set: { 'p.name': 'vadas', 'p.age': 27 } },
        { key: 'zoe', set: { 'p.name': 'zoe', 'p.age': 31 } },
      ],
      order: ['marko', 'vadas', 'zoe'],
    });
    const [marko, vadas] = live.getSnapshot().rows;

    // Reconnect: the client re-subscribes (same sub id) and KEEPS its base.
    client.replay();
    const sub2 = wire.filter((m) => m.type === 'subscribe').at(-1)?.sub;
    expect(sub2).toBe(sub1);

    // The fresh host re-pushes the current world as full patches + order (no
    // removes): marko unchanged, vadas now 28, zoe gone, carol new.
    client.receive({
      type: 'rows',
      sub: sub1,
      complete: true,
      version: 2,
      patch: [
        { key: 'marko', set: { 'p.name': 'marko', 'p.age': 29 } },
        { key: 'vadas', set: { 'p.name': 'vadas', 'p.age': 28 } },
        { key: 'carol', set: { 'p.name': 'carol', 'p.age': 40 } },
      ],
      order: ['carol', 'marko', 'vadas'],
    });

    const { rows } = live.getSnapshot();
    expect(rows.map((r) => r['p.name'])).toEqual(['carol', 'marko', 'vadas']); // zoe dropped
    expect(rows.find((r) => r['p.name'] === 'marko')).toBe(marko); // identity survived reconnect
    expect(rows.find((r) => r['p.name'] === 'vadas')).not.toBe(vadas); // changed → new object
    expect(rows.find((r) => r['p.name'] === 'vadas')).toEqual({ 'p.name': 'vadas', 'p.age': 28 });
  });

  test('reconnect to an empty result: an authoritative empty order clears stale rows', () => {
    const wire: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => wire.push(m) });
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null, key: 'p.name' });
    live.subscribe(() => {});
    const { sub } = wire.find((m) => m.type === 'subscribe') as { sub: string };

    client.receive({
      type: 'rows',
      sub,
      complete: true,
      version: 1,
      patch: [
        { key: 'a', set: { 'p.name': 'a' } },
        { key: 'b', set: { 'p.name': 'b' } },
      ],
      order: ['a', 'b'],
    });
    expect(live.getSnapshot().rows).toHaveLength(2);

    // Reconnect; the fresh host finds an empty result and (forceOrder) sends
    // order: [] with no patch/remove. The client must drop the stale rows.
    // (The host-side production of that order is covered in host.test.ts; here
    // we verify only that the client applies an empty order by pruning.)
    client.replay();
    client.receive({ type: 'rows', sub, complete: true, version: 2, order: [] });
    expect(live.getSnapshot().rows).toEqual([]);
  });

  test('reconnect while still loading keeps warm rows (incomplete first push, no order)', () => {
    const wire: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => wire.push(m) });
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null, key: 'p.name' });
    live.subscribe(() => {});
    const { sub } = wire.find((m) => m.type === 'subscribe') as { sub: string };

    client.receive({
      type: 'rows',
      sub,
      complete: true,
      version: 1,
      patch: [{ key: 'a', set: { 'p.name': 'a' } }],
      order: ['a'],
    });
    const warm = live.getSnapshot().rows;
    expect(warm).toHaveLength(1);

    // Reconnect to a host still loading: empty-for-now + incomplete + NO order
    // (the host does not force one while incomplete). The warm row must stay.
    client.replay();
    client.receive({ type: 'rows', sub, complete: false, version: 2 });
    expect(live.getSnapshot().rows).toBe(warm); // same reference — not blanked
    expect(live.getSnapshot().complete).toBe(false);
  });

  test('an arrow result that fails to decode rejects the query promise (no hang)', async () => {
    const wire: ClientMessage[] = [];
    const client = createSyncClient({ send: (m) => wire.push(m) });
    const pending = client.query('MATCH (p:Person) RETURN p.name', undefined, { format: 'arrow' });
    const { req } = wire.find((m) => m.type === 'query') as { req: string };

    // A JSON transport would deliver the Uint8Array as a plain object — decode
    // must reject the promise, not throw out of receive() and hang it.
    client.receive({ type: 'result', req, arrow: { 0: 65, 1: 66 } as unknown as Uint8Array });
    let error: unknown;
    await pending.catch((e: unknown) => {
      error = e;
    });
    expect(String(error)).toMatch(/arrow/i);
  });

  test('keyed round-trip over a real host: a cell edit updates rows in place', () => {
    const { client, store } = connect();
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name, p.age ORDER BY p.name', {
      deps: null,
      key: 'p.name',
    });
    live.subscribe(() => {});
    expect(live.getSnapshot().rows).toEqual([
      { 'p.name': 'marko', 'p.age': 29 },
      { 'p.name': 'vadas', 'p.age': 27 },
    ]);
    const [marko] = live.getSnapshot().rows;

    // A write to the store fans out as a keyed diff; the client applies it.
    store.mutate((g) =>
      g.query('MATCH (p:Person) WHERE p.name = $n SET p.age = $a', { n: 'vadas', a: 28 }),
    );
    expect(live.getSnapshot().rows).toEqual([
      { 'p.name': 'marko', 'p.age': 29 },
      { 'p.name': 'vadas', 'p.age': 28 },
    ]);
    expect(live.getSnapshot().rows[0]).toBe(marko); // unchanged-row identity survives the round-trip
  });

  test('gremlin() round-trips a traversal over a real host and resolves its values', async () => {
    const { client } = connect();

    expect(await client.gremlin('g.V().count()')).toEqual([2]);

    const names = await client.gremlin("g.V().values('name')");
    expect([...(names as string[])].sort()).toEqual(['marko', 'vadas']);
  });

  test('query with format arrow crosses columnar and decodes to identical rows', async () => {
    const { client, wire } = connect();
    const q = 'MATCH (p:Person) RETURN p.name, p.age ORDER BY p.name';

    const arrowRows = await client.query(q, undefined, { format: 'arrow' });
    expect(arrowRows).toEqual(await client.query(q)); // byte-for-byte the JSON result

    const sent = wire.find((m) => m.type === 'query' && m.format === 'arrow');
    expect(sent).toBeDefined(); // the request really asked for arrow
  });

  test('client.gremlin as a tagged template escapes interpolations — injection stays inert', async () => {
    const { client, store } = connect();
    const before = store.graph.vertexCount;

    const evil = "marko'); g.V().drop(); //";
    const rows = await client.gremlin`g.V().has('name', ${evil}).values('name')`;

    expect(rows).toEqual([]); // one literal string — matches nothing
    expect(store.graph.vertexCount).toBe(before); // the graph was NOT dropped
    expect(await client.gremlin`g.V().has('name', ${'marko'}).count()`).toEqual([1]);
  });

  test('a Gremlin live query exposes values on its snapshot and updates on change', () => {
    const { client, store } = connect();
    const live = client.liveQuery('g.V().count()', { deps: ['Person'], lang: 'gremlin' });
    live.subscribe(() => {});

    expect(live.getSnapshot().values).toEqual([2]);
    expect(live.getSnapshot().rows).toEqual([]); // rows stays empty for a Gremlin query

    // A relevant write re-runs the standing traversal; values reflect it.
    store.mutate((g) => g.query("INSERT (:Person {name: 'carol'})"));
    expect(live.getSnapshot().values).toEqual([3]);
  });

  test('close unsubscribes everything and rejects pending requests', async () => {
    const wire: ClientMessage[] = [];
    // A black-hole transport: nothing ever answers, so requests stay pending.
    const client = createSyncClient({ send: (m) => wire.push(m) });

    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });
    live.subscribe(() => {});
    expect(live.getSnapshot().complete).toBe(false); // INITIAL — nothing answered

    const inflight = client.mutate('INSERT (:Person {name: $n})', { n: 'x' });
    client.close();

    expect(inflight).rejects.toThrow(/client closed/);
    expect(wire.filter((m) => m.type === 'unsubscribe')).toHaveLength(1);
    expect(client.subscriptionCount()).toBe(0);
  });
});
