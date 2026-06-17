// End-to-end proof of the FFI backend through the public facade: load the native
// library, build a graph from NDJSON, and run GQL + Gremlin through `RustGraph`.
// The wasm backend exercises the identical `Backend` contract; its own test runs
// in a browser/wasm host. Run: bun test packages/native/src/backend-ffi.test.ts
import { describe, expect, test } from 'bun:test';

import { ABI_VERSION } from './abi.js';
import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat, graphFromNdjson } from './graph.js';

const LIB = new URL(
  '../../../crates/pl-graph-core/target/release/libpl_graph_core.dylib',
  import.meta.url,
).pathname;

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}',
  '{"type":"edge","id":"e1","labels":["knows"],"from":"a","to":"b","properties":{"weight":0.5}}',
].join('\n');

const bytes = new TextEncoder().encode(NDJSON);

describe('@pl-graph/native FFI backend', () => {
  test('loads at the expected ABI version', () => {
    const backend = createFfiBackend(LIB);
    expect(backend.abiVersion).toBe(ABI_VERSION);
  });

  test('builds a graph and reports counts', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    expect(g.vertexCount).toBe(2);
    expect(g.edgeCount).toBe(1);
    g.free();
  });

  test('runs a GQL query through the facade (string + template)', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);

    const rows = g.query('MATCH (n:P) RETURN n.name, n.age ORDER BY n.age');
    expect(rows).toEqual([
      { 'n.name': 'vadas', 'n.age': 27 },
      { 'n.name': 'marko', 'n.age': 29 },
    ]);

    const min = 28;
    const tpl = g.query`MATCH (n:P) WHERE n.age > ${min} RETURN n.name`;
    expect(tpl).toEqual([{ 'n.name': 'marko' }]);

    g.free();
  });

  test('runs a textual Gremlin query through the facade', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    const names = g.gremlin("g.V().has('name','marko').out('knows').values('name')");
    expect(names).toEqual(['vadas']);
    g.free();
  });

  test('round-trips through NDJSON', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    const out = g.toNdjson();
    const g2 = graphFromNdjson(backend, out);
    expect(g2.vertexCount).toBe(2);
    expect(g2.edgeCount).toBe(1);
    g.free();
    g2.free();
  });

  test('serializes + round-trips through every format', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);

    for (const fmt of ['pg-json', 'pg-text', 'graphson', 'csv', 'ndjson']) {
      const doc = g.serialize(fmt);
      expect(doc.length).toBeGreaterThan(0);
      const g2 = graphFromFormat(backend, doc, fmt);
      expect(g2.vertexCount).toBe(2);
      expect(g2.edgeCount).toBe(1);
      // the GQL query gives the same answer regardless of the carrier format
      expect(g2.query('MATCH (n:P) RETURN n.name ORDER BY n.name')).toEqual([
        { 'n.name': 'marko' },
        { 'n.name': 'vadas' },
      ]);
      g2.free();
    }

    g.free();
  });

  test('graphson preserves the edge id; unknown format throws', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    const gson = g.serialize('graphson');
    expect(gson).toContain('"e1"'); // the edge id survives
    expect(() => g.serialize('nope')).toThrow();
    g.free();
  });
});
