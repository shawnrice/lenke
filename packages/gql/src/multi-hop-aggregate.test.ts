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

  // Item 478: an UNDIRECTED hop runs the directed walk TWICE (out, then in) and folds both.
  // That emits all out-rows before all in-rows where the general path interleaves them per
  // start vertex, so it is sound only because every admitted fold is order-independent. These
  // cases are the ones where a reordering or a double-count would show.
  describe('undirected (item 478)', () => {
    const two = (): Graph => {
      const graph = new Graph();
      const a = graph.addVertex({ labels: ['A'], properties: { k: 1 } });
      const b = graph.addVertex({ labels: ['A'], properties: { k: 2 } });
      const far = graph.addVertex({ labels: ['B'], properties: { k: 9 } });

      // One edge BETWEEN two matching starts: the general path yields it once per orientation.
      graph.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
      graph.addEdge({ from: a, to: far, labels: ['E'], properties: {} });

      return graph;
    };

    test('an edge between two matching ends is counted from both sides', () => {
      const graph = two();

      // `ORDER BY` declines the rung, so the general path answers the same question; for a
      // one-row aggregate it is an exact oracle.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, max(x.k) AS m')).toEqual(
        query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, max(x.k) AS m ORDER BY c'),
      );
      // a-b (from a), a-far (from a), b-a (from b) = 3.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, max(x.k) AS m')).toEqual([
        { c: 3, m: 9 },
      ]);
    });

    test('a SELF-LOOP agrees with the general path, on BOTH aggregate rungs', () => {
      const graph = new Graph();
      const a = graph.addVertex({ labels: ['A'], properties: { k: 5 } });

      graph.addEdge({ from: a, to: a, labels: ['E'], properties: {} });
      // The multi-aggregate rung.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, min(x.k) AS lo')).toEqual(
        query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, min(x.k) AS lo ORDER BY c'),
      );
      // The SINGLE-aggregate rung, which has its own copy of the decline — and whose mutant
      // SURVIVED until this line, because every self-loop case went through the multi one.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(x.k) AS c')).toEqual([{ c: 1 }]);
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN max(x.k) AS m')).toEqual([{ m: 5 }]);
      // A graph with a loop AND a plain edge: the decline is per GRAPH, so the plain edge's
      // rows go through the general path too and must still be right.
      const b = graph.addVertex({ labels: ['B'], properties: { k: 9 } });

      graph.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(x.k) AS c, max(x.k) AS m')).toEqual([
        { c: 2, m: 9 },
      ]);
    });

    test('an EXTREMUM is served over a graph WITH self-loops (item 479)', () => {
      const graph = new Graph();
      const a = graph.addVertex({ labels: ['A'], properties: { k: 5 } });
      const far = graph.addVertex({ labels: ['B'], properties: { k: 9 } });

      graph.addEdge({ from: a, to: a, labels: ['E'], properties: {} });
      graph.addEdge({ from: a, to: far, labels: ['E'], properties: {} });

      // `min`/`max` do not care how often a row appears, so the two-walk scheme runs here even
      // though `selfLoopCount` is 1 — and must agree with the general path, which `ORDER BY`
      // forces. A wrong answer here would mean the idempotence claim is false.
      for (const q of [
        'MATCH (:A)-[:E]-(x) RETURN max(x.k) AS m',
        'MATCH (:A)-[:E]-(x) RETURN min(x.k) AS lo',
        'MATCH (:A)-[:E]-(x) RETURN min(x.k) AS lo, max(x.k) AS hi',
      ]) {
        expect(query(graph, q)).toEqual(query(graph, `${q} ORDER BY 1`));
      }

      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN min(x.k) AS lo, max(x.k) AS hi')).toEqual([
        { lo: 5, hi: 9 },
      ]);
      // A COUNT beside them re-arms the decline, and that answer must stay right: the loop is
      // one row (`expand` yields it once), the plain edge two (once from each end is not
      // possible here — `far` is not an `A`), so 2.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, max(x.k) AS m')).toEqual([
        { c: 2, m: 9 },
      ]);
    });

    test('min and max over an undirected hop, and the single-aggregate twin', () => {
      const graph = two();

      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN min(x.k) AS lo, max(x.k) AS hi')).toEqual([
        { lo: 1, hi: 9 },
      ]);
      // The single-aggregate rung takes the same two-walk arrangement.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(x.k) AS c')).toEqual([{ c: 3 }]);
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN max(x.k) AS m')).toEqual([{ m: 9 }]);
    });

    test('the EDGE TYPE still selects on an undirected hop', () => {
      const graph = new Graph();
      const a = graph.addVertex({ labels: ['A'], properties: {} });

      graph.addEdge({
        from: a,
        to: graph.addVertex({ labels: ['B'], properties: { k: 1 } }),
        labels: ['E'],
        properties: {},
      });
      graph.addEdge({
        from: graph.addVertex({ labels: ['B'], properties: { k: 9 } }),
        to: a,
        labels: ['OTHER'],
        properties: {},
      });

      // The `OTHER` edge points AT `a`, so a direction bug and a type bug would each pull it in.
      expect(query(graph, 'MATCH (:A)-[:E]-(x) RETURN count(*) AS c, max(x.k) AS m')).toEqual([
        { c: 1, m: 1 },
      ]);
    });
  });

  test('an aggregate NESTED in an item declines', () => {
    const graph = g();

    expect(query(graph, 'MATCH (:A)-[:E]->(b) RETURN max(b.k) + 1 AS hi, count(*) AS c')).toEqual([
      { hi: 10, c: 4 },
    ]);
  });
});
