import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// A projected ITEM may carry a subquery; the PREDICATE may not. Item 204 applied one guard to
// both, so `MATCH (u:User) WHERE u.name = $n RETURN COUNT { … }` declined the node-scan fast path
// and took the general pipeline — a whole-label scan to serve one surviving row.
//
// The asymmetry is the whole point (audit item 208):
//
//   - the PREDICATE is evaluated by the per-vertex gate, and item 175 gave the seed gate a
//     cheap-conjunct-first order so `WHERE k = 'nope' AND <faulting subquery>` never reaches the
//     subquery. A gate evaluating the whole predicate at once loses that, so subqueries stay
//     refused there.
//   - an ITEM is evaluated once per SURVIVING row on either path, so a subquery there costs the
//     same either way. And that is where the cost was: 94.3ns a scanned vertex against the fast
//     path's 38.2, of which a one-hop `COUNT{}` item showed only ~4ns was the subquery itself.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, props: Record<string, unknown>) =>
    g.addVertex({ id, labels: [label], properties: props });

  const a1 = v('a1', 'A', { k: 'x', n: 1 });
  // Deliberately EDGELESS, so it is never wired up below: a COUNT{} item must answer 0 for
  // it, and an EXISTS{} item false — the row that distinguishes a per-row item from a constant.
  v('a2', 'A', { k: 'y', n: 2 });
  const a3 = v('a3', 'A', { k: 'x', n: 3 });
  const b1 = v('b1', 'B', { k: 'b1' });
  const b2 = v('b2', 'B', { k: 'b2' });

  const e = (from: ReturnType<typeof v>, to: ReturnType<typeof v>) =>
    g.addEdge({ from, to, labels: ['T'], properties: {} });

  // a1 has two out-edges, a3 has one, a2 has none — so a `COUNT{}` item differs per row and a
  // walk that evaluated it against the wrong vertex would be visible.
  e(a1, b1);
  e(a1, b2);
  e(a3, b1);

  return g;
};

const g = build();

/** Forced to the general path by a third clause, which the two-clause fast path declines. */
const viaGeneral = (q: string, params?: Record<string, unknown>) =>
  query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '), params);

const agree = (q: string, params?: Record<string, unknown>) => {
  const fast = query(g, q, params);

  expect(fast).toEqual(viaGeneral(q, params));

  return fast;
};

describe('a subquery ITEM is admissible', () => {
  test('COUNT { } differs per surviving row', () => {
    // Both a1 and a3 survive and their counts differ — 2 and 1. A walk that evaluated the item
    // against a stale binding would give both rows the same number.
    expect(
      agree("MATCH (a:A) WHERE a.k = 'x' RETURN a.n AS n, COUNT { MATCH (a)-[:T]->(b) } AS c"),
    ).toEqual([
      { n: 1, c: 2 },
      { n: 3, c: 1 },
    ]);
  });

  test('EXISTS { }', () => {
    expect(agree('MATCH (a:A) RETURN a.n AS n, EXISTS { MATCH (a)-[:T]->(b) } AS has')).toEqual([
      { n: 1, has: true },
      { n: 2, has: false },
      { n: 3, has: true },
    ]);
  });

  test('a subquery as the ONLY item', () => {
    expect(agree("MATCH (a:A) WHERE a.k = 'x' RETURN COUNT { MATCH (a)-[:T]->(b) } AS c")).toEqual([
      { c: 2 },
      { c: 1 },
    ]);
  });

  test('a subquery with its own WHERE', () => {
    expect(
      agree("MATCH (a:A) RETURN a.n AS n, COUNT { MATCH (a)-[:T]->(b) WHERE b.k = 'b1' } AS c"),
    ).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 0 },
      { n: 3, c: 1 },
    ]);
  });

  test('the inner variable may SHADOW the outer node’s name', () => {
    // The subquery binds `a` to its own far end. The walk reuses ONE binding map across the whole
    // scan, so if the subquery's scope leaked into it, the next row's gate and items would read
    // the inner `a` instead of the scanned vertex. Three rows with distinct `n` make that visible.
    expect(agree('MATCH (a:A) RETURN a.n AS n, COUNT { MATCH (x)-[:T]->(a) } AS inbound')).toEqual(
      viaGeneral('MATCH (a:A) RETURN a.n AS n, COUNT { MATCH (x)-[:T]->(a) } AS inbound'),
    );
  });

  test('a subquery beside a computed item', () => {
    expect(
      agree("MATCH (a:A) WHERE a.k = 'x' RETURN a.n + 10 AS v, COUNT { MATCH (a)-[:T]->(b) } AS c"),
    ).toEqual([
      { v: 11, c: 2 },
      { v: 13, c: 1 },
    ]);
  });

  test('a subquery nested inside an expression', () => {
    expect(
      agree("MATCH (a:A) WHERE a.k = 'x' RETURN COUNT { MATCH (a)-[:T]->(b) } + 1 AS c"),
    ).toEqual([{ c: 3 }, { c: 2 }]);
  });
});

describe('the predicate still refuses a subquery', () => {
  test('a subquery in the WHERE keeps the seed gate', () => {
    // Item 175's cheap-conjunct-first order is what stops the faulting subquery being reached for
    // a vertex the cheap conjunct rejects. Taking this into the per-vertex gate would lose it.
    const q =
      "MATCH (a:A) WHERE a.k = 'nope' AND EXISTS { MATCH (a)-[:T]->(b) WHERE b.k / 0 > 1 } RETURN a.n AS n";

    expect(query(g, q)).toEqual([]);
  });

  test('a non-faulting subquery in the WHERE still answers correctly', () => {
    const q = 'MATCH (a:A) WHERE EXISTS { MATCH (a)-[:T]->(b) } RETURN a.n AS n';

    expect(query(g, q)).toEqual([{ n: 1 }, { n: 3 }]);
  });
});

describe('what an item still may not be', () => {
  test('an aggregate needs the group this path never builds', () => {
    expect(query(g, 'MATCH (a:A) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(query(g, 'MATCH (a:A) RETURN max(a.n) AS m')).toEqual([{ m: 3 }]);
  });

  test('an aggregate INSIDE a subquery is fine — it belongs to that subquery', () => {
    // The aggregate check must not descend into the subquery, or this would decline.
    const q = 'MATCH (a:A) RETURN a.n AS n, COUNT { MATCH (a)-[:T]->(b) } AS c';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('an aggregate OUTSIDE a subquery, with a subquery present, still declines', () => {
    const q = 'MATCH (a:A) RETURN count(*) AS c, EXISTS { MATCH (a)-[:T]->(b) } AS has';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });
});
