import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// A subquery is admissible in the node scan's PREDICATE — unlike the hop projection's, where item
// 207 refuses it outright. The difference is the segment count: here the pattern has ZERO
// segments, so every candidate vertex yields exactly ONE row, and "once per vertex" is the same
// evaluation set as the general path's "once per complete match". A hop has neither property.
//
// The gate is `gatePredicate`, the general path's OWN prefilter, so item 175's conjunct ORDER and
// its stop-at-first-non-TRUE semantics come along by construction rather than by re-derivation.
//
// Measured (20,000 users), holding the scan fixed and varying the subquery's cost:
//
//     no subquery at all                53ns a vertex
//     a TRIVIAL subquery in the WHERE   86ns  ->  56ns
//     the 2-4 hop cycle subquery        98ns  ->  47ns
//
// 33ns for merely HAVING a subquery against 12ns for the subquery's own extra work, so the cost
// was the general-path scan (audit item 209).
const build = (withIndex: boolean): Graph => {
  const g = new Graph();
  const v = (id: string, props: Record<string, unknown>) =>
    g.addVertex({ id, labels: ['U'], properties: props });

  const a = v('a', { name: 'a', n: 1 });
  const b = v('b', { name: 'b', n: 2 });
  const c = v('c', { name: 'c', n: 3 });
  // `bad` has a NON-NUMERIC name, so a subquery doing arithmetic on it faults — which is how the
  // raise-ordering cases below are built.
  const bad = v('bad', { name: 'bad', n: 4 });

  g.addEdge({ from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ from: b, to: c, labels: ['T'], properties: {} });
  g.addEdge({ from: bad, to: a, labels: ['T'], properties: {} });
  // `c` has no out-edge, so an EXISTS over out-edges is false for it.

  if (withIndex) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
  }

  return g;
};

const g = build(false);
const gi = build(true);

/** Forced to the general path by a third clause. */
const viaGeneral = (q: string, params?: Record<string, unknown>) =>
  query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '), params);

const agree = (q: string, params?: Record<string, unknown>) => {
  const fast = query(g, q, params);

  expect(fast).toEqual(viaGeneral(q, params));
  // The INDEXED graph must agree too: a subquery predicate lifts no `props`, so it offers the
  // seek no hint, and the two must still answer the same.
  expect(query(gi, q, params)).toEqual(fast);

  return fast;
};

const raised = (graph: Graph, q: string, params?: Record<string, unknown>): boolean => {
  try {
    query(graph, q, params);

    return false;
  } catch {
    return true;
  }
};

describe('a subquery in the node scan’s WHERE', () => {
  test('EXISTS, alone', () => {
    expect(agree('MATCH (u:U) WHERE EXISTS { MATCH (u)-[:T]->(x) } RETURN u.n AS n')).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 4 },
    ]);
  });

  test('EXISTS beside a cheap conjunct', () => {
    expect(
      agree("MATCH (u:U) WHERE u.name = 'a' AND EXISTS { MATCH (u)-[:T]->(x) } RETURN u.n AS n"),
    ).toEqual([{ n: 1 }]);
  });

  test('the SUBQUERY conjunct written FIRST answers the same', () => {
    // `gatePredicate` reorders, so the source order must not matter — the equivalent-spelling
    // claim this repo exists to keep.
    const first =
      "MATCH (u:U) WHERE EXISTS { MATCH (u)-[:T]->(x) } AND u.name = 'a' RETURN u.n AS n";
    const last =
      "MATCH (u:U) WHERE u.name = 'a' AND EXISTS { MATCH (u)-[:T]->(x) } RETURN u.n AS n";

    expect(agree(first)).toEqual([{ n: 1 }]);
    expect(query(g, first)).toEqual(query(g, last));
  });

  test('a NOT EXISTS', () => {
    expect(agree('MATCH (u:U) WHERE NOT EXISTS { MATCH (u)-[:T]->(x) } RETURN u.n AS n')).toEqual([
      { n: 3 },
    ]);
  });

  test('COUNT { } compared against a number', () => {
    expect(agree('MATCH (u:U) WHERE COUNT { MATCH (u)-[:T]->(x) } > 0 RETURN u.n AS n')).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 4 },
    ]);
  });

  test('a subquery with its own WHERE', () => {
    expect(
      agree("MATCH (u:U) WHERE EXISTS { MATCH (u)-[:T]->(x) WHERE x.name = 'b' } RETURN u.n AS n"),
    ).toEqual([{ n: 1 }]);
  });

  test('a var-length subquery, the bench row’s shape', () => {
    expect(
      agree(
        "MATCH (u:U) WHERE u.name = 'a' AND EXISTS { MATCH (u)-[:T]->{1,3}(x) } RETURN u.n AS n",
      ),
    ).toEqual([{ n: 1 }]);
  });

  test('TWO subquery conjuncts', () => {
    expect(
      agree(
        'MATCH (u:U) WHERE EXISTS { MATCH (u)-[:T]->(x) } AND COUNT { MATCH (u)-[:T]->(y) } = 1 RETURN u.n AS n',
      ),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 4 }]);
  });

  test('a subquery in the WHERE and another in an ITEM', () => {
    expect(
      agree(
        'MATCH (u:U) WHERE EXISTS { MATCH (u)-[:T]->(x) } RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(y) } AS c',
      ),
    ).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 1 },
      { n: 4, c: 1 },
    ]);
  });
});

describe('the conjunct order matches the general path, raises included', () => {
  const FAULT = 'EXISTS { MATCH (u)-[:T]->(x) WHERE u.name / 1 > 0 }';

  test('a FALSE cheap conjunct defers the faulting subquery — no raise, on either path', () => {
    // This was CHECKED against the general path rather than assumed: it answers `[]` both
    // indexed and unindexed, so deferring the subquery introduces no raise the general path
    // lacks. If the fast path evaluated the whole predicate at once it would fault here.
    const q = `MATCH (u:U) WHERE u.name = 'nope' AND ${FAULT} RETURN u.n AS n`;

    expect(raised(g, q)).toBe(false);
    expect(raised(gi, q)).toBe(false);
    expect(raised(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '))).toBe(false);
    expect(query(g, q)).toEqual([]);
  });

  test('a cheap conjunct that SELECTS the faulting vertex does raise, on both paths', () => {
    // The mirror. A gate that swallowed every fault would pass the test above and fail this one.
    const q = `MATCH (u:U) WHERE u.name = 'bad' AND ${FAULT} RETURN u.n AS n`;

    expect(raised(g, q)).toBe(true);
    expect(raised(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '))).toBe(true);
  });

  test('a faulting subquery with NO cheap conjunct to defer behind', () => {
    // `gatePredicate` returns `compileExpr(where)` unchanged when there is nothing to reorder,
    // so this must behave exactly as the general path does.
    const q = `MATCH (u:U) WHERE ${FAULT} RETURN u.n AS n`;

    expect(raised(g, q)).toBe(raised(g, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
  });
});

describe('what still declines', () => {
  test('a HOP with a subquery predicate keeps the general matcher', () => {
    // Item 207 refuses this: one start can yield many rows or none, so a per-vertex gate would
    // change how many times the subquery runs and which rows raise.
    const q =
      "MATCH (u:U)-[:T]->(w) WHERE u.name = 'nope' AND EXISTS { MATCH (u)-[:T]->(z) WHERE z.name / 1 > 0 } RETURN w.n AS n";

    expect(query(g, q)).toEqual([]);
  });

  test('an aggregate in the WHERE is still not a thing this path takes', () => {
    const q = 'MATCH (u:U) RETURN count(*) AS c';

    expect(query(g, q)).toEqual([{ c: 4 }]);
  });
});
