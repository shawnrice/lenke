import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The dedup walk read its hop through `expand`, a generator that allocates a `{ edge, node }` per
// edge AND resolves the far endpoint through a getter — a string-keyed `Map.get` — whether or not
// anything reads it. A simple directed single-type hop now reads its adjacency bucket directly and
// resolves the far vertex only when the projection or a far-end label filter needs it, which is
// what the count shortcuts' per-vertex walks already do (audit item 194).
//
// Nothing about the ANSWER may change, and the delicate parts are:
//
//   - the ORDER, which must stay the bucket order `expand`'s own fast path yields;
//   - the far vertex still being resolved when a FAR LABEL filter needs it, even though the
//     projection reads the START — the one case where "does anything read the far end?" has two
//     answers;
//   - the shapes that keep `expand`: `both`, a type disjunction, and an untyped hop.
//
// The fixture inserts edges OUT of sorted order so a walk that reordered anything shows up, gives
// one vertex a self-loop, leaves one vertex with no edges, and labels the far ends differently.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], n: number) =>
    g.addVertex({ id, labels, properties: { n } });

  const a = v('a', ['P'], 1);
  const b = v('b', ['P'], 2);
  const y = v('y', ['Q'], 30);
  const z = v('z', ['R'], 20);

  v('lonely', ['P'], 9); // no edges at all
  const w = v('w', ['W'], 77); // reaches b, and is reachable ONLY by an IN edge

  // b's edges first, so bucket order is NOT id order.
  g.addEdge({ from: w, to: b, labels: ['T'], properties: {} });
  g.addEdge({ from: b, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: y, to: y, labels: ['T'], properties: {} }); // self-loop
  g.addEdge({ from: b, to: y, labels: ['S'], properties: {} }); // another type

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the dedup walk declines. */
const viaGeneral = (q: string): unknown => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const both = (q: string): void => {
  expect(query(g, q)).toEqual(viaGeneral(q));
};

describe('a dedup over a hop reads the bucket directly', () => {
  test('keyed on the FAR end, values and ORDER match the general path', () => {
    const q = 'MATCH (s:P)-[:T]->(f) RETURN DISTINCT f.n AS x';

    both(q);
    // `candidateVertices` iterates the START bucket in insertion order (a, then b), and a's T
    // bucket is [y, z] — so 30 (y) precedes 20 (z). My first guess here was the reverse, from
    // reading the EDGE insertion order; the start-vertex order is what drives the walk.
    expect(query(g, q)).toEqual([{ x: 30 }, { x: 20 }]);
  });

  test('keyed on the START end, which no longer resolves the far vertex', () => {
    const q = 'MATCH (s:P)-[:T]->(f) RETURN DISTINCT s.n AS x';

    both(q);
    expect(query(g, q)).toEqual([{ x: 1 }, { x: 2 }]);
  });

  test('a REVERSED hop reads the in-adjacency', () => {
    const q = 'MATCH (s:P)<-[:T]-(f) RETURN DISTINCT f.n AS x';

    both(q);
  });

  test('keyed on the START end WITH a far-end label filter', () => {
    // The case where "does anything read the far end?" has two answers: the projection does not,
    // but the label filter does. A walk that skipped the resolution here would test the label
    // against the START vertex and answer wrongly.
    const q = 'MATCH (s:P)-[:T]->(f:Q) RETURN DISTINCT s.n AS x';

    both(q);
    // Only a->y has a Q far end, so only a (n = 1) survives. Testing `s` against :Q instead
    // would answer NOTHING, since s is :P.
    expect(query(g, q)).toEqual([{ x: 1 }]);
  });

  test('keyed on the FAR end WITH a far-end label filter', () => {
    const q = 'MATCH (s:P)-[:T]->(f:R) RETURN DISTINCT f.n AS x';

    both(q);
    expect(query(g, q)).toEqual([{ x: 20 }]);
  });

  test('a far-end label that matches NOTHING yields no rows', () => {
    expect(query(g, 'MATCH (s:P)-[:T]->(f:Nope) RETURN DISTINCT f.n AS x')).toEqual([]);
  });

  test('a vertex with no bucket at all is skipped', () => {
    // `lonely` has no T edges; the direct read must treat a missing bucket as no steps rather
    // than as a step with an undefined edge.
    const q = 'MATCH (s:P)-[:T]->(f) RETURN DISTINCT s.n AS x';

    expect(query(g, q)).toEqual([{ x: 1 }, { x: 2 }]);
    expect(query(g, q)).not.toContainEqual({ x: 9 });
  });

  test('a self-loop is one step, counted once', () => {
    const q = 'MATCH (s:Q)-[:T]->(f) RETURN DISTINCT f.n AS x';

    both(q);
    expect(query(g, q)).toEqual([{ x: 30 }]);
  });

  test('an edge type with no edges yields no rows', () => {
    expect(query(g, 'MATCH (s:P)-[:NONE]->(f) RETURN DISTINCT f.n AS x')).toEqual([]);
  });

  test('only the named type is walked', () => {
    const q = 'MATCH (s:P)-[:S]->(f) RETURN DISTINCT f.n AS x';

    both(q);
    // Only b-S->y exists.
    expect(query(g, q)).toEqual([{ x: 30 }]);
  });

  describe('shapes that keep the general expand', () => {
    test('an UNDIRECTED hop sees the IN edges too', () => {
      const q = 'MATCH (s:P)-[:T]-(f) RETURN DISTINCT f.n AS x';

      both(q);
      // `w` (77) reaches b only by an IN edge, so an out-only read would miss it — which is
      // what a mutant taking the direct path for `both` does, and nothing caught it until this
      // fixture had an incoming edge to a P vertex at all.
      expect(query(g, q)).toContainEqual({ x: 77 });
    });

    test('a type DISJUNCTION', () => {
      both('MATCH (s:P)-[:T|S]->(f) RETURN DISTINCT f.n AS x');
    });

    test('an UNTYPED hop', () => {
      both('MATCH (s:P)-[]->(f) RETURN DISTINCT f.n AS x');
    });
  });

  test('a sort and a window still apply over the walked rows', () => {
    expect(query(g, 'MATCH (s:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x')).toEqual([
      { x: 20 },
      { x: 30 },
    ]);
    // Without the sort the same query is 30 then 20, so the sort is doing real work here.
    expect(
      query(g, 'MATCH (s:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x DESC LIMIT 1'),
    ).toEqual([{ x: 30 }]);
  });

  test('a clause WHERE over the keyed end is still carried', () => {
    const q = 'MATCH (s:P)-[:T]->(f) WHERE f.n > 25 RETURN DISTINCT f.n AS x';

    both(q);
    expect(query(g, q)).toEqual([{ x: 30 }]);
  });

  test('the GROUP BY spelling walks the same way', () => {
    const q = 'MATCH (s:P)-[:T]->(f) LET x = f.n RETURN x GROUP BY x';

    expect(query(g, q)).toEqual([{ x: 30 }, { x: 20 }]);
  });
});
