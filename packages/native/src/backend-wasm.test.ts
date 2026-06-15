// End-to-end proof of the wasm backend: instantiate the pl_graph_core.wasm
// artifact, build a graph from NDJSON, and drive GQL + Gremlin through the same
// `RustGraph` facade the FFI backend uses. This is the test that proves the
// linear-memory marshalling (plg_alloc in, copy out) actually works in a JS
// runtime. Run: bun test packages/native/src/backend-wasm.test.ts
import { describe, expect, test } from 'bun:test';

import { ABI_VERSION } from './abi.js';
import { createWasmBackend } from './backend-wasm.js';
import { graphFromFormat, graphFromNdjson } from './graph.js';

const WASM = new URL(
  '../../../crates/pl-graph-core/target/wasm32-unknown-unknown/release/pl_graph_core.wasm',
  import.meta.url,
).pathname;

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}',
  '{"type":"edge","id":"e1","labels":["knows"],"from":"a","to":"b","properties":{"weight":0.5}}',
].join('\n');

const bytes = new TextEncoder().encode(NDJSON);
const wasmBytes = await Bun.file(WASM).arrayBuffer();

describe('@pl-graph/native wasm backend', () => {
  test('instantiates at the expected ABI version', async () => {
    const backend = await createWasmBackend(wasmBytes);
    expect(backend.abiVersion).toBe(ABI_VERSION);
  });

  test('builds a graph and reports counts', async () => {
    const backend = await createWasmBackend(wasmBytes);
    const g = graphFromNdjson(backend, bytes);
    expect(g.vertexCount).toBe(2);
    expect(g.edgeCount).toBe(1);
    g.free();
  });

  test('runs a GQL query through the facade (string + template)', async () => {
    const backend = await createWasmBackend(wasmBytes);
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

  test('runs a textual Gremlin query through the facade', async () => {
    const backend = await createWasmBackend(wasmBytes);
    const g = graphFromNdjson(backend, bytes);
    const names = g.gremlin("g.V().has('name','marko').out('knows').values('name')");
    expect(names).toEqual(['vadas']);
    g.free();
  });

  test('round-trips through NDJSON (and preserves the edge id)', async () => {
    const backend = await createWasmBackend(wasmBytes);
    const g = graphFromNdjson(backend, bytes);
    const out = g.toNdjson();
    expect(new TextDecoder().decode(out)).toContain('"id":"e1"');
    const g2 = graphFromNdjson(backend, out);
    expect(g2.vertexCount).toBe(2);
    expect(g2.edgeCount).toBe(1);
    g.free();
    g2.free();
  });

  test('serializes + round-trips through every format (over linear memory)', async () => {
    const backend = await createWasmBackend(wasmBytes);
    const g = graphFromNdjson(backend, bytes);
    for (const fmt of ['pg-json', 'pg-text', 'graphson', 'csv', 'ndjson']) {
      const doc = g.serialize(fmt);
      expect(doc.length).toBeGreaterThan(0);
      const g2 = graphFromFormat(backend, doc, fmt);
      expect(g2.vertexCount).toBe(2);
      expect(g2.edgeCount).toBe(1);
      g2.free();
    }
    g.free();
  });

  test('a large insert exercises a memory grow', async () => {
    const backend = await createWasmBackend(wasmBytes);
    // ~5k nodes of NDJSON forces the wasm heap to grow past its initial pages.
    const lines: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(`{"type":"node","id":"n${i}","labels":["P"],"properties":{"age":${i % 80}}}`);
    }
    const big = new TextEncoder().encode(lines.join('\n'));
    const g = graphFromNdjson(backend, big);
    expect(g.vertexCount).toBe(5000);
    const rows = g.query('MATCH (n:P) WHERE n.age = 42 RETURN count(*) AS c');
    expect(rows[0]!.c).toBe(62); // i%80==42 for i in 0..4999 → 42,122,…,4922 = 62
    g.free();
  });
});
