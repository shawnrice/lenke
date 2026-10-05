import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `seedPrefilter` lifts a HOP's clause `WHERE` into a fault-swallowing seed gate so a start
// vertex the predicate rejects is never expanded. It lifted the WHOLE conjunction, and the gate
// evaluated every conjunct, so an `EXISTS {…}` ran a correlated sub-pattern once per start VERTEX
// there — and AGAIN per surviving row in the clause `WHERE`, because a prefilter does not replace
// it. `gatePredicate` now evaluates the subquery-free conjuncts first and stops at the first that
// is not cleanly TRUE: 267.61ms -> 5.26ms on a 20,000-user hop, the twin of item 174's
// segment-free fix (audit item 175).
//
// The gate keeps a seed only on a clean TRUE, and a three-valued conjunction is TRUE only when
// every conjunct is, so stopping early is the gate's own semantics — not a reordering of `AND`.
// What it DOES change is which row raises: a cleanly-FALSE cheap conjunct beside a FAULTING
// subquery used to propagate that fault, have the gate swallow it and KEEP the seed, and then
// raise from the clause `WHERE` per row. Both cases that changes were already TS-vs-native
// divergences, and both now match native.
//
// The oracle throughout: a subquery body that faults raises if and only if it was evaluated.

/**
 * A 4-vertex chain so every vertex has an out-edge (the pattern is a HOP, so an edgeless vertex
 * would produce no rows and could not tell these behaviours apart). `z` is 0 on `b` ALONE, so
 * `1.0 / u.z` faults for exactly one vertex — and `b` is never the vertex a selective conjunct
 * picks. `m` is absent everywhere, to drive the UNKNOWN case.
 */
const chain = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a', z: 1, n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b', z: 0, n: 2 } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { k: 'c', z: 1, n: 3 } });
  g.addVertex({ id: 'd', labels: ['P'], properties: { k: 'd', z: 1, n: 4 } });

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v('b'), to: v('c'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: v('c'), to: v('d'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e4', from: v('d'), to: v('a'), labels: ['E'], properties: {} });

  return g;
};

const rows = (q: string, params?: Record<string, unknown>): unknown[] => query(chain(), q, params);

const raised = (q: string, params?: Record<string, unknown>): boolean => {
  try {
    query(chain(), q, params);

    return false;
  } catch {
    return true;
  }
};

const FAULT = 'EXISTS { (u)-[:E]->(x) WHERE 1.0 / u.z > 0 }';

describe('the hop seed gate evaluates cheap conjuncts first (item 175)', () => {
  test('rows are unchanged: the gate is answer-preserving', () => {
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'a' RETURN w.k AS w`)).toEqual([{ w: 'b' }]);
    expect(
      rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'a' AND EXISTS { (u)-[:E]->() } RETURN w.k AS w`),
    ).toEqual([{ w: 'b' }]);
    // Every vertex has an out-edge, so the EXISTS keeps all four.
    expect(
      rows(`MATCH (u:P)-[:E]->(w) WHERE u.n >= 1 AND EXISTS { (u)-[:E]->() } RETURN w.k AS w`),
    ).toHaveLength(4);
  });

  // The teeth. `b` faults; a selective conjunct that excludes `b` must stop the gate reaching it.
  test('a faulting subquery is not reached for a vertex the cheap conjunct rejects', () => {
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'nope' AND ${FAULT} RETURN w.k AS w`)).toBe(
      false,
    );
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'nope' AND ${FAULT} RETURN w.k AS w`)).toEqual(
      [],
    );
  });

  test('an error against a NON-EMPTY result: a non-faulting vertex now answers', () => {
    // This is the case the divergence registry explicitly does not cover — TS raised where
    // native returned a row, because an UNRELATED vertex (`b`) faulted and the gate's swallow
    // pushed the fault into the clause WHERE. Selecting `a` must return `a`'s row.
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'a' AND ${FAULT} RETURN w.k AS w`)).toBe(
      false,
    );
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'a' AND ${FAULT} RETURN w.k AS w`)).toEqual([
      { w: 'b' },
    ]);
  });

  test('CONTROL the faulting vertex itself still raises', () => {
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'b' AND ${FAULT} RETURN w.k AS w`)).toBe(true);
  });

  test('CONTROL with nothing to gate it, the faulting subquery still raises', () => {
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE ${FAULT} RETURN w.k AS w`)).toBe(true);
    // And a cheap conjunct that rejects NOTHING cannot gate it either.
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE u.n >= 1 AND ${FAULT} RETURN w.k AS w`)).toBe(true);
  });

  test('the conjunct ORDER in the source does not matter: the gate reorders', () => {
    // `EXISTS` written FIRST must still be evaluated last. Without the reorder this raises.
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE ${FAULT} AND u.k = 'nope' RETURN w.k AS w`)).toBe(
      false,
    );
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE ${FAULT} AND u.k = 'a' RETURN w.k AS w`)).toBe(
      false,
    );
  });

  test('UNKNOWN is not TRUE: a null cheap conjunct skips the seed', () => {
    // `u.m` is absent everywhere, so `u.m = 1` is UNKNOWN, and a three-valued conjunction is
    // TRUE only when every conjunct is — so the gate must stop there, not continue into the
    // subquery. A gate testing `=== false` instead of `!== true` would continue and raise.
    expect(raised(`MATCH (u:P)-[:E]->(w) WHERE u.m = 1 AND ${FAULT} RETURN w.k AS w`)).toBe(false);
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.m = 1 AND ${FAULT} RETURN w.k AS w`)).toEqual([]);
    // And the answer with a NON-faulting subquery is the same, which is what makes the row
    // above an evaluation-count claim rather than a filtering one.
    expect(
      rows(`MATCH (u:P)-[:E]->(w) WHERE u.m = 1 AND EXISTS { (u)-[:E]->() } RETURN w.k AS w`),
    ).toEqual([]);
  });

  test('a subquery-only clause WHERE is left exactly as it was', () => {
    expect(
      rows(`MATCH (u:P)-[:E]->(w) WHERE EXISTS { (u)-[:E]->() } RETURN w.k AS w`),
    ).toHaveLength(4);
  });

  test('a subquery-free clause WHERE is left exactly as it was', () => {
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.n >= 3 RETURN w.k AS w`)).toHaveLength(2);
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.n >= 3 AND u.k = 'c' RETURN w.k AS w`)).toEqual([
      { w: 'd' },
    ]);
  });

  test('three conjuncts: two cheap and one subquery, all still applied', () => {
    expect(
      rows(
        `MATCH (u:P)-[:E]->(w) WHERE u.n >= 1 AND u.k = 'c' AND EXISTS { (u)-[:E]->() } RETURN w.k AS w`,
      ),
    ).toEqual([{ w: 'd' }]);
    expect(
      rows(
        `MATCH (u:P)-[:E]->(w) WHERE u.n >= 1 AND u.k = 'c' AND EXISTS { (u)-[:E]->(x) WHERE x.k = 'zzz' } RETURN w.k AS w`,
      ),
    ).toEqual([]);
  });

  test('a COUNT subquery conjunct is gated the same way', () => {
    expect(
      raised(
        `MATCH (u:P)-[:E]->(w) WHERE u.k = 'nope' AND COUNT { (u)-[:E]->(x) WHERE 1.0 / u.z > 0 } > 0 RETURN w.k AS w`,
      ),
    ).toBe(false);
    expect(
      rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'c' AND COUNT { (u)-[:E]->() } = 1 RETURN w.k AS w`),
    ).toEqual([{ w: 'd' }]);
  });

  test('OPTIONAL MATCH takes no seed gate at all', () => {
    const r = rows(
      `MATCH (u:P) WHERE u.k = 'a' OPTIONAL MATCH (q:P)-[:E]->(w) WHERE q.k = 'zzz' RETURN u.k AS k, w.k AS w`,
    );

    expect(r).toEqual([{ k: 'a', w: null }]);
  });

  test('a far-end reference still declines the gate entirely', () => {
    // `seedPrefilter` requires the whole WHERE to read only the start variable; `w` is the far
    // end, so no gate is built and the subquery is not reordered into one.
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'a' AND w.k = 'b' RETURN w.k AS w`)).toEqual([
      { w: 'b' },
    ]);
    expect(rows(`MATCH (u:P)-[:E]->(w) WHERE u.k = 'a' AND w.k = 'zzz' RETURN w.k AS w`)).toEqual(
      [],
    );
  });
});
