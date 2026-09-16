// The exactly-once write path end to end: a window that drains on the client's
// own ack, refuses new work loudly when it is genuinely full, is namespaced by an
// authenticated principal so one client cannot answer for another, and keeps a
// restarted client's re-used sequence numbers apart from its previous session's.
//
// This is the one CDC path that fails CLOSED — a forgotten id re-applies a write
// and an over-remembered one drops it, both silently, both as wrong data — so
// each claim gets its own test rather than riding along in a broader one.
// Run: bun test packages/sync/src/exactly-once.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { createStore, graphFromNdjson, type Store } from '@lenke/native';
import { createFfiEngineBackend } from '@lenke/native/ffi-engine';

import { createSyncClient, type SyncClient } from './client.js';
import { createDedupRegistry, type DedupRegistry } from './dedup.js';
import { createSyncHost } from './host.js';
import type { ClientMessage, HostMessage, MutateMessage } from './protocol.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXT}`,
  import.meta.url,
).pathname;

const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(
    `[exactly-once.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`,
  );
}

const suite = hasLib ? describe : describe.skip;

const created: Store[] = [];

afterEach(() => {
  for (const store of created.splice(0)) {
    store.free();
  }
});

const newStore = (): Store => {
  const store = createStore(
    graphFromNdjson(createFfiEngineBackend(LIB), new TextEncoder().encode('')),
  );
  created.push(store);

  return store;
};

const widgets = (s: Store): number =>
  s.mutate((g) => g.query<{ c: number }>('MATCH (n:Widget) RETURN count(*) AS c'))[0].c;

/** One connection's host, with its own captured outbound messages. */
const connect = (store: Store, dedup: DedupRegistry, principal?: string) => {
  const sent: HostMessage[] = [];
  const host = createSyncHost(store, { send: (m) => sent.push(m), dedup, principal });

  return { host, sent };
};

/** A modern client's mutate message, spelled out so the host sees a real one. */
const write = (
  clientId: string,
  epoch: string,
  seq: number,
  ackedThrough = 0,
  id = seq,
): MutateMessage => ({
  type: 'mutate',
  req: `m-${clientId}-${epoch}-${seq}`,
  text: `INSERT (:Widget {id: ${id}})`,
  clientId,
  dedup: { epoch, seq, ackedThrough },
});

const nacks = (sent: HostMessage[]): HostMessage[] => sent.filter((m) => m.type === 'ack' && !m.ok);

suite('exactly-once writes (host + registry)', () => {
  test('a full window refuses the write instead of evicting an id it still needs', () => {
    const store = newStore();
    const dedup = createDedupRegistry({ capacity: 2 });
    const { host, sent } = connect(store, dedup);

    host.receive(write('a', 'e1', 1));
    host.receive(write('a', 'e1', 2));
    expect(widgets(store)).toBe(2);
    expect(nacks(sent)).toHaveLength(0);

    // Nothing has been acked, so the window is full. The old registry evicted
    // seq 1 here and a later replay of it double-applied; now the write is
    // refused and the client hears about it.
    host.receive(write('a', 'e1', 3));
    expect(widgets(store)).toBe(2); // not applied
    expect(nacks(sent)).toHaveLength(1);

    const [nack] = nacks(sent);
    expect(nack.type === 'ack' && nack.error?.code).toBe('E_RESOURCE_EXHAUSTED');

    // And the ids it was protecting are still there: a replay of seq 1 re-acks
    // without re-applying, which is the whole point of refusing.
    host.receive(write('a', 'e1', 1));
    expect(widgets(store)).toBe(2);
  });

  test("the client's ack is what reopens the window", () => {
    const store = newStore();
    const dedup = createDedupRegistry({ capacity: 2 });
    const { host, sent } = connect(store, dedup);

    host.receive(write('a', 'e1', 1));
    host.receive(write('a', 'e1', 2));
    // Same third write, but now the client reports both earlier ones resolved.
    host.receive(write('a', 'e1', 3, 2));

    expect(widgets(store)).toBe(3);
    expect(nacks(sent)).toHaveLength(0);
  });

  test('a replayed write applies once across a reconnect, then re-acks', () => {
    const store = newStore();
    const dedup = createDedupRegistry();
    const one = connect(store, dedup);
    const two = connect(store, dedup); // the reconnect: a different host, same registry

    one.host.receive(write('a', 'e1', 1));
    two.host.receive(write('a', 'e1', 1)); // the ack was lost; the client re-sent

    expect(widgets(store)).toBe(1);
    expect(two.sent.filter((m) => m.type === 'ack' && m.ok)).toHaveLength(1);
  });

  test('a principal cannot be spoken for by another principal', () => {
    const store = newStore();
    const dedup = createDedupRegistry();
    const alice = connect(store, dedup, 'alice');
    const mallory = connect(store, dedup, 'mallory');

    // Mallory sends a write whose identity is guessed to collide with Alice's
    // next one. Unnamespaced, this would poison the window: Alice's genuine write
    // arrives, is called a duplicate, and is dropped WITHOUT applying.
    mallory.host.receive(write('a', 'e1', 1, 0, 99));
    expect(widgets(store)).toBe(1);

    alice.host.receive(write('a', 'e1', 1, 0, 1));
    expect(widgets(store)).toBe(2); // Alice's write applied — not swallowed

    // Alice's own replay still dedupes inside her namespace.
    alice.host.receive(write('a', 'e1', 1, 0, 1));
    expect(widgets(store)).toBe(2);
  });

  test('a restarted client is not deduped against its previous session', () => {
    const store = newStore();
    const dedup = createDedupRegistry();
    const { host } = connect(store, dedup);

    host.receive(write('a', 'epoch-1', 1, 0, 1));
    expect(widgets(store)).toBe(1);

    // Same persisted clientId (it is the origin-skip key, so clients are told to
    // keep it), fresh instance, counter back to 1. Without the epoch these new writes
    // would be silently swallowed as duplicates of the last session's.
    host.receive(write('a', 'epoch-2', 1, 0, 2));
    expect(widgets(store)).toBe(2);
  });

  test('a legacy client (no dedup block) still dedupes across a reconnect', () => {
    const store = newStore();
    const dedup = createDedupRegistry();
    const one = connect(store, dedup);
    const two = connect(store, dedup);

    one.host.receive({ type: 'mutate', req: 'm-legacy-1', text: 'INSERT (:Widget {id: 1})' });
    two.host.receive({ type: 'mutate', req: 'm-legacy-1', text: 'INSERT (:Widget {id: 1})' });

    expect(widgets(store)).toBe(1);
  });
});

suite('exactly-once writes (client wire shape)', () => {
  /** A client whose outbound messages are captured and whose acks we drive. */
  const harness = (clientId?: string) => {
    const sent: ClientMessage[] = [];
    const client: SyncClient = createSyncClient({ send: (m) => sent.push(m), clientId });
    const mutates = (): MutateMessage[] =>
      sent.filter((m): m is MutateMessage => m.type === 'mutate');
    const ack = (req: string, ok = true): void =>
      client.receive(
        ok
          ? { type: 'ack', req, ok: true }
          : { type: 'ack', req, ok: false, error: { code: 'E_SYNTAX', message: 'no' } },
      );

    return { client, sent, mutates, ack };
  };

  test('every write carries a session epoch and a contiguous sequence', () => {
    const h = harness('c1');
    void h.client.mutate('INSERT (:Widget {id: 1})');
    void h.client.mutate('INSERT (:Widget {id: 2})');

    const [one, two] = h.mutates();
    expect(one.dedup?.seq).toBe(1);
    expect(two.dedup?.seq).toBe(2);
    expect(one.dedup?.epoch).toBe(two.dedup!.epoch); // one epoch per instance
    expect(one.dedup?.epoch).not.toBe(''); // and it is actually populated
    // The sequence is the WRITE counter, not the shared request counter — a query
    // in between must not leave a gap the server cannot reason about.
    expect(one.req).not.toBe(two.req);
  });

  test('ackedThrough advances only contiguously, and a rejection counts as resolved', async () => {
    const h = harness('c1');
    const first = h.client.mutate('INSERT (:Widget {id: 1})');
    const second = h.client.mutate('INSERT (:Widget {id: 2})');
    const [one, two] = h.mutates();

    // Ack the SECOND write first: nothing is contiguous yet, so the mark holds.
    h.ack(two.req);
    await second;
    void h.client.mutate('INSERT (:Widget {id: 3})');
    expect(h.mutates()[2].dedup?.ackedThrough).toBe(0);

    // A rejected write is resolved too — the promise rejects and it is never
    // re-sent — so acking seq 1 with ok:false closes the gap through seq 2.
    h.ack(one.req, false);
    // The rejection is the point; swallow it so the run has no unhandled one.
    await first.then(
      () => expect.unreachable('a nacked write must reject'),
      () => undefined,
    );
    void h.client.mutate('INSERT (:Widget {id: 4})');
    expect(h.mutates()[3].dedup?.ackedThrough).toBe(2);
  });

  test('a replayed write keeps its identity but carries a fresh ackedThrough', async () => {
    const h = harness('c1');
    const first = h.client.mutate('INSERT (:Widget {id: 1})');
    const second = h.client.mutate('INSERT (:Widget {id: 2})');
    const [one, two] = h.mutates();

    h.ack(one.req);
    await first;

    // seq 2 is still unacked, so a reconnect replays it.
    h.client.replay();

    const replayed = h.mutates().at(-1)!;
    expect(replayed.req).toBe(two.req); // same logical write…
    expect(replayed.dedup?.seq).toBe(2);
    expect(replayed.dedup?.ackedThrough).toBe(1); // …but the window can move on

    h.ack(two.req);
    await second;
  });
});
