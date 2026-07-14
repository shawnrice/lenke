// Differential conformance for the in-engine graph algorithms: the TS core
// (@lenke/core data-last free functions, in-process) vs the Rust core (this
// package, over bun:ffi), driven from ONE source of truth — the same NDJSON
// loaded into both — so an algorithm's result can't drift between the two forms.
//
//   load once:   identical NDJSON (same ids/labels/properties, same order)
//   TS core:     JSON.stringify(degree(config, tsGraph))
//   Rust core:   JSON.stringify(nativeGraph.degree(config))
//   assert:      the two serializations are byte-identical
//
// Both engines assign dense vertex ids / iterate vertices in NDJSON insertion
// order and count a vertex's edges in adjacency order with no sorting, so integer
// algorithms are exactly equal and their JSON serializations match byte-for-byte.
// A `writeProperty` config additionally writes the result back to a vertex
// property, which we read out through GQL on both engines to prove the two graphs
// mutated identically.
//
// Run: bun test packages/native/src/algo-conformance.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { type AlgorithmConfig, degree, Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat } from './graph.js';

// --- native library bootstrap (mirrors gql-conformance.test.ts) -------------
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[algo-conformance] skipping: ${LIB} not found — run \`bun run build:rust\`.`);
}

const suite = hasLib ? describe : describe.skip;

// The TinkerPop "modern" graph, nodes in NON-sorted insertion order (1,2,4,3,5,6)
// so the test proves both engines honour insertion order, not id order. KNOWS:
// marko→vadas, marko→josh. CREATED: marko→lop, josh→ripple, josh→lop, peter→lop.
const MODERN_NDJSON = [
  '{"type":"node","id":"1","labels":["Person"],"properties":{"name":"marko"}}',
  '{"type":"node","id":"2","labels":["Person"],"properties":{"name":"vadas"}}',
  '{"type":"node","id":"4","labels":["Person"],"properties":{"name":"josh"}}',
  '{"type":"node","id":"3","labels":["Software"],"properties":{"name":"lop"}}',
  '{"type":"node","id":"5","labels":["Software"],"properties":{"name":"ripple"}}',
  '{"type":"node","id":"6","labels":["Person"],"properties":{"name":"peter"}}',
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["KNOWS"]}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["KNOWS"]}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["CREATED"]}',
  '{"type":"edge","id":"10","from":"4","to":"5","labels":["CREATED"]}',
  '{"type":"edge","id":"11","from":"4","to":"3","labels":["CREATED"]}',
  '{"type":"edge","id":"12","from":"6","to":"3","labels":["CREATED"]}',
].join('\n');

suite('graph-algorithm differential: degree (TS core vs native)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, MODERN_NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(MODERN_NDJSON, 'ndjson', new Graph());

  const both = (config: AlgorithmConfig): [string, string] => [
    JSON.stringify(degree(config, tsGraph)),
    JSON.stringify(nativeGraph.degree(config)),
  ];

  for (const config of [
    { direction: 'out' } as const,
    { direction: 'in' } as const,
    { direction: 'both' } as const,
    { direction: 'out', edgeLabel: 'KNOWS' } as const,
    { direction: 'in', edgeLabel: 'CREATED' } as const,
    { direction: 'both', edgeLabel: 'CREATED' } as const,
    { edgeLabel: 'NOPE' } as const, // unknown edge type → all zero
    {} as const, // defaults (out, all types)
  ]) {
    test(`degree ${JSON.stringify(config)} — byte-identical`, () => {
      const [ts, native] = both(config);
      expect(ts).toBe(native);
    });
  }

  test('known-answer: out-degree over all types', () => {
    // marko(1)=3, vadas(2)=0, josh(4)=2, lop(3)=0, ripple(5)=0, peter(6)=1.
    expect(nativeGraph.degree({ direction: 'out' })).toEqual([
      { node: '1', degree: 3 },
      { node: '2', degree: 0 },
      { node: '4', degree: 2 },
      { node: '3', degree: 0 },
      { node: '5', degree: 0 },
      { node: '6', degree: 1 },
    ]);
  });

  test('writeProperty round-trips identically through GQL on both engines', () => {
    const config = { direction: 'both', writeProperty: 'deg' } as const;
    // Mutate both graphs.
    degree(config, tsGraph);
    nativeGraph.degree(config);

    // Read the written property back through BOTH GQL engines: identical output
    // proves the two graphs were mutated identically by their respective `degree`.
    const readBack = 'MATCH (n) RETURN n.name AS name, n.deg AS deg ORDER BY n.deg DESC, n.name';
    const tsRows = JSON.stringify(tsQuery(tsGraph, readBack));
    const nativeRows = JSON.stringify(nativeGraph.query(readBack));
    expect(tsRows).toBe(nativeRows);
    // lop(3) has in-degree 3 (marko, josh, peter), out 0 → both = 3.
    expect(nativeGraph.degree({ direction: 'both' })[3]).toEqual({ node: '3', degree: 3 });
    expect(nativeRows).toContain('"deg":3');
  });
});
