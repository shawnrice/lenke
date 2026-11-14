import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS a TYPE-ALTERNATION hop produces on the two-segment rung — item 1846.
 *
 * `hopOf` models a hop as one `type: string`, so `-[:E|F]->` declined `detectHop2Projection` and
 * fell to the general matcher at **651 ns a row against the single-type spelling's 91**.
 * `walkUnion` takes it: 7.61x, and 19.72x with a `RETURN DISTINCT` on top.
 *
 * ⚠️ THE DOUBLE-COUNT IS THE WHOLE RISK, and it is invisible on an ordinary fixture. Iterating the
 * `E` bucket and then the `F` bucket visits an edge carrying BOTH labels twice, where `[:E|F]` must
 * yield it once. So every fixture below that tests the union carries a MULTI-LABEL edge, and the
 * oracle is the two-clause spelling (`MATCH … MATCH …`), which cannot reach this rung at all.
 *
 * ⚠️ AND THE GUARD IS A RUN-TIME ONE, which is why an answer test can reach it: the walk reads
 * `graph.multiTypeEdgeCount` per execution and only pays for de-duplication when the graph actually
 * holds such an edge. A fixture with no multi-label edge therefore exercises the FAST arm, and one
 * with a multi-label edge exercises the DEDUPING arm — both are tested, because a bug in either is
 * a wrong answer and they are different code.
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

type EdgeSpec = [id: string, from: string, to: string, labels: string[]];

const build = (vertices: readonly string[], edges: readonly EdgeSpec[]): Graph => {
  const g = new Graph();

  for (const id of vertices) {
    g.addVertex({ id, labels: ['T'], properties: { n: id } });
  }

  for (const [id, from, to, labels] of edges) {
    const f = g.getVertexById(from);
    const t = g.getVertexById(to);

    if (f === null || t === null) {
      throw new Error('fixture is broken: a vertex is missing');
    }

    g.addEdge({ id, from: f, to: t, labels });
  }

  return g;
};

const rows = (g: Graph, text: string): string[] =>
  query(g, text)
    .map((r) => Object.values(r).map(String).join('/'))
    .sort();

/** A chain where the middle edge carries BOTH types, so a double count is observable. */
const multiLabelled = (): Graph =>
  build(
    ['a', 'b', 'c', 'd'],
    [
      ['e1', 'a', 'b', ['E', 'F']],
      ['e2', 'b', 'c', ['E', 'F']],
      ['e3', 'a', 'c', ['E']],
      ['e4', 'c', 'd', ['F']],
      ['e5', 'b', 'd', ['E']],
    ],
  );

/** The same shape with every edge single-labelled, which takes the NON-deduping arm. */
const singleLabelled = (): Graph =>
  build(
    ['a', 'b', 'c', 'd'],
    [
      ['e1', 'a', 'b', ['E']],
      ['e2', 'b', 'c', ['F']],
      ['e3', 'a', 'c', ['E']],
      ['e4', 'c', 'd', ['F']],
      ['e5', 'b', 'd', ['E']],
    ],
  );

describe('a type-alternation hop', () => {
  /**
   * ⚠️ THE ORACLE IS THE TWO-CLAUSE SPELLING. `MATCH (a)-[:E|F]->(b) MATCH (b)-[:E|F]->(c)` asks
   * the same question with two clauses, which this rung requires exactly two clauses to claim — so
   * it runs the general matcher and is a genuine second implementation rather than a hand-written
   * expectation.
   */
  test('agrees with the two-clause route, multi-label edges included', () => {
    for (const g of [multiLabelled(), singleLabelled()]) {
      for (const [one, two] of [
        [
          'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN a.n AS x, c.n AS y',
          'MATCH (a:T)-[:E|F]->(b:T) MATCH (b)-[:E|F]->(c:T) RETURN a.n AS x, c.n AS y',
        ],
        // Incoming direction, which uses the other adjacency box on both hops.
        [
          'MATCH (a:T)<-[:E|F]-(b:T)<-[:E|F]-(c:T) RETURN a.n AS x, c.n AS y',
          'MATCH (a:T)<-[:E|F]-(b:T) MATCH (b)<-[:E|F]-(c:T) RETURN a.n AS x, c.n AS y',
        ],
        // Mixed directions.
        [
          'MATCH (a:T)-[:E|F]->(b:T)<-[:E|F]-(c:T) RETURN a.n AS x, c.n AS y',
          'MATCH (a:T)-[:E|F]->(b:T) MATCH (b)<-[:E|F]-(c:T) RETURN a.n AS x, c.n AS y',
        ],
      ]) {
        const got = rows(g, one);

        expect(got.length).toBeGreaterThan(0);
        expect(got).toEqual(rows(g, two));
      }
    }
  });

  /**
   * ⚠️ THE EXPLICIT DOUBLE-COUNT CASE, stated as a count rather than only as an agreement: with
   * every edge carrying both labels, `[:E|F]` must yield exactly the paths `[:E]` yields, because
   * the two label sets select the same edges.
   */
  test('an edge carrying both types is yielded ONCE', () => {
    const g = build(
      ['a', 'b', 'c'],
      [
        ['e1', 'a', 'b', ['E', 'F']],
        ['e2', 'b', 'c', ['E', 'F']],
      ],
    );

    expect(g.multiTypeEdgeCount).toBe(2);

    const union = rows(g, 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN a.n AS x, c.n AS y');

    expect(union).toEqual(['a/c']);
    // Every edge is an `E`, so the single-type spelling selects the same edges and must agree.
    expect(union).toEqual(rows(g, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y'));
  });

  /** A repeated type in the spelling must not double the rows either. */
  test('a duplicated type in the alternation is yielded once', () => {
    const g = singleLabelled();

    expect(rows(g, 'MATCH (a:T)-[:E|E]->(b:T)-[:E|E]->(c:T) RETURN a.n AS x, c.n AS y')).toEqual(
      rows(g, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y'),
    );
  });

  test('a three-way alternation, and one naming an absent type', () => {
    const g = multiLabelled();

    expect(
      rows(g, 'MATCH (a:T)-[:E|F|ZZ]->(b:T)-[:E|F|ZZ]->(c:T) RETURN a.n AS x, c.n AS y'),
    ).toEqual(rows(g, 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN a.n AS x, c.n AS y'));
    // An alternation of ONLY absent types matches nothing, and must not throw.
    expect(rows(g, 'MATCH (a:T)-[:ZZ|YY]->(b:T)-[:ZZ|YY]->(c:T) RETURN a.n AS x')).toEqual([]);
  });

  /** Mixed widths: one segment a single type, the other an alternation. */
  test('one single-type segment and one alternation', () => {
    const g = multiLabelled();

    for (const [one, two] of [
      [
        'MATCH (a:T)-[:E]->(b:T)-[:E|F]->(c:T) RETURN a.n AS x, c.n AS y',
        'MATCH (a:T)-[:E]->(b:T) MATCH (b)-[:E|F]->(c:T) RETURN a.n AS x, c.n AS y',
      ],
      [
        'MATCH (a:T)-[:E|F]->(b:T)-[:F]->(c:T) RETURN a.n AS x, c.n AS y',
        'MATCH (a:T)-[:E|F]->(b:T) MATCH (b)-[:F]->(c:T) RETURN a.n AS x, c.n AS y',
      ],
    ]) {
      expect(rows(g, one)).toEqual(rows(g, two));
    }
  });

  /** The carried `WHERE` and the fused one-column `DISTINCT` (item 1843) over a union. */
  test('a carried WHERE and a DISTINCT over the alternation', () => {
    const g = multiLabelled();

    expect(
      rows(g, 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) WHERE a.n <> c.n RETURN c.n AS x'),
    ).toEqual(
      rows(g, 'MATCH (a:T)-[:E|F]->(b:T) MATCH (b)-[:E|F]->(c:T) WHERE a.n <> c.n RETURN c.n AS x'),
    );

    const distinct = rows(g, 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN DISTINCT c.n AS x');

    expect(distinct).toEqual([
      ...new Set(rows(g, 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN c.n AS x')),
    ]);
  });
});
