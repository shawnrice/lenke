// Byte-identity for the two-hop row projection — item 1619's rung.
//
// ⚠️ THE RUNG IS TS-ONLY: it is a route inside the TypeScript executor, and native answers the same
// shape its own way. So the invariant is that the two still agree, which is the hard one in this
// repo — a new TS fast path is exactly the kind of change that can drift from the Rust engine.
//
// Row order without an `ORDER BY` is unspecified (item 198) and the differential fuzzer compares GQL
// results as MULTISETS for that reason, so every query here carries an `ORDER BY` and the comparison
// is then a byte compare. ⚠️ Note what that costs: an `ORDER BY` makes the projection non-plain, so
// `plainRowProjection` DECLINES and these queries do not take the rung at all. The ordered form is
// the only way to compare bytes, and the unordered form is the one the rung serves — so both are
// here, the ordered ones byte-compared and the unordered ones compared as multisets.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/** `L`, `M`, or BOTH, so a label test is not a partition. */
const labelsFor = (i: number): string[] => {
  if (i % 3 === 0) {
    return ['L'];
  }

  return i % 3 === 1 ? ['M'] : ['L', 'M'];
};

/** 12 vertices, two labels, two edge types, a self-loop and an isolated vertex. */
const NDJSON = (() => {
  const lines: string[] = [];

  for (let i = 0; i < 12; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'node',
        id: `v${i}`,
        labels: labelsFor(i),
        // ⚠️ `v5` has NO `k`, so a projection over it emits null rather than dropping the row —
        // the asymmetry with Gremlin's `values(k)` and a place the two engines could differ.
        properties: i === 5 ? { id: `v${i}` } : { id: `v${i}`, k: i % 5, n: i },
      }),
    );
  }

  const edges: [string, string, string][] = [
    ['v0', 'v1', 'R'],
    ['v1', 'v2', 'R'],
    ['v2', 'v3', 'R'],
    ['v3', 'v4', 'R'],
    ['v4', 'v4', 'R'], // a SELF-LOOP, which a two-segment pattern may traverse twice
    ['v0', 'v5', 'R'],
    ['v5', 'v6', 'R'],
    ['v1', 'v7', 'S'],
    ['v7', 'v8', 'S'],
    ['v8', 'v0', 'R'],
    ['v9', 'v10', 'R'],
    ['v10', 'v9', 'R'],
  ];

  edges.forEach(([from, to, label], i) => {
    lines.push(
      JSON.stringify({ type: 'edge', id: `e${i}`, labels: [label], from, to, properties: {} }),
    );
  });

  return lines.join('\n');
})();

const suite = nativeReady ? describe : describe.skip;

suite('a two-segment row projection: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /** ORDERED, so the comparison is a byte compare. */
  const ORDERED: readonly string[] = [
    'MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k ORDER BY k',
    'MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN a.id AS a, b.id AS b, c.id AS c ORDER BY a, b, c',
    'MATCH (a)-[:R]->(b)-[:R]->(c) RETURN c.id AS c ORDER BY c',
    'MATCH (a)<-[:R]-(b)-[:R]->(c) RETURN a.id AS a, c.id AS c ORDER BY a, c',
    'MATCH (a)-[:S]->(b)-[:S]->(c) RETURN c.id AS c ORDER BY c',
    'MATCH (a)-[:S]->(b)-[:R]->(c) RETURN c.id AS c ORDER BY c',
    'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:L) RETURN c.id AS c ORDER BY c',
    // The self-loop traversed twice, and a far end with no `k`.
    'MATCH (a)-[:R]->(b)-[:R]->(c) RETURN a.id AS a, c.k AS k ORDER BY a, k',
    'MATCH (a:ZZZ)-[:R]->(b)-[:R]->(c) RETURN c.id AS c ORDER BY c',
  ];

  for (const q of ORDERED) {
    test(q, () => {
      expect(JSON.stringify(tsQuery(tsGraph, q))).toBe(JSON.stringify(nativeGraph.query(q)));
    });
  }

  test('⚠️ the UNORDERED forms, which are the ones the rung actually serves', () => {
    /**
     * An `ORDER BY` makes the projection non-plain, so the queries above DECLINE the rung. These are
     * the shapes it answers, and for them row order is unspecified in both engines — so the
     * comparison is a multiset, exactly as `differential-fuzz` does it.
     */
    const multiset = (rows: unknown[]): string[] => rows.map((r) => JSON.stringify(r)).sort();

    for (const q of [
      'MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k',
      'MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN a.id AS a, b.id AS b, c.id AS c',
      'MATCH (a)-[:R]->(b)-[:R]->(c) RETURN c.id AS c',
      'MATCH (a)<-[:R]-(b)-[:R]->(c) RETURN a.id AS a, c.id AS c',
      'MATCH (a)-[:S]->(b)-[:R]->(c) RETURN c.id AS c',
      'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:L) RETURN c.id AS c',
      'MATCH (a)-[:R]->(b)-[:R]->(c) RETURN a.id AS a, c.k AS k',
    ]) {
      expect(multiset(tsQuery(tsGraph, q))).toEqual(multiset(nativeGraph.query(q)));
    }
  });
});
