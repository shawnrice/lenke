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

import {
  type AlgorithmConfig,
  connectedComponents,
  degree,
  Graph,
  labelPropagation,
  pagerank,
  shortestPath,
} from '@lenke/core';
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

// A graph with two disjoint components {a,b,c} and {e,d} plus an isolated vertex
// f — nodes in NON-sorted insertion order to prove both engines root each
// component at its first-inserted (lowest dense-id) member, not by id string.
const TWO_COMPONENT_NDJSON = [
  '{"type":"node","id":"a","labels":["N"]}',
  '{"type":"node","id":"b","labels":["N"]}',
  '{"type":"node","id":"c","labels":["N"]}',
  '{"type":"node","id":"e","labels":["N"]}',
  '{"type":"node","id":"d","labels":["N"]}',
  '{"type":"node","id":"f","labels":["N"]}',
  '{"type":"edge","id":"1","from":"a","to":"b","labels":["E"]}',
  '{"type":"edge","id":"2","from":"b","to":"c","labels":["E"]}',
  '{"type":"edge","id":"3","from":"e","to":"d","labels":["E"]}',
].join('\n');

suite('graph-algorithm differential: connectedComponents (TS core vs native)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, TWO_COMPONENT_NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(TWO_COMPONENT_NDJSON, 'ndjson', new Graph());

  for (const config of [{} as const, { edgeLabel: 'E' } as const, { edgeLabel: 'NOPE' } as const]) {
    test(`connectedComponents ${JSON.stringify(config)} — byte-identical`, () => {
      expect(JSON.stringify(connectedComponents(config, tsGraph))).toBe(
        JSON.stringify(nativeGraph.connectedComponents(config)),
      );
    });
  }

  test('known-answer: roots are first-inserted member (a, e), f isolated', () => {
    // Insertion order a,b,c,e,d,f → {a,b,c} root "a"; {e,d} root "e"; {f} root "f".
    expect(nativeGraph.connectedComponents({})).toEqual([
      { node: 'a', componentId: 'a' },
      { node: 'b', componentId: 'a' },
      { node: 'c', componentId: 'a' },
      { node: 'e', componentId: 'e' },
      { node: 'd', componentId: 'e' },
      { node: 'f', componentId: 'f' },
    ]);
  });

  test('writeProperty round-trips identically through GQL on both engines', () => {
    const config = { writeProperty: 'comp' } as const;
    connectedComponents(config, tsGraph);
    nativeGraph.connectedComponents(config);

    const readBack = 'MATCH (n) RETURN n.comp AS comp ORDER BY n.comp, n.comp';
    expect(JSON.stringify(tsQuery(tsGraph, readBack))).toBe(
      JSON.stringify(nativeGraph.query(readBack)),
    );
  });
});

// Two triangles {a,b,c} and {e,d,g} (non-sorted insertion order) plus a bridge
// edge c→e joining them, and an isolated vertex f. Exercises convergence, a
// bridged super-component, and a singleton in one graph.
const LABELPROP_NDJSON = [
  '{"type":"node","id":"a","labels":["N"]}',
  '{"type":"node","id":"b","labels":["N"]}',
  '{"type":"node","id":"c","labels":["N"]}',
  '{"type":"node","id":"e","labels":["N"]}',
  '{"type":"node","id":"d","labels":["N"]}',
  '{"type":"node","id":"g","labels":["N"]}',
  '{"type":"node","id":"f","labels":["N"]}',
  '{"type":"edge","id":"1","from":"a","to":"b","labels":["E"]}',
  '{"type":"edge","id":"2","from":"b","to":"c","labels":["E"]}',
  '{"type":"edge","id":"3","from":"a","to":"c","labels":["E"]}',
  '{"type":"edge","id":"4","from":"e","to":"d","labels":["E"]}',
  '{"type":"edge","id":"5","from":"d","to":"g","labels":["E"]}',
  '{"type":"edge","id":"6","from":"e","to":"g","labels":["E"]}',
  '{"type":"edge","id":"7","from":"c","to":"e","labels":["E"]}',
].join('\n');

suite('graph-algorithm differential: labelPropagation (TS core vs native)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, LABELPROP_NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(LABELPROP_NDJSON, 'ndjson', new Graph());

  for (const config of [
    {} as const, // default 10 iterations
    { iterations: 0 } as const, // no propagation
    { iterations: 1 } as const, // one round — catches any per-round drift
    { iterations: 3 } as const,
    { iterations: 25 } as const,
    { edgeLabel: 'E' } as const,
    { edgeLabel: 'NOPE' } as const, // unknown type → labels stay = own id
  ]) {
    test(`labelPropagation ${JSON.stringify(config)} — byte-identical`, () => {
      expect(JSON.stringify(labelPropagation(config, tsGraph))).toBe(
        JSON.stringify(nativeGraph.labelPropagation(config)),
      );
    });
  }

  test('writeProperty round-trips identically through GQL on both engines', () => {
    const config = { writeProperty: 'lbl' } as const;
    labelPropagation(config, tsGraph);
    nativeGraph.labelPropagation(config);

    const readBack = 'MATCH (n) RETURN n.lbl AS lbl ORDER BY n.lbl, n.lbl';
    expect(JSON.stringify(tsQuery(tsGraph, readBack))).toBe(
      JSON.stringify(nativeGraph.query(readBack)),
    );
  });
});

// A weighted graph with INTERLEAVED edge types into a common hub (e's in-edges are
// T1,T2,T1,T2 in insertion order) — this is exactly the shape that diverges if an
// engine iterated adjacency grouped-by-type instead of edge-insertion order, so it
// pins the f64 summation order. Also a dangling structure (b, a sink) and weights.
const PAGERANK_NDJSON = [
  '{"type":"node","id":"a","labels":["N"]}',
  '{"type":"node","id":"b","labels":["N"]}',
  '{"type":"node","id":"c","labels":["N"]}',
  '{"type":"node","id":"d","labels":["N"]}',
  '{"type":"node","id":"e","labels":["N"]}',
  '{"type":"edge","id":"1","from":"a","to":"e","labels":["T1"],"properties":{"w":0.5}}',
  '{"type":"edge","id":"2","from":"b","to":"e","labels":["T2"],"properties":{"w":1.5}}',
  '{"type":"edge","id":"3","from":"c","to":"e","labels":["T1"],"properties":{"w":2.0}}',
  '{"type":"edge","id":"4","from":"d","to":"e","labels":["T2"],"properties":{"w":0.25}}',
  '{"type":"edge","id":"5","from":"e","to":"a","labels":["T1"],"properties":{"w":1.0}}',
  '{"type":"edge","id":"6","from":"a","to":"c","labels":["T2"],"properties":{"w":0.7}}',
  '{"type":"edge","id":"7","from":"c","to":"d","labels":["T1"],"properties":{"w":1.3}}',
].join('\n');

suite('graph-algorithm differential: pagerank (TS core vs native, f64)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, PAGERANK_NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(PAGERANK_NDJSON, 'ndjson', new Graph());

  for (const config of [
    {} as const, // default 20 iterations, d=0.85, unweighted
    { iterations: 1 } as const, // single round — catches first-step drift
    { iterations: 5 } as const,
    { iterations: 50 } as const, // near-converged: bit drift would compound
    { dampingFactor: 0.5 } as const,
    { dampingFactor: 0.99 } as const,
    { weightProperty: 'w' } as const, // weighted — stresses weight reads + order
    { weightProperty: 'w', iterations: 7 } as const,
    { weightProperty: 'w', edgeLabel: 'T1' } as const,
    { edgeLabel: 'T2' } as const,
    { edgeLabel: 'NOPE' } as const, // no edges → uniform 1/N
  ]) {
    test(`pagerank ${JSON.stringify(config)} — f64 byte-identical`, () => {
      expect(JSON.stringify(pagerank(config, tsGraph))).toBe(
        JSON.stringify(nativeGraph.pagerank(config)),
      );
    });
  }

  test('writeProperty round-trips identically through GQL on both engines', () => {
    const config = { writeProperty: 'pr' } as const;
    pagerank(config, tsGraph);
    nativeGraph.pagerank(config);

    const readBack = 'MATCH (n) RETURN n.pr AS pr ORDER BY n.pr DESC, n.pr';
    expect(JSON.stringify(tsQuery(tsGraph, readBack))).toBe(
      JSON.stringify(nativeGraph.query(readBack)),
    );
  });
});

// A weighted diamond with fractional weights: a→b→d (0.1+0.2 = 0.30000000000000004)
// vs the direct a→d (0.3) — the classic f64 non-associativity trap, so this pins
// that both engines settle the same minimum float distance. Plus a longer branch
// and a sink (e).
// `he` is an admissible heuristic (≤ true distance to e) used by the A* cases.
const SHORTEST_NDJSON = [
  '{"type":"node","id":"a","labels":["N"],"properties":{"he":0.5}}',
  '{"type":"node","id":"b","labels":["N"],"properties":{"he":0.4}}',
  '{"type":"node","id":"c","labels":["N"],"properties":{"he":0.7}}',
  '{"type":"node","id":"d","labels":["N"],"properties":{"he":0.2}}',
  '{"type":"node","id":"e","labels":["N"],"properties":{"he":0.0}}',
  '{"type":"edge","id":"1","from":"a","to":"b","labels":["E"],"properties":{"w":0.1}}',
  '{"type":"edge","id":"2","from":"b","to":"d","labels":["E"],"properties":{"w":0.2}}',
  '{"type":"edge","id":"3","from":"a","to":"d","labels":["E"],"properties":{"w":0.3}}',
  '{"type":"edge","id":"4","from":"a","to":"c","labels":["E"],"properties":{"w":1.5}}',
  '{"type":"edge","id":"5","from":"c","to":"d","labels":["E"],"properties":{"w":0.5}}',
  '{"type":"edge","id":"6","from":"c","to":"e","labels":["E"],"properties":{"w":2.0}}',
  '{"type":"edge","id":"7","from":"d","to":"e","labels":["E"],"properties":{"w":0.25}}',
].join('\n');

suite('graph-algorithm differential: shortestPath (TS core vs native)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, SHORTEST_NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(SHORTEST_NDJSON, 'ndjson', new Graph());

  for (const config of [
    { source: 'a' } as const, // BFS (unweighted)
    { source: 'a', weightProperty: 'w' } as const, // Dijkstra, f64 diamond
    { source: 'c', weightProperty: 'w' } as const,
    { source: 'e', weightProperty: 'w' } as const, // sink → only e:0
    { source: 'a', weightProperty: 'w', edgeLabel: 'E' } as const,
    { source: 'a', edgeLabel: 'NOPE' } as const, // no edges → only source
    { source: 'zzz' } as const, // unknown source → empty
    // A* (goal-directed): h=0 (degrades to Dijkstra) and an admissible heuristic.
    { source: 'a', target: 'e', weightProperty: 'w', algorithm: 'astar' } as const,
    {
      source: 'a',
      target: 'e',
      weightProperty: 'w',
      algorithm: 'astar',
      heuristicProperty: 'he',
    } as const,
    { source: 'a', target: 'd', weightProperty: 'w', algorithm: 'astar' } as const,
    { source: 'e', target: 'a', weightProperty: 'w', algorithm: 'astar' } as const, // unreachable
  ]) {
    test(`shortestPath ${JSON.stringify(config)} — byte-identical`, () => {
      expect(JSON.stringify(shortestPath(config, tsGraph))).toBe(
        JSON.stringify(nativeGraph.shortestPath(config)),
      );
    });
  }

  test('A* target distance equals Dijkstra (with and without a heuristic)', () => {
    const dijkstra = nativeGraph.shortestPath({ source: 'a', weightProperty: 'w' });

    for (const target of ['b', 'c', 'd', 'e']) {
      const dj = dijkstra.find((r) => r.node === target)?.distance;
      const plain = nativeGraph.shortestPath({
        source: 'a',
        target,
        weightProperty: 'w',
        algorithm: 'astar',
      });
      const heur = nativeGraph.shortestPath({
        source: 'a',
        target,
        weightProperty: 'w',
        algorithm: 'astar',
        heuristicProperty: 'he',
      });
      expect(plain).toEqual([{ node: target, distance: dj! }]);
      expect(heur).toEqual([{ node: target, distance: dj! }]);
    }
  });

  test('known-answer: weighted diamond settles the direct 0.3, not 0.1+0.2', () => {
    const d = nativeGraph.shortestPath({ source: 'a', weightProperty: 'w' });
    expect(d.find((r) => r.node === 'd')?.distance).toBe(0.3);
    expect(d.find((r) => r.node === 'e')?.distance).toBe(0.55);
  });

  test('writeProperty round-trips identically through GQL on both engines', () => {
    const config = { source: 'a', weightProperty: 'w', writeProperty: 'sp' } as const;
    shortestPath(config, tsGraph);
    nativeGraph.shortestPath(config);

    const readBack = 'MATCH (n) RETURN n.sp AS sp ORDER BY n.sp, n.sp';
    expect(JSON.stringify(tsQuery(tsGraph, readBack))).toBe(
      JSON.stringify(nativeGraph.query(readBack)),
    );
  });
});
