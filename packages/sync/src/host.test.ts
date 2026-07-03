// Proves the live-query host speaks protocol v1 correctly over a bare
// send/receive pair (transport-free): subscribe pushes now and on change,
// epoch gating suppresses irrelevant pushes, re-subscribe replaces, mutate
// acks and fans out to every host on the store, and errors ride the coded
// wire shape. Run: bun test packages/sync/src/host.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { createStore, graphFromNdjson, type Store } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';

import { createSyncHost } from './host.js';
import type { HostMessage, RowsMessage } from './protocol.js';

// Host-specific shared-library extension; `build:rust` emits this platform's.
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;

// Built by `bun run build:rust`, not the test — skip cleanly when it's absent.
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[host.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const suite = hasLib ? describe : describe.skip;

const NDJSON = [
  '{"type":"node","id":"a","labels":["Person"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["Person"],"properties":{"name":"vadas","age":27}}',
  '{"type":"edge","id":"e0","from":"a","to":"b","labels":["KNOWS"],"properties":{}}',
].join('\n');

const newStore = (): Store => {
  const backend = createFfiBackend(LIB);

  return createStore(graphFromNdjson(backend, new TextEncoder().encode(NDJSON)));
};

/** A host wired to a capture buffer — the minimal "connection". */
const attach = (store: Store) => {
  const sent: HostMessage[] = [];
  const host = createSyncHost(store, { send: (m) => sent.push(m) });

  return { host, sent, take: () => sent.splice(0, sent.length) };
};

const rowsOf = (m: HostMessage): RowsMessage => {
  expect(m.type).toBe('rows');

  return m as RowsMessage;
};

suite('@lenke/sync host · protocol v1', () => {
  test('announces status on attach', () => {
    const { sent } = attach(newStore());

    expect(sent[0]).toEqual({ type: 'status', connected: true, pendingWrites: 0, protocol: 1 });
  });

  test('subscribe answers immediately with rows + version + complete', () => {
    const { host, take } = attach(newStore());
    take();

    host.receive({
      type: 'subscribe',
      sub: 's1',
      query: 'MATCH (p:Person) RETURN p.name ORDER BY p.name',
    });

    const [msg] = take();
    const rows = rowsOf(msg);
    expect(rows.sub).toBe('s1');
    expect(rows.complete).toBe(true);
    expect(typeof rows.version).toBe('number');
    expect(rows.rows?.map((r) => r['p.name'] ?? Object.values(r)[0])).toEqual(['marko', 'vadas']);
  });

  test('a relevant mutation pushes fresh rows; an irrelevant one stays silent', () => {
    const store = newStore();
    const { host, take } = attach(store);

    host.receive({
      type: 'subscribe',
      sub: 's1',
      query: 'MATCH (p:Person) RETURN p.name',
      deps: ['Person', 'name'],
    });
    take();

    // Irrelevant: touches `age`, not `name` — epoch gating keeps the wire quiet.
    host.receive({
      type: 'mutate',
      req: 'm1',
      gql: "MATCH (p:Person) WHERE p.name = 'marko' SET p.age = 30",
    });
    let msgs = take();
    expect(msgs).toEqual([{ type: 'ack', req: 'm1', ok: true }]);

    // Relevant: a new Person name — the subscription hears it.
    host.receive({ type: 'mutate', req: 'm2', gql: "INSERT (:Person {name: 'zoe'})" });
    msgs = take();
    expect(msgs.map((m) => m.type).sort()).toEqual(['ack', 'rows']);
    const rows = rowsOf(msgs.find((m) => m.type === 'rows')!);
    expect(rows.rows).toHaveLength(3);
  });

  test('one connection’s write fans out to another host on the same store', () => {
    const store = newStore();
    const alice = attach(store);
    const bob = attach(store);

    alice.host.receive({ type: 'subscribe', sub: 'a', query: 'MATCH (p:Person) RETURN p.name' });
    alice.take();
    bob.take();

    bob.host.receive({ type: 'mutate', req: 'w', gql: "INSERT (:Person {name: 'carol'})" });

    expect(bob.take()).toEqual([{ type: 'ack', req: 'w', ok: true }]);
    const pushed = rowsOf(alice.take()[0]);
    expect(pushed.rows).toHaveLength(3);
  });

  test('unsubscribe stops pushes; close drops everything', () => {
    const store = newStore();
    const { host, take } = attach(store);

    host.receive({ type: 'subscribe', sub: 's1', query: 'MATCH (p:Person) RETURN p.name' });
    take();
    expect(host.subscriptionCount()).toBe(1);

    host.receive({ type: 'unsubscribe', sub: 's1' });
    store.mutate((g) => g.query("INSERT (:Person {name: 'dan'})"));
    expect(take()).toEqual([]);
    expect(host.subscriptionCount()).toBe(0);

    host.receive({ type: 'subscribe', sub: 's2', query: 'MATCH (p:Person) RETURN p.name' });
    host.close();
    expect(host.subscriptionCount()).toBe(0);
  });

  test('re-subscribing the same sub replaces the standing query', () => {
    const { host, take } = attach(newStore());

    host.receive({ type: 'subscribe', sub: 's', query: 'MATCH (p:Person) RETURN p.name' });
    host.receive({ type: 'subscribe', sub: 's', query: 'MATCH (p:Person) RETURN p.age' });
    expect(host.subscriptionCount()).toBe(1);
    take();

    host.receive({
      type: 'mutate',
      req: 'm',
      gql: "MATCH (p:Person) WHERE p.name = 'marko' SET p.age = 31",
    });
    const rows = rowsOf(take().find((m) => m.type === 'rows')!);
    expect(JSON.stringify(rows.rows)).toContain('31');
  });

  test('one-shot query answers result once and never subscribes', () => {
    const { host, take } = attach(newStore());
    take();

    host.receive({
      type: 'query',
      req: 'q1',
      query: 'MATCH (p:Person) RETURN p.name ORDER BY p.name',
    });

    const msgs = take();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('result');
    expect(host.subscriptionCount()).toBe(0);
  });

  test('a bad subscription query closes with a coded rows error', () => {
    const { host, take } = attach(newStore());
    take();

    host.receive({ type: 'subscribe', sub: 'bad', query: 'THIS IS NOT GQL' });

    const rows = rowsOf(take()[0]);
    expect(rows.error?.code).toBeDefined();
    expect(rows.rows).toBeUndefined();
    expect(host.subscriptionCount()).toBe(0);
  });

  test('a failed mutation acks ok:false with the stable code', () => {
    const { host, take } = attach(newStore());
    take();

    host.receive({ type: 'mutate', req: 'm', gql: 'ALSO NOT GQL' });

    const [ack] = take();
    expect(ack).toMatchObject({ type: 'ack', req: 'm', ok: false });
    expect((ack as { error?: { code: string } }).error?.code).toBeDefined();
  });

  test('params are rejected as reserved in v1', () => {
    const { host, take } = attach(newStore());
    take();

    host.receive({
      type: 'subscribe',
      sub: 's',
      query: 'MATCH (p:Person) RETURN p',
      params: { x: 1 },
    });
    host.receive({ type: 'query', req: 'q', query: 'MATCH (p:Person) RETURN p', params: { x: 1 } });

    const msgs = take();
    expect(rowsOf(msgs[0]).error?.code).toBe('Unsupported');
    expect(msgs[1]).toMatchObject({ type: 'result', req: 'q', error: { code: 'Unsupported' } });
    expect(host.subscriptionCount()).toBe(0);
  });

  test('unknown message tags are ignored (forward-compat)', () => {
    const { host, take } = attach(newStore());
    take();

    host.receive({ type: 'hello-from-the-future', anything: true });
    host.receive(null);
    host.receive('nonsense');

    expect(take()).toEqual([]);
  });
});
