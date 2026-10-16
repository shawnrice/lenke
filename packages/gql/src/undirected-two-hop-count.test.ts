import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 483: an UNDIRECTED leg in the two-hop degree product. Each factor becomes an undirected
// degree — out + in, minus the self-loops, because a loop is indexed under both adjacency maps
// and `expand` yields it once.
//
// It is a PRODUCT at all only because a two-hop may return along the edge it arrived on: both
// engines answer 6 for `(:P)-[:T]-(x)-[:T]-(y)` over the path a-b-c, which is 1 + 2^2 + 1. That
// was checked against both engines BEFORE the formula was written.
//
// 7286 -> 325 ms at 200,000 nodes / 1,000,000 edges.
//
// Every case is compared against the same query with a clause `WHERE` — a filtered two-hop with
// an undirected leg has no fast arm, so that spelling genuinely runs the general path.
const both = (g: Graph, pattern: string): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} RETURN count(*) AS c`)[0].c;
  const slow = query<{ c: number }>(g, `MATCH ${pattern} WHERE true RETURN count(*) AS c`)[0].c;

  expect(fast).toBe(slow);

  return fast;
};

describe('an undirected leg in a two-hop count (item 483)', () => {
  test('the path a-b-c: 1 + 2^2 + 1', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'e2', from: b, to: c, labels: ['T'], properties: {} });
    expect(both(g, '(:P)-[:T]-(x)-[:T]-(y)')).toBe(6);
  });

  test('a SELF-LOOP contributes a degree of one, not two', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });
    // a: the loop alone, degree 1 -> 1 row. Nothing else is connected.
    expect(both(g, '(:P)-[:T]-(x)-[:T]-(y)')).toBe(1);

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
    // a: degree 2 (loop + edge) -> 4; b: degree 1 -> 1. Five in all.
    expect(both(g, '(:P)-[:T]-(x)-[:T]-(y)')).toBe(5);
  });

  test('a MIXED pattern: one undirected leg and one directed', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'bc', from: b, to: c, labels: ['T'], properties: {} });
    // x = a: one undirected way back (b) times one out-edge (b) = 1. x = b: two undirected
    // (a, c) times one out-edge (c) = 2. x = c: no out-edge. Three — I first wrote 2, and the
    // oracle is what corrected it.
    expect(both(g, '(:P)-[:T]-(x)-[:T]->(y)')).toBe(3);
    expect(both(g, '(:P)-[:T]->(x)-[:T]-(y)')).toBe(3);
  });

  test('END LABELS select on both legs', () => {
    const g = new Graph();
    const p = g.addVertex({ id: 'p', labels: ['P'], properties: {} });
    const m = g.addVertex({ id: 'm', labels: ['M'], properties: {} });
    const q = g.addVertex({ id: 'q', labels: ['Q'], properties: {} });

    g.addEdge({ id: 'pm', from: p, to: m, labels: ['T'], properties: {} });
    g.addEdge({ id: 'qm', from: q, to: m, labels: ['T'], properties: {} });
    // Middle m has undirected degree 2 towards each end; P at one end and Q at the other gives
    // exactly one row per orientation.
    expect(both(g, '(:P)-[:T]-(x:M)-[:T]-(y:Q)')).toBe(1);
    expect(both(g, '(:Q)-[:T]-(x:M)-[:T]-(y:P)')).toBe(1);
    expect(both(g, '(:P)-[:T]-(x:M)-[:T]-(y)')).toBe(2);
    expect(both(g, '(:P)-[:T]-(x:Q)-[:T]-(y)')).toBe(0);
  });

  test('the edge TYPE selects per leg, and a multi-type edge is not double counted', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'ts', from: a, to: b, labels: ['T', 'S'], properties: {} });
    expect(both(g, '(:P)-[:T]-(x)-[:S]-(y)')).toBe(2);
    expect(both(g, '(:P)-[:T|S]-(x)-[:T]-(y)')).toBe(2);
    expect(both(g, '(:P)-[:S]-(x)-[:S]-(y)')).toBe(2);
  });

  test('a loop of ANOTHER type is not subtracted from this one', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'loopS', from: a, to: a, labels: ['S'], properties: {} });
    // Over T alone: a and b each have degree 1 -> two rows. The S loop must not touch it.
    expect(both(g, '(:P)-[:T]-(x)-[:T]-(y)')).toBe(2);
    expect(both(g, '(:P)-[:S]-(x)-[:S]-(y)')).toBe(1);
  });

  test('a loop whose far end FAILS the end label is never subtracted', () => {
    const g = new Graph();
    const m = g.addVertex({ id: 'm', labels: ['P'], properties: {} });
    const q = g.addVertex({ id: 'q', labels: ['Q'], properties: {} });

    g.addEdge({ id: 'loop', from: m, to: m, labels: ['T'], properties: {} });
    g.addEdge({ id: 'mq', from: m, to: q, labels: ['T'], properties: {} });

    // With an end label of `Q`, the loop at `m` was never COUNTED on that side, so subtracting
    // it would take the product below the truth. For x = m: the `:P` start side counts the loop
    // only (its far end is `m`, a P), and the `:Q` end side counts `mq` only — one row. For
    // x = q there is no Q on the far side at all. One in total; I first wrote 2 by forgetting
    // the START label, and the oracle corrected it.
    //
    // The mutant that dropped the far-label test inside the loop scan SURVIVED until this: every
    // other fixture here has loops at vertices that satisfy every label in play.
    expect(both(g, '(:P)-[:T]-(x)-[:T]-(y:Q)')).toBe(1);
    expect(both(g, '(:Q)-[:T]-(x)-[:T]-(y:Q)')).toBe(1);
  });

  test('a FILTERED undirected two-hop declines and still answers', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 9 } });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
    // The walk behind a filtered two-hop captures ONE direction, so this shape must stay on the
    // general path — and be right, which a wrongly-admitted leg would break.
    expect(query(g, 'MATCH (s:P)-[:T]-(x)-[:T]-(y) WHERE s.k > 1 RETURN count(*) AS c')).toEqual([
      { c: 1 },
    ]);
    expect(query(g, 'MATCH (s:P {k: 1})-[:T]-(x)-[:T]-(y) RETURN count(*) AS c')).toEqual([
      { c: 1 },
    ]);
  });
});
