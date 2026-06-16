// Proves the reactive store satisfies the useSyncExternalStore contract:
// getSnapshot is referentially stable until a *relevant* mutation, version-gated
// caching works, finer (per-token) invalidation skips unaffected queries, and
// subscribers fire on mutate. Run: bun test packages/native/src/store.test.ts
import { describe, expect, test } from 'bun:test';

import { createFfiBackend } from './backend-ffi.js';
import { graphFromNdjson } from './graph.js';
import { createStore, inferDeps } from './store.js';

const LIB = new URL(
  '../../../crates/pl-graph-core/target/release/libpl_graph_core.dylib',
  import.meta.url,
).pathname;

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}',
].join('\n');

const newStore = () => {
  const backend = createFfiBackend(LIB);
  const g = graphFromNdjson(backend, new TextEncoder().encode(NDJSON));
  return createStore(g);
};

describe('@pl-graph/native reactive store', () => {
  test('getSnapshot is referentially stable with no mutation', () => {
    const store = newStore();
    const names = store.liveQuery('MATCH (n:P) RETURN n.name ORDER BY n.name');
    const s1 = names.getSnapshot();
    const s2 = names.getSnapshot();
    expect(s1).toBe(s2); // same reference → React won't loop
    expect(s1).toEqual([{ 'n.name': 'marko' }, { 'n.name': 'vadas' }]);
    store.graph.free();
  });

  test('mutate bumps version, notifies, and changes the snapshot', () => {
    const store = newStore();
    const ages = store.liveQuery('MATCH (n:P) RETURN n.age ORDER BY n.age', { deps: ['P', 'age'] });
    const before = ages.getSnapshot();
    const v0 = store.version;

    let fired = 0;
    const unsub = ages.subscribe(() => {
      fired += 1;
    });
    store.mutate((g) => g.query("MATCH (n:P) WHERE n.name = 'marko' SET n.age = 99"));

    expect(store.version).toBeGreaterThan(v0);
    expect(fired).toBe(1);
    const after = ages.getSnapshot();
    expect(after).not.toBe(before); // an `age` dep moved → new snapshot
    expect(after).toEqual([{ 'n.age': 27 }, { 'n.age': 99 }]);
    unsub();
    store.graph.free();
  });

  test('finer invalidation: an unaffected query keeps its snapshot reference', () => {
    const store = newStore();
    const names = store.liveQuery('MATCH (n:P) RETURN n.name ORDER BY n.name', {
      deps: ['P', 'name'],
    });
    const before = names.getSnapshot();

    // mutate only `age` — the names query depends on P + name, not age
    store.mutate((g) => g.query("MATCH (n:P) WHERE n.name = 'marko' SET n.age = 99"));

    const after = names.getSnapshot();
    expect(after).toBe(before); // version moved, but our deps didn't → same ref
    store.graph.free();
  });

  test('coarse mode (no deps) recomputes on any mutation', () => {
    const store = newStore();
    const all = store.liveQuery('MATCH (n:P) RETURN n.name ORDER BY n.name'); // no deps
    const before = all.getSnapshot();
    store.mutate((g) => g.query("MATCH (n:P) WHERE n.name = 'marko' SET n.age = 99"));
    const after = all.getSnapshot();
    expect(after).not.toBe(before); // coarse: any mutation invalidates
    expect(after).toEqual(before); // ...but the names are unchanged
    store.graph.free();
  });

  test('a read-only mutate() call does not notify', () => {
    const store = newStore();
    const q = store.liveQuery('MATCH (n:P) RETURN n.name');
    let fired = 0;
    q.subscribe(() => {
      fired += 1;
    });
    const v0 = store.version;
    store.mutate((g) => g.query('MATCH (n:P) RETURN n.name')); // read-only
    expect(store.version).toBe(v0);
    expect(fired).toBe(0);
    store.graph.free();
  });

  test('inferDeps extracts labels and property keys', () => {
    expect(
      inferDeps('MATCH (a:Person)-[:KNOWS]->(b) WHERE a.age > 30 RETURN a.name').sort(),
    ).toEqual(['KNOWS', 'Person', 'age', 'name']);
  });
});
