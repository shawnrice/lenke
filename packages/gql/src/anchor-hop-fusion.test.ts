// `MATCH (a:L) MATCH (a)-[:T]->(x)` IS `MATCH (a:L)-[:T]->(x)`: two MATCH clauses sharing a
// variable join on it. The native engine costs the same for both spellings; TypeScript's fast
// paths all read ONE `match` clause, so the split spelling fell to the general row pipeline —
// `RETURN count(*)` cost 747.9ms against 0.0, and a projection 805ns/row against 157 (item 505).
//
// The fix is a REWRITE, so the risk is not performance but meaning: this file is what says the
// fused clause asks the same question, and what pins the shapes that must NOT fuse.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: { w: 1 } });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: { w: 2 } });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['S'], properties: { w: 3 } });
  g.addEdge({ id: 'aa', from: a, to: a, labels: ['T'], properties: { w: 4 } });

  return g;
};

const g = build();
// Row order without ORDER BY is unspecified, so every comparison here is a MULTISET one.
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();

describe('anchor-then-traverse fuses into one pattern (item 505)', () => {
  // Each pair is the SAME question in both spellings; the fused one must match the written one.
  const same = (one: string, two: string) => {
    expect(bag(two)).toEqual(bag(one));
    // And neither may be empty, or the pair proves nothing.
    expect(bag(one).length).toBeGreaterThan(0);
  };

  test('the plain shapes agree, one hop and two', () => {
    same(
      'MATCH (a:P)-[:T]->(x) RETURN a.k AS a, x.k AS x',
      'MATCH (a:P) MATCH (a)-[:T]->(x) RETURN a.k AS a, x.k AS x',
    );
    same(
      'MATCH (a:P)-[:T]->(x)-[:S]->(y) RETURN a.k AS a, y.k AS y',
      'MATCH (a:P) MATCH (a)-[:T]->(x)-[:S]->(y) RETURN a.k AS a, y.k AS y',
    );
    same(
      'MATCH (a:P)-[:T]->(x) RETURN count(*) AS c',
      'MATCH (a:P) MATCH (a)-[:T]->(x) RETURN count(*) AS c',
    );
  });

  test('direction, type, labels and inline constraints are carried', () => {
    same(
      'MATCH (a:P)<-[:T]-(x) RETURN a.k AS a, x.k AS x',
      'MATCH (a:P) MATCH (a)<-[:T]-(x) RETURN a.k AS a, x.k AS x',
    );
    same(
      'MATCH (a:P)-[:T]-(x) RETURN a.k AS a, x.k AS x',
      'MATCH (a:P) MATCH (a)-[:T]-(x) RETURN a.k AS a, x.k AS x',
    );
    same(
      'MATCH (a:P {k: 1})-[:T]->(x:Q) RETURN x.k AS x',
      'MATCH (a:P {k: 1}) MATCH (a)-[:T]->(x:Q) RETURN x.k AS x',
    );
    same(
      'MATCH (a:P)-[r:T]->(x) RETURN r.w AS w',
      'MATCH (a:P) MATCH (a)-[r:T]->(x) RETURN r.w AS w',
    );
  });

  test('a WHERE on EITHER side carries, and a self-loop still counts once', () => {
    same(
      'MATCH (a:P)-[:T]->(x) WHERE a.k = 1 RETURN x.k AS x',
      'MATCH (a:P) WHERE a.k = 1 MATCH (a)-[:T]->(x) RETURN x.k AS x',
    );
    same(
      'MATCH (a:P)-[:T]->(x) WHERE x.k = 2 RETURN a.k AS a',
      'MATCH (a:P) MATCH (a)-[:T]->(x) WHERE x.k = 2 RETURN a.k AS a',
    );
    // `a -> a` is a self-loop; fusing must not turn it into something else.
    same(
      'MATCH (a:P)-[:T]->(a) RETURN a.k AS a',
      'MATCH (a:P) MATCH (a)-[:T]->(a) RETURN a.k AS a',
    );
  });

  // The shapes that must NOT fuse. Each would mean something different fused, so each is
  // checked against the answer the unfused pipeline gives.
  test('OPTIONAL does not fuse — a left-outer join is not a join', () => {
    // `lonely` has no T edge, so the optional row survives with a null. Fusing would drop it.
    expect(bag('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN a.k AS a, x.k AS x')).toEqual(
      [
        { a: 1, x: 1 },
        { a: 1, x: 2 },
        { a: 1, x: 3 },
        { a: 2, x: null },
        { a: 9, x: null },
      ]
        .map((r) => JSON.stringify(r))
        .sort(),
    );
  });

  test('a RE-CONSTRAINED start does not fuse, and still filters', () => {
    // `(a:Q)` on the second clause is an extra label test on an already-bound node: `a` is a
    // `:P`, so nothing passes. Fusing by dropping it would answer three rows.
    expect(bag('MATCH (a:P) MATCH (a:Q)-[:T]->(x) RETURN x.k AS x')).toEqual([]);
    expect(bag('MATCH (a:P) MATCH (a {k: 2})-[:T]->(x) RETURN x.k AS x')).toEqual([]);
  });

  test('a second pattern that does not START at the anchor is unaffected', () => {
    same(
      'MATCH (b:P)-[:T]->(a:P) RETURN a.k AS a, b.k AS b',
      'MATCH (a:P) MATCH (b:P)-[:T]->(a) RETURN a.k AS a, b.k AS b',
    );
  });

  test('an anchor that is not a bare node does not fuse', () => {
    // The first clause binds two variables, so there is no single end to attach to.
    same(
      'MATCH (a:P)-[:T]->(m) MATCH (m)-[:S]->(y) RETURN a.k AS a, y.k AS y',
      'MATCH (a:P)-[:T]->(m) MATCH (m)-[:S]->(y) RETURN a.k AS a, y.k AS y',
    );
    expect(bag('MATCH (a:P)-[:T]->(m) MATCH (m)-[:S]->(y) RETURN a.k AS a, y.k AS y')).toEqual([
      JSON.stringify({ a: 1, y: 3 }),
    ]);
  });

  test('a second pattern starting at a DIFFERENT bare variable is a cross product', () => {
    // No shared variable at the start, so there is nothing to fuse onto: this is `a` crossed
    // with every `T` edge. Dropping the start-variable check would fuse it into
    // `(a:P)-[:T]->(x)` — three rows instead of nine, and `b` unbound.
    expect(bag('MATCH (a:P) MATCH (b)-[:T]->(x) RETURN a.k AS a, b.k AS b, x.k AS x')).toEqual(
      bag('MATCH (a:P) MATCH (b)-[:T]->(x) RETURN a.k AS a, b.k AS b, x.k AS x'),
    );
    // Three `:P` anchors crossed with three `T` edges.
    expect(bag('MATCH (a:P) MATCH (b)-[:T]->(x) RETURN a.k AS a, b.k AS b, x.k AS x').length).toBe(
      9,
    );
  });

  test('an anchor WITH segments does not fuse, even sharing its start variable', () => {
    // `MATCH (a:P)-[:T]->(m)` then `MATCH (a)-[:S]->(y)` share `a`, but the anchor already
    // binds `m` — fusing by replacing the second pattern's start would DROP the first hop.
    // `a` has two T-targets reached by the first clause and one S-edge is `b -S-> c`, so `a`
    // has none: the cross is empty, where a bad fusion would answer rows.
    expect(bag('MATCH (a:P)-[:T]->(m) MATCH (a)-[:S]->(y) RETURN m.k AS m, y.k AS y')).toEqual([]);
    // And with an S edge FROM `a`, the two hops multiply rather than replace.
    const h = build();
    const a2 = h.addVertex({ id: 'a2', labels: ['Z'], properties: { k: 7 } });
    const t1 = h.addVertex({ id: 't1', labels: ['Z'], properties: { k: 8 } });

    h.addEdge({ id: 'z1', from: a2, to: t1, labels: ['T'], properties: {} });
    h.addEdge({ id: 'z2', from: a2, to: t1, labels: ['S'], properties: {} });
    expect(query(h, 'MATCH (a:Z)-[:T]->(m) MATCH (a)-[:S]->(y) RETURN m.k AS m, y.k AS y')).toEqual(
      [{ m: 8, y: 8 }],
    );
  });

  test('a clause BETWEEN the two blocks fusion, and the answer is unchanged', () => {
    expect(bag('MATCH (a:P) LET z = a.k MATCH (a)-[:T]->(x) RETURN z AS z, x.k AS x')).toEqual(
      bag('MATCH (a:P)-[:T]->(x) LET z = a.k RETURN z AS z, x.k AS x'),
    );
  });

  test('BOTH clauses carrying a WHERE declines, and answers the same', () => {
    expect(
      bag('MATCH (a:P) WHERE a.k = 1 MATCH (a)-[:T]->(x) WHERE x.k = 2 RETURN x.k AS x'),
    ).toEqual([JSON.stringify({ x: 2 })]);
  });

  test('a THIRD clause does not chain onto the fused one — measured, not assumed', () => {
    // An instrumented run counts 11 fusions across this file, which is exactly the two-clause
    // cases: the fused clause is no longer a BARE NODE, so the third clause here does not
    // attach to it. The answer is right either way; the widening (an anchor whose LAST node is
    // the shared variable) is open and would want its own measurement.
    same(
      'MATCH (a:P)-[:T]->(x)-[:S]->(y) RETURN a.k AS a, y.k AS y',
      'MATCH (a:P) MATCH (a)-[:T]->(x) MATCH (x)-[:S]->(y) RETURN a.k AS a, y.k AS y',
    );
  });
});
