import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// An INLINE constraint on a one-hop count's far endpoint is carried into the tally instead of
// declining the whole shortcut (audit item 125). Every case checks the shortcut against a route
// that does NOT take it.
//
// THE ORACLE, again. Item 124 would have used the clause-`WHERE` spelling, but that now shares
// the same tally, so it is no longer independent. `ORDER BY c` makes the projection guard
// decline and runs the general row pipeline — the same oracle item 112 used — and the known edge
// list gives the arithmetic.

const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 3],
  [3, 0],
  [3, 3],
  [4, 1],
  [4, 2],
  [5, 5],
];
const N = 8;

const build = (): Graph => {
  const g = new Graph();
  // `k` is uneven on purpose: k=1 on three vertices, k=2 on two, so a count that applies the
  // constraint to the wrong end — or not at all — reads differently from one that gets it right.
  const ks = [1, 1, 2, 1, 2, 0, 0, 0];
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: i < 6 ? ['P'] : ['Q'], properties: { k: ks[i], i } }),
  );

  for (const [a, b] of EDGES) {
    g.addEdge({ from: vs[a], to: vs[b], labels: ['E'], properties: {} });
  }

  // One vertex with NO `k` at all, so an absent key is exercised (NULL drops the row).
  const bare = g.addVertex({ id: 'bare', labels: ['P'], properties: {} });

  g.addEdge({ from: vs[0], to: bare, labels: ['E'], properties: {} });

  return g;
};

const c = (g: Graph, q: string): number => (query(g, q)[0] as { c: number }).c;
const both = (g: Graph, q: string): void => {
  // The shortcut, then the same question through the general pipeline.
  expect(c(g, `${q} RETURN count(*) AS c`)).toBe(c(g, `${q} RETURN count(*) AS c ORDER BY c`));
};

describe('an inline far-endpoint constraint is applied, not ignored or declined', () => {
  test('every inline spelling agrees with the general pipeline', () => {
    const g = build();

    for (const q of [
      `MATCH (a:P)-[:E]->(b {k: 2})`,
      `MATCH (a:P)-[:E]->(b:P {k: 2})`,
      `MATCH (a:P)-[:E]->(b WHERE b.k = 2)`,
      `MATCH (a:P)-[:E]->(b:P WHERE b.k = 2)`,
      // a key no vertex carries, and a key one vertex is MISSING
      `MATCH (a:P)-[:E]->(b {k: 99})`,
      `MATCH (a:P)-[:E]->(b {missing: 1})`,
      // the `<-` direction
      `MATCH (a:P)<-[:E]-(b {k: 2})`,
      // combined with a clause WHERE on the other end
      `MATCH (a:P)-[:E]->(b {k: 2}) WHERE a.k = 1`,
      // an anonymous far node still carries its props
      `MATCH (a:P)-[:E]->({k: 2})`,
    ]) {
      both(g, q);
    }
  });

  // THE WRONG-ANSWER RISK. With no clause `WHERE`, the un-constrained paths are the O(1)
  // bucket-size read and a label-only walk, and NEITHER can see an inline constraint. If the
  // shortcut routed there, `(b {k: 2})` would return every edge's count.
  test('an inline constraint never reaches the bucket-size path', () => {
    const g = build();
    const all = c(g, `MATCH (a:P)-[:E]->(b) RETURN count(*) AS c`);
    const filtered = c(g, `MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*) AS c`);

    expect(filtered).toBeLessThan(all);
    // …and it is the right number: edges into a vertex whose k is 2 (v2 and v4).
    expect(filtered).toBe(EDGES.filter(([, b]) => [2, 4].includes(b)).length);
  });

  test('a $param value is carried', () => {
    const g = build();
    const q = `MATCH (a:P)-[:E]->(b {k: $v}) RETURN count(*) AS c`;

    expect((query(g, q, { v: 2 })[0] as { c: number }).c).toBe(
      c(g, `MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*) AS c`),
    );
    expect((query(g, q, { v: 99 })[0] as { c: number }).c).toBe(0);
  });

  // These must DECLINE and still answer correctly. A correlated inline value would need the
  // other endpoint bound per edge; an anonymous node with an inline WHERE has no variable to
  // bind; and a START-side constraint is seedable, so the general path beats the tally (5.2 ->
  // 6.2ms measured — declining is the faster choice, not a limitation).
  test('shapes the tally must decline still answer correctly', () => {
    const g = build();

    for (const q of [
      `MATCH (a:P)-[:E]->(b {k: a.k})`,
      `MATCH (a:P)-[:E]->(WHERE true)`,
      `MATCH (a:P {k: 1})-[:E]->(b)`,
      `MATCH (a:P {k: 1})-[:E]->(b {k: 2})`,
      // two-hop keeps declining entirely
      `MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(d)`,
      // a rel predicate is still not carried
      `MATCH (a:P)-[:E {w: 1}]->(b {k: 2})`,
    ]) {
      both(g, q);
    }
  });

  // A self-loop and a parallel edge are counted once each by both routes.
  test('self-loops and the unfiltered control are unchanged', () => {
    const g = build();

    both(g, `MATCH (a:P)-[:E]->(b)`);
    both(g, `MATCH (a:P)-[:E]->(b:P)`);
    expect(c(g, `MATCH (a:P)-[:E]->(b) RETURN count(*) AS c`)).toBe(EDGES.length + 1);
  });
});

// A START-side inline constraint now routes to the per-VERTEX walk rather than declining
// (audit item 129). Item 125 had measured routing it to the TALLY — a full edge scan — and
// rightly rejected that; the per-vertex walk reads bucket SIZES, so degree costs nothing, and the
// win grows with it (2.1x at degree 3, 5.7x at degree 9).
describe('an inline START constraint is counted per vertex', () => {
  test('every start spelling agrees with the general pipeline', () => {
    const g = build();

    for (const q of [
      `MATCH (a:P {k: 1})-[:E]->(b)`,
      `MATCH (a:P WHERE a.k = 1)-[:E]->(b)`,
      `MATCH (a:P {k: 1})<-[:E]-(b)`,
      // a key no vertex carries, and a key one vertex is MISSING
      `MATCH (a:P {k: 99})-[:E]->(b)`,
      `MATCH (a:P {missing: 1})-[:E]->(b)`,
      // an ANONYMOUS start: the per-vertex walk has no variable to bind, which is why
      // `startOnlyHopCount` takes `startVar` as optional.
      `MATCH ({k: 1})-[:E]->(b)`,
      // start inline PLUS a clause predicate on the same node
      `MATCH (a:P {k: 1})-[:E]->(b) WHERE a.i > 0`,
    ]) {
      both(g, q);
    }
  });

  // The per-vertex walk never visits the far endpoint, so anything constraining it must send
  // the query elsewhere. If it did not, the far constraint would simply be ignored.
  test('a far-side constraint keeps the start off the per-vertex walk', () => {
    const g = build();

    for (const q of [
      `MATCH (a:P {k: 1})-[:E]->(b {k: 2})`,
      `MATCH (a:P {k: 1})-[:E]->(b:Q)`,
      `MATCH (a:P {k: 1})-[:E]->(b) WHERE b.k = 2`,
    ]) {
      both(g, q);
    }

    // …and the far constraint really does narrow: ignoring it would give a bigger answer.
    expect(c(g, `MATCH (a:P {k: 1})-[:E]->(b {k: 2}) RETURN count(*) AS c`)).toBeLessThan(
      c(g, `MATCH (a:P {k: 1})-[:E]->(b) RETURN count(*) AS c`),
    );
  });

  // Summing per-type bucket sizes double-counts an edge carrying two of the types, so a
  // multi-type graph must not reach the per-vertex walk.
  test('a start constraint over multi-type edges counts an edge once', () => {
    const g = new Graph();
    const v0 = g.addVertex({ id: 'm0', labels: ['P'], properties: { k: 1, i: 0 } });
    const v1 = g.addVertex({ id: 'm1', labels: ['P'], properties: { k: 2, i: 1 } });

    g.addEdge({ from: v0, to: v1, labels: ['E', 'F'], properties: {} });

    for (const rel of [`[:E|F]`, `[]`, `[:E]`]) {
      const q = `MATCH (a:P {k: 1})-${rel}->(b) RETURN count(*) AS c`;

      expect(c(g, q)).toBe(c(g, `${q} ORDER BY c`));
      expect(c(g, q)).toBe(1);
    }
  });

  // Degree is what the per-vertex walk reads, so a vertex with several edges must contribute
  // all of them — the failure a degree-1 fixture cannot see.
  test('a high-degree start vertex contributes its whole degree', () => {
    const g = new Graph();
    const hub = g.addVertex({ id: 'hub', labels: ['P'], properties: { k: 1, i: 0 } });
    const other = g.addVertex({ id: 'other', labels: ['P'], properties: { k: 2, i: 1 } });

    for (let i = 0; i < 5; i++) {
      g.addEdge({ from: hub, to: other, labels: ['E'], properties: {} });
    }

    g.addEdge({ from: other, to: hub, labels: ['E'], properties: {} });

    expect(c(g, `MATCH (a:P {k: 1})-[:E]->(b) RETURN count(*) AS c`)).toBe(5);
    expect(c(g, `MATCH (a:P {k: 1})<-[:E]-(b) RETURN count(*) AS c`)).toBe(1);
    both(g, `MATCH (a:P {k: 1})-[:E]->(b)`);
  });
});
