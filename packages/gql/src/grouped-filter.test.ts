import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The grouped-count tally now carries a filter (audit item 141): `MATCH (n:L) WHERE <pred on
// n> RETURN n.k, count(*) GROUP BY n.k` — count by category over the rows matching a filter.
// Declining it cost 695ns a vertex against the tally's 124.
//
// Every case compares against the general grouping path, forced by a shape the tally refuses.
// Group ORDER is first-seen in both paths (pinned by the existing grouped-count tests), so the
// comparison is on row arrays in order.
//
// The fixture gives each group a DIFFERENT size and puts the largest group OUTSIDE the filter,
// so a tally that dropped the predicate could not accidentally agree:
//
//   k = 'a'  3 vertices, all pass        k = 'b'  2 vertices, all pass
//   k = 'c'  1 vertex, passes            k = 'd'  5 vertices, NONE pass
//
// so the filtered answer is a:3, b:2, c:1 and the unfiltered one has d:5 as its biggest group.
const SPEC: [string, string, number][] = [
  ['v0', 'a', 1],
  ['v1', 'a', 2],
  ['v2', 'a', 3],
  ['v3', 'b', 4],
  ['v4', 'b', 5],
  ['v5', 'c', 6],
  ['v6', 'd', 99],
  ['v7', 'd', 99],
  ['v8', 'd', 99],
  ['v9', 'd', 99],
  ['v10', 'd', 99],
];

const build = (): Graph => {
  const g = new Graph();

  for (const [id, k, n] of SPEC) {
    g.addVertex({ id, labels: id === 'v0' ? ['P', 'Q'] : ['P'], properties: { k, n } });
  }

  return g;
};

/**
 * The same question through the GENERAL grouping path. A SECOND `LET` makes the clause count
 * four, which `groupedClauses` refuses (it takes two or three), without touching the grouping
 * itself.
 */
const viaGeneral = (g: Graph, q: string) => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const bothWays = (g: Graph, q: string) => [query(g, q), viaGeneral(g, q)] as const;

describe('filtered grouped count', () => {
  test('a clause WHERE is applied, and matches the general path', () => {
    const g = build();
    const q = 'MATCH (n:P) WHERE n.n < 50 LET a = n.k RETURN a, count(*) AS c GROUP BY a';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([
      { a: 'a', c: 3 },
      { a: 'b', c: 2 },
      { a: 'c', c: 1 },
    ]);
    expect(fast).toEqual(slow);
  });

  test('the two-clause spelling (no LET) carries it too', () => {
    const g = build();
    const q = 'MATCH (n:P) WHERE n.n < 50 RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([
      { a: 'a', c: 3 },
      { a: 'b', c: 2 },
      { a: 'c', c: 1 },
    ]);
    expect(fast).toEqual(slow);
  });

  test('an INLINE constraint is the same question and gives the same answer', () => {
    const g = build();
    // Both spellings of one filter must agree — and both are now tallied, so neither is
    // paying the general path while the other is not.
    const inline = query(g, 'MATCH (n:P {k: "b"}) RETURN n.k AS a, count(*) AS c');
    const clause = query(g, 'MATCH (n:P) WHERE n.k = "b" RETURN n.k AS a, count(*) AS c');

    expect(inline).toEqual([{ a: 'b', c: 2 }]);
    expect(clause).toEqual(inline);
  });

  test('an inline constraint AND a clause WHERE must BOTH hold', () => {
    const g = build();
    // Carried as two closed predicates, so this is what catches only one being applied:
    // `k = 'a'` matches three vertices with n = 1, 2, 3, and `n > 2` keeps exactly ONE of
    // them. Applying only the inline would give 3; only the clause would give 2 (v2 and v3,
    // the latter a `b`); applying both gives 1 — three distinct numbers.
    const q = 'MATCH (n:P {k: "a"}) WHERE n.n > 2 RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 'a', c: 1 }]);
    expect(fast).toEqual(slow);
  });

  test('a filter matching NOTHING yields no groups', () => {
    const g = build();
    const q = 'MATCH (n:P) WHERE n.n > 1000 RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([]);
    expect(fast).toEqual(slow);
  });

  test('a filter matching EVERYTHING equals the unfiltered tally', () => {
    const g = build();
    const filtered = query(g, 'MATCH (n:P) WHERE n.n > 0 RETURN n.k AS a, count(*) AS c');
    const plain = query(g, 'MATCH (n:P) RETURN n.k AS a, count(*) AS c');

    expect(filtered).toEqual(plain);
    // And `d` is the biggest group when nothing is filtered — the fixture's guard against a
    // dropped predicate agreeing by accident.
    expect(plain).toContainEqual({ a: 'd', c: 5 });
  });

  test('an absent property is dropped by the three-valued filter, not grouped', () => {
    const g = build();

    g.addVertex({ id: 'x', labels: ['P'], properties: { k: 'e' } });

    // `x` has no `n`, so `n.n < 50` is NULL for it and the row drops — `e` must not appear.
    const q = 'MATCH (n:P) WHERE n.n < 50 RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).not.toContainEqual({ a: 'e', c: 1 });
    expect(fast).toEqual(slow);
  });

  test('the GROUP KEY may be absent while the filter passes', () => {
    const g = build();

    g.addVertex({ id: 'y', labels: ['P'], properties: { n: 7 } });

    // `y` passes `n < 50` but has no `k`, so it groups under null — one group, not dropped.
    const q = 'MATCH (n:P) WHERE n.n < 50 RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toContainEqual({ a: null, c: 1 });
    expect(fast).toEqual(slow);
  });

  test('a filter reading the group key itself works', () => {
    const g = build();
    const q = 'MATCH (n:P) WHERE n.k <> "d" RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([
      { a: 'a', c: 3 },
      { a: 'b', c: 2 },
      { a: 'c', c: 1 },
    ]);
    expect(fast).toEqual(slow);
  });

  test('the column order of count and key is preserved', () => {
    const g = build();
    // Column order is observable in the output bytes, and the tally emits the two columns in
    // the projection's item order — including when the count comes FIRST.
    const q = 'MATCH (n:P) WHERE n.n < 50 RETURN count(*) AS c, n.k AS a';
    const [fast, slow] = bothWays(g, q);

    expect(Object.keys(fast[0] as object)).toEqual(['c', 'a']);
    expect(fast).toEqual(slow);
  });

  test('a filter reading ANOTHER variable declines rather than guessing', () => {
    const g = build();
    // There is no other variable to read in a single-node pattern, so the closest shape is a
    // filter over a second pattern — which must still be right by whatever path it takes.
    const q = 'MATCH (n:P), (m:Q) WHERE n.n < m.n RETURN n.k AS a, count(*) AS c';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
  });

  test('a non-vacuous label still restricts the scan', () => {
    const g = build();
    const q = 'MATCH (n:Q) WHERE n.n < 50 RETURN n.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    // Only v0 carries `Q`.
    expect(fast).toEqual([{ a: 'a', c: 1 }]);
    expect(fast).toEqual(slow);
  });
});
