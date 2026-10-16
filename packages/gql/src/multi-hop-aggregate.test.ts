import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 472: the arity cliff item 469 found on a scan, on a HOP — `detectHopAggregate` takes one
// item, so a pair materialized a `Binding` per EDGE. At 200,000 nodes over 1,000,000 edges:
// `count(*), max(b.age)` 668 -> 157 ms, `min, max` 655 -> 163, with `max(b.age)` alone flat.
//
// The admission set is `foldFor`'s and stays that way: the far-driven walk may visit rows in a
// different order than the general path, so only an order-INDEPENDENT aggregate may ride it
// (item 419). `sum`/`avg` are refused here even though item 468 admits them on an unfiltered
// scan, where no far-driven alternative exists.
describe('two or more aggregates over one hop (item 472)', () => {
  const g = (): Graph => {
    const graph = new Graph();
    const a = graph.addVertex({ labels: ['A'], properties: { name: 'a' } });

    // Far ends: three with `k`, one without, so `count(*)` and `count(b.k)` differ.
    for (const k of [5, 2, 9]) {
      graph.addEdge({
        from: a,
        to: graph.addVertex({ labels: ['B'], properties: { k } }),
        labels: ['E'],
      });
    }

    graph.addEdge({
      from: a,
      to: graph.addVertex({ labels: ['B'], properties: {} }),
      labels: ['E'],
    });

    return graph;
  };

  test('count(*) beside max, each agreeing with its single-aggregate twin', () => {
    const graph = g();
    const [row] = query<{ c: number; m: number }>(
      graph,
      'MATCH (:A)-[:E]->(b) RETURN count(*) AS c, max(b.k) AS m',
    );

    expect(row.c).toBe(
      query<{ c: number }>(graph, 'MATCH (:A)-[:E]->(b) RETURN count(*) AS c')[0].c,
    );
    expect(row.m).toBe(
      query<{ m: number }>(graph, 'MATCH (:A)-[:E]->(b) RETURN max(b.k) AS m')[0].m,
    );
    expect(row).toEqual({ c: 4, m: 9 });
  });

  test('min and max together, and count(b.k) skips the null far end', () => {
    const graph = g();

    expect(query(graph, 'MATCH (:A)-[:E]->(b) RETURN min(b.k) AS lo, max(b.k) AS hi')).toEqual([
      { lo: 2, hi: 9 },
    ]);
    expect(query(graph, 'MATCH (:A)-[:E]->(b) RETURN count(b.k) AS n, count(*) AS tot')).toEqual([
      { n: 3, tot: 4 },
    ]);
  });

  test('COLUMN ORDER follows the projection', () => {
    const graph = g();

    expect(
      Object.keys(
        query(
          graph,
          'MATCH (:A)-[:E]->(b) RETURN max(b.k) AS hi, count(*) AS c, min(b.k) AS lo',
        )[0],
      ),
    ).toEqual(['hi', 'c', 'lo']);
  });

  test('sum and avg are REFUSED on a hop and still answer', () => {
    const graph = g();

    // Item 419: the far-driven walk can reorder, and a float `sum` folded in a different order
    // is the 2.0000000000000000e16-vs-…04e16 divergence that entry records. These must take the
    // general path — and be right, which is what a wrong answer here would expose.
    expect(query(graph, 'MATCH (:A)-[:E]->(b) RETURN sum(b.k) AS s, count(*) AS c')).toEqual([
      { s: 16, c: 4 },
    ]);
    expect(query(graph, 'MATCH (:A)-[:E]->(b) RETURN avg(b.k) AS m, max(b.k) AS hi')).toEqual([
      { m: 16 / 3, hi: 9 },
    ]);
  });

  test('DISTINCT declines, and the answer differs from the non-DISTINCT one', () => {
    const graph = new Graph();
    const a = graph.addVertex({ labels: ['A'], properties: {} });

    // Two far ends sharing a value, so DISTINCT is not vacuous.
    for (const k of [4, 4, 7]) {
      graph.addEdge({
        from: a,
        to: graph.addVertex({ labels: ['B'], properties: { k } }),
        labels: ['E'],
      });
    }

    expect(
      query(graph, 'MATCH (:A)-[:E]->(b) RETURN count(DISTINCT b.k) AS d, count(*) AS c'),
    ).toEqual([{ d: 2, c: 3 }]);
  });

  test('an empty hop gives each aggregate its empty answer', () => {
    const graph = new Graph();

    graph.addVertex({ labels: ['A'], properties: {} });

    expect(
      query(graph, 'MATCH (:A)-[:E]->(b) RETURN count(*) AS c, max(b.k) AS hi, min(b.k) AS lo'),
    ).toEqual([{ c: 0, hi: null, lo: null }]);
  });

  test('the walk can DECLINE at run time, and the general path answers', () => {
    const graph = new Graph();

    graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    // Many starts, one selective far end: this is the shape `detectHopProjection` declines at
    // EXECUTION time, because an index seek on the end it does not drive beats the walk. The
    // decline must reach the general path — the mutant that returned `[]` instead of `null`
    // SURVIVED until a fixture that actually takes the branch.
    const far = graph.addVertex({ labels: ['B'], properties: { k: 5 } });

    for (let i = 0; i < 200; i += 1) {
      const a = graph.addVertex({ labels: ['A'], properties: {} });

      graph.addEdge({ from: a, to: far, labels: ['E'] });
      graph.addEdge({
        from: a,
        to: graph.addVertex({ labels: ['B'], properties: { k: 1000 + i } }),
        labels: ['E'],
      });
    }

    expect(query(graph, 'MATCH (:A)-[:E]->(b {k: 5}) RETURN count(*) AS c, max(b.k) AS m')).toEqual(
      [{ c: 200, m: 5 }],
    );
  });

  test('a group key among the items is grouping, not this path', () => {
    const graph = g();
    const rows = query<{ k: number | null; n: number }>(
      graph,
      'MATCH (:A)-[:E]->(b) RETURN b.k AS k, count(*) AS n ORDER BY k',
    );

    expect(rows.length).toBe(4);
  });

  test('an aggregate NESTED in an item declines', () => {
    const graph = g();

    expect(query(graph, 'MATCH (:A)-[:E]->(b) RETURN max(b.k) + 1 AS hi, count(*) AS c')).toEqual([
      { hi: 10, c: 4 },
    ]);
  });
});
