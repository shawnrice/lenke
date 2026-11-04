import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * The undirected hop's EDGE-INDEX route and the labels that must decline it (item 1431).
 *
 * `undirectedHopWalk` used to iterate every VERTEX twice — once for `adjFrom`, once for `adjTo` — to
 * produce two rows per edge. When neither label filters it now makes ONE pass over
 * `graph.edgesByLabel.get(type)` instead: **5.0x at small stride and 5.9x at random**, on identical
 * row counts and digests. Item 1430 priced it at ~12.5x against a hand-written floor before it was
 * built.
 *
 * ⚠️ THE GATE IS THE ONLY THING STANDING BETWEEN THIS AND WRONG ROWS, AND THE BENCH CANNOT TEST IT.
 * `isolated-row-bench.mjs`'s `MULTILABEL` knob varies EDGE labels; every vertex in it is always `P`,
 * so the route always fires there and a broken gate would never show up in a measurement. These
 * tests are the guard.
 *
 * The route requires BOTH labels free — absent, or carried by every vertex. A filtering label keeps
 * the two-pass walk, because an edge pass enumerates EDGES and each one yields a row with `from` as
 * start and another with `to` as start, so a real start label would cost a `matchesLabel` per
 * ENDPOINT per edge. `vacuousLabel` is FALSE for `undefined`, so the absent case needs its own test
 * — a detail that would otherwise silently route every unlabelled hop down the slow path.
 *
 * ⚠️ AND THE DECISION IS PER CALL, because vacuity is a property of the GRAPH. The same query text
 * is correct on one graph and wrong on another if it is mis-decided, which the last describe block
 * pins by running one query against both fixtures in both orders.
 */

/** Rows as a sorted multiset, so the route's deliberate reordering is invisible and a value is not. */
const ns = (g: Graph, src: string): unknown[] =>
  query(g, src)
    .map((r) => r['n'])
    .slice()
    .sort((x, y) => Number(x) - Number(y));

/**
 * `a -> b` and `b -> c` on `E`, plus `a -> d` on `F`.
 *
 * When `pOnAll` every vertex is `P`, so `:P` is vacuous and the edge route fires. Otherwise `d` is
 * `Q` — and `d` is only ever a FAR end, so the two fixtures have the same start set and differ in
 * exactly the property under test (the trap item 1410 paid for).
 */
const build = (pOnAll: boolean): Graph => {
  const g = new Graph();

  for (const [id, n] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { n } });
  }

  g.addVertex({ id: 'd', labels: [pOnAll ? 'P' : 'Q'], properties: { n: 4 } });

  g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
  g.addEdge({ id: 'bc', from: g.getVertexById('b')!, to: g.getVertexById('c')!, labels: ['E'] });
  g.addEdge({ id: 'ad', from: g.getVertexById('a')!, to: g.getVertexById('d')!, labels: ['F'] });

  return g;
};

describe('both labels free: the edge route fires and the rows are right (item 1431)', () => {
  test('two `E` edges give four rows, each edge seen from both ends', () => {
    // `a-b` from a (far b=2) and from b (far a=1); `b-c` from b (far c=3) and from c (far b=2).
    expect(ns(build(true), 'MATCH (x:P)-[:E]-(y:P) RETURN y.n AS n')).toEqual([1, 2, 2, 3]);
  });

  test('the UNLABELLED spelling agrees — `vacuousLabel` is false for `undefined`', () => {
    // THE CASE THE GATE WOULD MISS if it used `vacuousLabel` alone: an absent label is free too, and
    // treating it as filtering would route every unlabelled hop down the slow path. Same answer
    // either way, so only a route assertion or a measurement could tell — hence it is pinned here
    // as an equality with the labelled form rather than left to the bench.
    const g = build(true);

    expect(ns(g, 'MATCH (x)-[:E]-(y) RETURN y.n AS n')).toEqual(
      ns(g, 'MATCH (x:P)-[:E]-(y:P) RETURN y.n AS n'),
    );
    expect(ns(g, 'MATCH (x)-[:E]-(y) RETURN y.n AS n')).toEqual([1, 2, 2, 3]);
  });

  test('a type with NO edges gives no rows', () => {
    expect(ns(build(true), 'MATCH (x)-[:ZZZ]-(y) RETURN y.n AS n')).toEqual([]);
  });

  test('the other edge type selects only its own edges', () => {
    // `a-d` on `F`: two rows, far ends d=4 and a=1.
    expect(ns(build(true), 'MATCH (x)-[:F]-(y) RETURN y.n AS n')).toEqual([1, 4]);
  });
});

describe('a FILTERING label declines the edge route and still answers correctly (item 1431)', () => {
  test('⚠️ a filtering FAR label keeps only the matching endpoints', () => {
    // `d` is `Q`. On `F` the two rows are (a, far d) and (d, far a); `y:P` keeps only the second.
    // If the gate were ignored and the edge route taken regardless, both would come back.
    expect(ns(build(false), 'MATCH (x)-[:F]-(y:P) RETURN y.n AS n')).toEqual([1]);
  });

  test('and the complementary label picks up exactly the other row', () => {
    expect(ns(build(false), 'MATCH (x)-[:F]-(y:Q) RETURN y.n AS n')).toEqual([4]);
  });

  test('a filtering START label drops the rows whose start does not match', () => {
    // `x:Q` admits only `d` as a start, so the single row is (d, far a=1).
    expect(ns(build(false), 'MATCH (x:Q)-[:F]-(y) RETURN y.n AS n')).toEqual([1]);
  });

  test('a label absent from the graph keeps nothing, on either route', () => {
    expect(ns(build(true), 'MATCH (x)-[:E]-(y:ZZZ) RETURN y.n AS n')).toEqual([]);
    expect(ns(build(false), 'MATCH (x)-[:E]-(y:ZZZ) RETURN y.n AS n')).toEqual([]);
  });

  test('the two label halves partition the unlabelled rows', () => {
    // A relation rather than literals: whatever the routes do, `:P` and `:Q` on the far end must
    // together account for exactly the unlabelled row count.
    const g = build(false);
    const all = query(g, 'MATCH (x)-[:F]-(y) RETURN y.n AS n').length;
    const p = query(g, 'MATCH (x)-[:F]-(y:P) RETURN y.n AS n').length;
    const q = query(g, 'MATCH (x)-[:F]-(y:Q) RETURN y.n AS n').length;

    expect(p + q).toBe(all);
  });
});

describe('a SELF-LOOP yields exactly one row on both routes (item 1431)', () => {
  // The two-pass walk guarantees this by skipping `from === to` in its in-pass; the edge route has
  // to reproduce it explicitly, and an edge pass that forgot would DOUBLE every loop.
  const loop = (pOnAll: boolean): Graph => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.addVertex({ id: 'b', labels: [pOnAll ? 'P' : 'Q'], properties: { n: 2 } });
    g.addEdge({ id: 'aa', from: g.getVertexById('a')!, to: g.getVertexById('a')!, labels: ['E'] });
    g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });

    return g;
  };

  test('on the edge route (labels free): the loop once, the ordinary edge twice', () => {
    expect(ns(loop(true), 'MATCH (x)-[:E]-(y) RETURN y.n AS n')).toEqual([1, 1, 2]);
  });

  test('on the two-pass route (a filtering label): still once', () => {
    // `b` is `Q`, so `y:P` keeps the loop (far a) and the reverse of `a-b` (far a), dropping the
    // forward row whose far end is `b`.
    expect(ns(loop(false), 'MATCH (x)-[:E]-(y:P) RETURN y.n AS n')).toEqual([1, 1]);
  });

  test('a loop on its own, both routes, is one row', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.addEdge({ id: 'aa', from: g.getVertexById('a')!, to: g.getVertexById('a')!, labels: ['E'] });

    expect(ns(g, 'MATCH (x)-[:E]-(y) RETURN y.n AS n')).toEqual([1]);
    expect(ns(g, 'MATCH (x:P)-[:E]-(y:P) RETURN y.n AS n')).toEqual([1]);
  });
});

describe('PARALLEL edges each contribute (item 1431)', () => {
  test('two edges between the same pair give four rows, not two', () => {
    // An edge-index pass must not dedupe by endpoint pair — the `Set` holds edges, and two distinct
    // edges between `a` and `b` are two distinct matches.
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
    g.addEdge({ id: 'e1', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
    g.addEdge({ id: 'e2', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });

    expect(ns(g, 'MATCH (x)-[:E]-(y) RETURN y.n AS n')).toEqual([1, 1, 2, 2]);
  });

  test('an edge carrying TWO types is matched once per type, not twice', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
    g.addEdge({
      id: 'both',
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['E', 'F'],
    });

    expect(ns(g, 'MATCH (x)-[:E]-(y) RETURN y.n AS n')).toEqual([1, 2]);
    expect(ns(g, 'MATCH (x)-[:F]-(y) RETURN y.n AS n')).toEqual([1, 2]);
  });
});

describe('the route decision is PER CALL, not per compile (item 1431)', () => {
  test('⚠️ one query text, two graphs, two different correct answers', () => {
    // THE PER-COMPILE GUARD. A decision cached across calls would answer the second graph with the
    // first graph's route. Asserted in both orders so neither can be the lucky one.
    const Q = 'MATCH (x)-[:F]-(y:P) RETURN y.n AS n';

    expect(ns(build(true), Q)).toEqual([1, 4]);
    expect(ns(build(false), Q)).toEqual([1]);
    expect(ns(build(true), Q)).toEqual([1, 4]);
  });

  test('and adding a vertex that breaks vacuity flips it within one graph', () => {
    const g = build(true);

    expect(ns(g, 'MATCH (x)-[:E]-(y:P) RETURN y.n AS n')).toEqual([1, 2, 2, 3]);

    // A new `Q` vertex makes `:P` non-vacuous, so the next call must take the two-pass route. It is
    // isolated, so the rows do not change — which is exactly why only a wrongly CACHED route could
    // be caught here, and why the answer is asserted again rather than assumed.
    g.addVertex({ id: 'iso', labels: ['Q'], properties: { n: 9 } });

    expect(ns(g, 'MATCH (x)-[:E]-(y:P) RETURN y.n AS n')).toEqual([1, 2, 2, 3]);
  });
});
