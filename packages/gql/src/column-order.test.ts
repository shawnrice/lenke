import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Output COLUMN order is fixed by the RETURN clause and is part of the bytes a caller sees, but
// nothing asserted it: a projection built in reverse order passed every unit suite AND the
// differential fuzzer on every seed tried, because the fuzzer's canonicalizer sorts object keys
// before comparing (row order is unspecified; column order is not). See audit item 116.
//
// `Object.keys` on a plain object yields insertion order for string keys, so comparing it to the
// RETURN order is exactly the observable question.

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['T'], properties: { n: 3, s: 'x', z: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['T'], properties: { n: 7, s: 'y', z: 2 } });

  g.addEdge({ from: a, to: b, labels: ['E'], properties: { w: 5 } });

  return g;
};

const colsOf = (g: Graph, q: string): string[] => Object.keys(query(g, q)[0] ?? {});

describe('output column order follows the RETURN clause', () => {
  // Aliases are deliberately NOT in alphabetical order and not in the properties' storage order,
  // so sorting by either would be visible. `zz, aa, mm` sorts to `aa, mm, zz`.
  test('a projection keeps declaration order, not alphabetical order', () => {
    const g = build();

    expect(colsOf(g, `MATCH (n:T) RETURN n.z AS zz, n.n AS aa, n.s AS mm`)).toEqual([
      'zz',
      'aa',
      'mm',
    ]);
    expect(colsOf(g, `MATCH (n:T) RETURN n.n AS b, n.z AS a`)).toEqual(['b', 'a']);
    expect(colsOf(g, `MATCH (a:T)-[:E]->(b:T) RETURN b.s AS s2, a.n AS n1`)).toEqual(['s2', 'n1']);
  });

  // The fast row-building path (item 113/116) and the Map-then-copy path must agree, so each
  // clause that routes AWAY from the fast path is checked with the same column list.
  test('every projection route agrees on the order', () => {
    const g = build();
    const want = ['zz', 'aa'];
    const sel = `n.z AS zz, n.n AS aa`;

    expect(colsOf(g, `MATCH (n:T) RETURN ${sel}`)).toEqual(want); // fast path
    expect(colsOf(g, `MATCH (n:T) RETURN ${sel} ORDER BY aa`)).toEqual(want);
    expect(colsOf(g, `MATCH (n:T) RETURN DISTINCT ${sel}`)).toEqual(want);
    expect(colsOf(g, `MATCH (n:T) RETURN ${sel} LIMIT 1`)).toEqual(want);
    expect(colsOf(g, `MATCH (n:T) RETURN ${sel} SKIP 1`)).toEqual(want);
    expect(colsOf(g, `MATCH (n:T) RETURN ${sel} ORDER BY aa SKIP 1 LIMIT 1`)).toEqual(want);
  });

  test('an aggregate keeps the order its RETURN gives', () => {
    const g = build();

    expect(colsOf(g, `MATCH (n:T) LET k = n.z RETURN k, count(*) AS c GROUP BY k`)).toEqual([
      'k',
      'c',
    ]);
    expect(colsOf(g, `MATCH (n:T) LET k = n.z RETURN count(*) AS c, k GROUP BY k`)).toEqual([
      'c',
      'k',
    ]);
  });

  test('RETURN * keeps the bound variables in order', () => {
    const g = build();

    expect(colsOf(g, `MATCH (a:T)-[:E]->(b:T) RETURN *`)).toEqual(['a', 'b']);
  });

  // A name that appears twice keeps its FIRST position with its LAST value — the behaviour a
  // `Map` and a plain object happen to share, which is what makes the two projection routes
  // interchangeable. Pinned so a future rewrite of either cannot drift.
  test('a repeated column name keeps its first position', () => {
    const g = build();
    const q = `MATCH (n:T) RETURN n.z AS dup, n.n AS other, n.s AS dup`;

    expect(colsOf(g, q)).toEqual(['dup', 'other']);
    expect(query(g, `${q} ORDER BY other`).map((r) => Object.keys(r))).toEqual([
      ['dup', 'other'],
      ['dup', 'other'],
    ]);
  });
});
