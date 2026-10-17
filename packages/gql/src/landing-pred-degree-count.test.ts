// `COUNT { (x)-[:T]->(b) WHERE <pred on b> }` — a one-hop degree with a LANDING PREDICATE.
//
// `degreeCountSubquery` declines on its first line when the body carries a `WHERE`, so this
// shape materialized the body's bindings once per outer row: 649.2ms at 200,000 vertices
// against native's 18.2 (item 524). The rung walks the anchor's adjacency box and gates each
// neighbour instead.
//
// Every case is asked TWICE — once in the admitted spelling and once with `AND x.n = x.n`
// appended, which is TRUE for every vertex in this fixture but makes `freePredicateVars`
// return the outer name, so the rung refuses and the general path answers the same question.
// A rung and the path it replaces must agree, and the twin is what says so.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });
  const d = g.addVertex({ id: 'd', labels: ['R'], properties: { n: 4, s: 'x' } });
  // `e` carries NO `n` at all, so a predicate over it is UNKNOWN rather than false.
  const e = g.addVertex({ id: 'e', labels: ['R'], properties: {} });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e3', from: a, to: d, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e4', from: a, to: e, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e5', from: b, to: c, labels: ['S'], properties: {} });

  return g;
};

const g = build();
const c = (q: string, params?: Record<string, unknown>): unknown =>
  (query(g, q, params)[0] as Record<string, unknown>)?.c;

/** The rung's answer and the general path's, for the same question. */
const both = (body: string, want: unknown, params?: Record<string, unknown>): void => {
  const one = `MATCH (x:P) WHERE x.n = 1 RETURN COUNT { ${body} } AS c`;

  expect(c(one, params)).toBe(want);

  const twin = one.replace('} AS c', 'AND x.n = x.n } AS c');

  expect(c(twin, params)).toBe(want);
};

describe('a one-hop degree with a landing predicate (item 524)', () => {
  test('counts the neighbours the predicate keeps', () => {
    // `a`'s four `:T` neighbours carry n = 2, 3, 4 and nothing.
    both('(x)-[:T]->(b) WHERE b.n > 1', 3);
    both('(x)-[:T]->(b) WHERE b.n > 3', 1);
    both('(x)-[:T]->(b) WHERE b.n > 9', 0);
    both('(x)-[:T]->(b) WHERE b.n = 2', 1);
  });

  test('UNKNOWN does not count — only a clean TRUE does', () => {
    // `e` has no `n`, so `e.n > 0` is UNKNOWN. Three neighbours have one.
    both('(x)-[:T]->(b) WHERE b.n > 0', 3);
    // And its negation does not count it either, which is what makes this 3VL rather than
    // a missing value read as false: TRUE + UNKNOWN + FALSE partitions four neighbours
    // into 3 + 1 + 0, not 3 + 1 under a complement.
    both('(x)-[:T]->(b) WHERE NOT b.n > 0', 0);
  });

  test('the landing LABEL and the predicate compose', () => {
    // `:Q` neighbours of `a` are b (n = 2) and c (n = 3).
    both('(x)-[:T]->(b:Q) WHERE b.n > 1', 2);
    both('(x)-[:T]->(b:Q) WHERE b.n > 2', 1);
    both('(x)-[:T]->(b:R) WHERE b.n > 1', 1);
  });

  test('a param in the predicate', () => {
    both('(x)-[:T]->(b) WHERE b.n > $lo', 2, { lo: 2 });
    both('(x)-[:T]->(b) WHERE b.n > $lo', 0, { lo: 9 });
  });

  test('the INCOMING direction', () => {
    // `c` is reached from `a` (`:T`) and `b` (`:S`).
    expect(c('MATCH (x:Q) WHERE x.n = 3 RETURN COUNT { (x)<-[:T]-(b) WHERE b.n < 9 } AS c')).toBe(
      1,
    );
    expect(c('MATCH (x:Q) WHERE x.n = 3 RETURN COUNT { (x)<-[:S]-(b) WHERE b.n < 9 } AS c')).toBe(
      1,
    );
  });

  test('an edge TYPE the graph does not have counts nothing', () => {
    both('(x)-[:NOPE]->(b) WHERE b.n > 0', 0);
  });

  test('a CROSS-TYPE comparison answers what the general path answers', () => {
    // `d.s` is a string and the other side is a number, then a temporal. Neither throws in
    // this engine — both are simply not a match — and the point of the case is that the rung
    // agrees rather than that it throws. `both` asks the general path the same question.
    //
    // Written down because the first version of this test asserted a THROW, on the native
    // engine's behaviour. The rung does not catch, so a predicate that did fault would
    // propagate; nothing reachable from here faults, so that is stated rather than claimed.
    both('(x)-[:T]->(b) WHERE b.s < 1', 0);
    both("(x)-[:T]->(b) WHERE b.s < date('2020-01-01')", 0);
  });

  test('a landing variable ALREADY BOUND outside is not a degree', () => {
    // `b` is bound by the outer MATCH, so the subquery asks whether THAT pair is connected —
    // one edge, not a's degree. The rung must stand down.
    expect(
      c(
        'MATCH (x:P), (b) WHERE x.n = 1 AND b.n = 2 RETURN COUNT { (x)-[:T]->(b) WHERE b.n > 1 } AS c',
      ),
    ).toBe(1);
  });

  test('a repeated variable is a self-join, not a degree', () => {
    // `(x)-[:T]->(x)` counts self-loops; there are none.
    expect(c('MATCH (x:P) WHERE x.n = 1 RETURN COUNT { (x)-[:T]->(x) WHERE x.n > 0 } AS c')).toBe(
      0,
    );
  });

  test('a subquery inside the predicate is refused, and still answered', () => {
    // The rung reuses ONE scratch binding across a vertex's neighbours, which a nested
    // subquery could re-enter — so it declines. `b` must still be counted correctly.
    // `b` and `c` have outgoing `:S`/`:T`… only `b` has an `:S` edge.
    expect(
      c(
        'MATCH (x:P) WHERE x.n = 1 RETURN COUNT { (x)-[:T]->(b) WHERE EXISTS { (b)-[:S]->(z) } } AS c',
      ),
    ).toBe(1);
  });

  test('two hops are left to the general path, and still answered', () => {
    // a -> b -> c is the only two-hop `:T`/`:S` chain.
    expect(
      c('MATCH (x:P) WHERE x.n = 1 RETURN COUNT { (x)-[:T]->(m)-[:S]->(w) WHERE w.n > 0 } AS c'),
    ).toBe(1);
  });
});
