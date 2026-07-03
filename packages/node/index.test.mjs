// Proves the napi addon is callable from Node and that its Backend adapter
// drives the whole @lenke/native facade. Run: node --test (from packages/node),
// after `napi build`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { graphFromNdjson, createStore } from '@lenke/native';

import { createNodeBackend } from './backend.mjs';
import addon from './index.js';

const { Graph, abiVersion } = addon;

const NDJSON = Buffer.from(
  [
    JSON.stringify({ type: 'node', id: 'n0', labels: ['Person'], properties: { name: 'marko', age: 29 } }),
    JSON.stringify({ type: 'node', id: 'n1', labels: ['Person'], properties: { name: 'vadas', age: 27 } }),
    JSON.stringify({ type: 'edge', id: 'e0', from: 'n0', to: 'n1', labels: ['KNOWS'], properties: {} }),
  ].join('\n'),
);
const dec = new TextDecoder();
const json = (buf) => JSON.parse(dec.decode(buf));

test('abiVersion matches the C ABI (8)', () => {
  assert.equal(abiVersion(), 8);
});

test('fromNdjson decodes counts', () => {
  const g = Graph.fromNdjson(NDJSON);
  assert.equal(g.vertexCount, 2);
  assert.equal(g.edgeCount, 1);
});

test('query returns the {columns, rows} document', () => {
  const g = Graph.fromNdjson(NDJSON);
  const doc = json(g.query('MATCH (p:Person) RETURN p.name'));
  assert.deepEqual(new Set(doc.rows.flat()), new Set(['marko', 'vadas']));
});

test('queryArrow returns an ARW1 columnar blob', () => {
  const g = Graph.fromNdjson(NDJSON);
  const blob = g.queryArrow('MATCH (p:Person) RETURN p.age');
  assert.ok(blob.length > 4);
  assert.equal(dec.decode(blob.subarray(0, 4)), 'ARW1');
});

test('gremlin returns a JSON result array', () => {
  const g = Graph.fromNdjson(NDJSON);
  assert.deepEqual(json(g.gremlin('g.V().count()')), [2]);
});

test('version advances on a mutating query', () => {
  const g = Graph.fromNdjson(NDJSON);
  const before = g.version();
  g.query("MATCH (p:Person) WHERE p.name = 'marko' SET p.age = 99");
  assert.ok(g.version() > before, 'version should advance after SET');
});

test('a bad query throws with a lenke-tagged message', () => {
  const g = Graph.fromNdjson(NDJSON);
  assert.throws(() => g.query('NOT A QUERY'), /lenke: query:/);
});

test('encodeNdjson round-trips the data', () => {
  const g = Graph.fromNdjson(NDJSON);
  assert.match(dec.decode(g.encodeNdjson()), /marko/);
});

// The payoff: the napi addon drives the shared Backend contract, so the whole
// @lenke/native facade (graphFromNdjson + createStore + liveQuery) runs on Node.
test('createNodeBackend powers the @lenke/native facade + liveQuery', () => {
  const backend = createNodeBackend();
  assert.equal(backend.abiVersion, 8);

  const g = graphFromNdjson(backend, NDJSON);
  const store = createStore(g);
  const live = store.liveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
  assert.equal(live.getSnapshot().length, 2);

  // Referentially stable until a relevant mutation bumps the epoch.
  assert.strictEqual(live.getSnapshot(), live.getSnapshot());

  // A mutation touching a dependency ('name') recomputes to a fresh reference.
  const before = live.getSnapshot();
  store.mutate((graph) => graph.query("INSERT (:Person {name: 'zoe'})"));
  const after = live.getSnapshot();
  assert.notStrictEqual(after, before);
  assert.equal(after.length, 3);
});
