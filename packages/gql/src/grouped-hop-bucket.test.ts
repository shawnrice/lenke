import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { directedBucket } from './graph-queries.ts';
import { query } from './index.ts';

/**
 * `detectGroupedHopCount`'s per-edge arm reads the ONE bucket directly instead of going through
 * `expand`'s generator (item 1621) — **1.83x** on the far-keyed grouped hop count.
 *
 * `expand` yields a fresh `{ edge, node }` per edge, so a caller pays one generator resume and one
 * object allocation per edge; it was **16.3%** of this shape's profile with the garbage collector at
 * 8.1% beside it. For a directed single-type hop there is one `Set` to walk and nothing to dedupe.
 *
 * ⚠️ THE HISTORICAL BUG IS THE WHOLE REASON THIS FILE EXISTS. `detectGroupedHopCount`'s own comment
 * records that hand-rolling the general case counted a `T|S` edge **TWICE** under `-[:T|S]->`,
 * because the per-type buckets both hold it and only `expand`'s `Set` dedupes across them. So
 * `directedBucket` returns a shape ONLY for the directed single-type case and the multi-type arm
 * still goes through `expand` — and both arms are exercised here against the SAME fixture, because
 * the loop body is now written twice and drift between the two copies is the risk the duplication
 * carries.
 *
 * ```text
 *   a [P] k=1  >b   ~c        `>` is T, `~` is S
 *   b [P] k=2  >c
 *   c [Q] k=1  >a
 *   d [P] k=2            no out-edges
 *   e [P] k=1  =f             `=` is an edge carrying BOTH T and S
 *   f [Q] k=2
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['P'],
    k: 1,
    out: [
      ['b', ['T']],
      ['c', ['S']],
    ],
  },
  { id: 'b', labels: ['P'], k: 2, out: [['c', ['T']]] },
  { id: 'c', labels: ['Q'], k: 1, out: [['a', ['T']]] },
  { id: 'd', labels: ['P'], k: 2, out: [] },
  { id: 'e', labels: ['P'], k: 1, out: [['f', ['T', 'S']]] },
  { id: 'f', labels: ['Q'], k: 2, out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    graph.addVertex({ id: r.id, labels: [...r.labels], properties: { id: r.id, k: r.k } });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, labels] of r.out) {
      graph.addEdge({
        id: `e${n++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: [...labels],
        properties: {},
      });
    }
  }

  return graph;
})();

const rows = (src: string): Record<string, unknown>[] =>
  (query(g, src) as Record<string, unknown>[])
    .map((r) => r)
    .sort((x, y) => (x.k as number) - (y.k as number));

describe('the grouped hop count reads one bucket for a directed single type', () => {
  test('keyed on the FAR end — the shape at 1.83x', () => {
    /**
     * Derived. `T` edges: a>b, b>c, c>a, e>f. Far ends b(k=2), c(k=1), a(k=1), f(k=2) — so k=1 has
     * two and k=2 has two.
     */
    expect(rows('MATCH (x)-[:T]->(y) RETURN y.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 2 },
      { k: 2, c: 2 },
    ]);
  });

  test('the IN direction, which reads the other box', () => {
    // `T` sources: a, b, c, e — k = 1, 2, 1, 1. Keyed on the SOURCE via an `in` hop's far end.
    expect(rows('MATCH (y)<-[:T]-(x) RETURN x.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 3 },
      { k: 2, c: 1 },
    ]);
  });

  test('a FAR LABEL applied per edge', () => {
    // `T` edges whose far end is `Q`: b>c and e>f — k = 1 and 2.
    expect(rows('MATCH (x)-[:T]->(y:Q) RETURN y.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 1 },
      { k: 2, c: 1 },
    ]);
  });

  test('a zero-degree vertex contributes nothing and does not divert the route', () => {
    /**
     * `directedBucket` returns a SHAPE for an empty bucket rather than `undefined`: `undefined`
     * means "this pattern needs `expand`", and conflating that with "this vertex has no such edge"
     * would send every zero-degree vertex down the general path. `d` and `f` have no `T` out-edge.
     */
    expect(
      directedBucket(g.getVertexById('d') as Vertex, {
        direction: 'out',
        label: { kind: 'label', name: 'T' },
      }),
    ).toEqual({ set: new Set(), forward: true });
    expect(rows('MATCH (x)-[:T]->(y) RETURN y.k AS k, count(*) AS c')).toHaveLength(2);
  });

  test('⚠️ a MULTI-TYPE hop still dedupes — the double-count this file exists for', () => {
    /**
     * The `e>f` edge carries BOTH `T` and `S`, so it sits in two per-type buckets. Under `-[:T|S]->`
     * it must be counted ONCE. `directedBucket` declines a label disjunction, so this goes through
     * `expand`, whose `Set` is what dedupes.
     *
     * Derived: `T|S` edges are a>b, a>c, b>c, c>a, e>f (five DISTINCT edges, not six). Far ends
     * b(2), c(1), c(1), a(1), f(2) — k=1 three, k=2 two.
     */
    expect(rows('MATCH (x)-[:T|S]->(y) RETURN y.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 3 },
      { k: 2, c: 2 },
    ]);
    expect(
      directedBucket(g.getVertexById('e') as Vertex, {
        direction: 'out',
        label: {
          kind: 'or',
          left: { kind: 'label', name: 'T' },
          right: { kind: 'label', name: 'S' },
        },
      }),
    ).toBeUndefined();
  });

  test('`both` declines, because it reads a self-loop from either end', () => {
    expect(
      directedBucket(g.getVertexById('a') as Vertex, {
        direction: 'both',
        label: { kind: 'label', name: 'T' },
      }),
    ).toBeUndefined();
    /**
     * And the answer through `expand` is right. ⚠️ DERIVED BY A SCRIPT, after I wrote 4/4 by eye and
     * the engine answered 5/3 — the eighteenth eyeballed literal this session it was right about.
     * Each of the four `T` edges is seen from BOTH ends, so the eight far ends are b(2), a(1), c(1),
     * b(2), a(1), c(1), f(2), e(1): five at k=1 and three at k=2. "Symmetric" is not the same as
     * "evenly split", which is what the wrong literal assumed.
     */
    expect(rows('MATCH (x)-[:T]-(y) RETURN y.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 5 },
      { k: 2, c: 3 },
    ]);
  });

  test('an UNTYPED hop declines, since it walks every bucket', () => {
    expect(
      directedBucket(g.getVertexById('a') as Vertex, { direction: 'out', label: undefined }),
    ).toBeUndefined();
    // Five distinct edges; far ends b(2), c(1), c(1), a(1), f(2).
    expect(rows('MATCH (x)-[]->(y) RETURN y.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 3 },
      { k: 2, c: 2 },
    ]);
  });

  test('⚠️ the two loop bodies agree — the START-keyed arm takes neither', () => {
    /**
     * Keyed on the START, the rung takes its DEGREE arm instead of either per-edge body, which is
     * why that shape measured FLAT across this change (6.014 ms against 6.214). Asserted so the
     * three routes stay distinguishable: a change that collapsed them would pass the two tests above
     * and still be wrong here.
     */
    expect(rows('MATCH (x)-[:T]->(y) RETURN x.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 3 },
      { k: 2, c: 1 },
    ]);
    expect(rows('MATCH (x)-[:T|S]->(y) RETURN x.k AS k, count(*) AS c')).toEqual([
      { k: 1, c: 4 },
      { k: 2, c: 1 },
    ]);
  });
});
