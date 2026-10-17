// `CALL (n) { MATCH (n)-[:T]->(x) RETURN x }` IS `MATCH (n)-[:T]->(x)` — a correlated inline
// call whose body is one pattern and a RETURN of the names it introduces.
//
// The call runs its body once per incoming row through the general matcher, so
// `MATCH (n:P) CALL (n) { … } RETURN count(*)` cost 996.2ms at 200,000 vertices against the
// native engine's 6.2 and against 0.0 for the one-pattern spelling (item 513). Rewritten, item
// 507's fusion merges the result into the preceding MATCH and the whole ladder applies.
//
// This file pins the equivalence and — the part that matters — the shapes it must refuse.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  // `lonely` yields nothing from the call, so a non-optional CALL drops its row.
  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['S'], properties: {} });

  return g;
};

const g = build();
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();

describe('a correlated inline CALL is rewritten to its MATCH (item 513)', () => {
  test('the rewritten shape answers the one-pattern spelling, and the hand value', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual(bag('MATCH (n:P) MATCH (n)-[:T]->(x) RETURN n.k AS n, x.k AS x'));
    // `a` reaches b and c; `b` and `lonely` have no T edge, so their rows DROP (a CALL is not
    // optional). Two rows.
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual([JSON.stringify({ n: 1, x: 2 }), JSON.stringify({ n: 1, x: 3 })].sort());
    expect(
      query<{ c: number }>(
        g,
        'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN count(*) AS c',
      )[0]?.c,
    ).toBe(2);
  });

  test('a body WHERE and a landing label are carried', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x:Q) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual([JSON.stringify({ n: 1, x: 3 })]);
    expect(
      bag(
        'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) WHERE x.k = 2 RETURN x } RETURN n.k AS n, x.k AS x',
      ),
    ).toEqual([JSON.stringify({ n: 1, x: 2 })]);
  });

  test('the REL variable is yielded too when the body returns it', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[r:T]->(x) RETURN r, x } RETURN x.k AS x'),
    ).toEqual(bag('MATCH (n:P) MATCH (n)-[r:T]->(x) RETURN x.k AS x'));
  });

  // The refusals. Each would change the answer, and each is checked by one.
  test('a body that binds a name it does NOT return declines', () => {
    // `x` is bound inside and not yielded, so the call HIDES it. Inlining would leave it bound,
    // which `RETURN *` can see — this is the one condition whose violation is invisible in the
    // ordinary shapes.
    const cols = Object.keys(
      query(g, 'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x)-[:S]->(y) RETURN y } RETURN *')[0] ?? {},
    ).sort();

    expect(cols).toEqual(['n', 'y']);
  });

  test('OPTIONAL CALL keeps the row and declines', () => {
    // The left-outer form: `b` and `lonely` survive with `x` null, which a plain MATCH would
    // drop. Four rows, not two.
    expect(
      bag(
        'MATCH (n:P) OPTIONAL CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x',
      ),
    ).toEqual(
      [
        JSON.stringify({ n: 1, x: 2 }),
        JSON.stringify({ n: 1, x: 3 }),
        JSON.stringify({ n: 2, x: null }),
        JSON.stringify({ n: 9, x: null }),
      ].sort(),
    );
  });

  test('an ALIASED or computed yield declines, and answers the same', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x AS y } RETURN n.k AS n, y.k AS y'),
    ).toEqual([JSON.stringify({ n: 1, y: 2 }), JSON.stringify({ n: 1, y: 3 })].sort());
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS v } RETURN n.k AS n, v AS v'),
    ).toEqual([JSON.stringify({ n: 1, v: 2 }), JSON.stringify({ n: 1, v: 3 })].sort());
  });

  test('an UNCORRELATED CALL — empty scope — declines', () => {
    // Nothing is imported, so the body is the same for every row: a different shape from a
    // lateral join, and not this rewrite's business.
    expect(
      query<{ c: number }>(
        g,
        'MATCH (n:P) CALL () { MATCH (z:Q) RETURN z } RETURN count(*) AS c',
      )[0]?.c,
    ).toBe(3);
  });
});
