import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1473 moved `combineRows`' right-side key `Set` into the two branches that read it, because
 * both `UNION` branches built it and threw it away (4.63x on `UNION ALL` over a wide right side).
 * Mutation-testing that change found a pre-existing hole: **a mutant that stops `INTERSECT`
 * deduplicating survives all 3,700 GQL tests.**
 *
 * ISO set operations dedup except for `UNION ALL` (`EXCEPT`/`INTERSECT` always dedup — only `UNION`
 * distinguishes `ALL`, matching the Rust engine), and the left side of an `INTERSECT` routinely
 * carries duplicates when it projects a non-unique column, so the rule is observable and was simply
 * never asserted.
 *
 * These also pin the `ALL`-vs-distinct branch selection and the POSITIONAL column comparison, so a
 * future reshuffle of that switch cannot pass quietly.
 */

/** Six vertices over three distinct `k` values, so every projection of `k` has duplicates. */
const dupKeys = (): Graph => {
  const g = new Graph();

  for (const [id, k] of [
    ['a', 1],
    ['b', 1],
    ['c', 2],
    ['d', 2],
    ['e', 3],
    ['f', 3],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { k, n: id } });
  }

  return g;
};

const col = (rows: Record<string, unknown>[], name: string): unknown[] =>
  rows.map((r) => r[name]).sort((x, y) => Number(x) - Number(y));

describe('INTERSECT deduplicates', () => {
  test('a duplicate-bearing left side intersected with itself yields DISTINCT rows', () => {
    // Each side has 6 rows over 3 distinct k values. Deduping gives 3.
    const rows = query(
      dupKeys(),
      'MATCH (n:P) RETURN n.k AS k INTERSECT MATCH (n:P) RETURN n.k AS k',
    );

    expect(rows.length).toBe(3);
    expect(col(rows, 'k')).toEqual([1, 2, 3]);
  });

  test('a narrowed right side still yields each surviving row ONCE', () => {
    const rows = query(
      dupKeys(),
      'MATCH (n:P) RETURN n.k AS k INTERSECT MATCH (m:P) WHERE m.k = 2 RETURN m.k AS k',
    );

    expect(rows.length).toBe(1);
    expect(rows[0].k).toBe(2);
  });

  test('an empty right side gives no rows', () => {
    expect(
      query(
        dupKeys(),
        'MATCH (n:P) RETURN n.k AS k INTERSECT MATCH (m:P) WHERE m.k = 99 RETURN m.k AS k',
      ),
    ).toEqual([]);
  });
});

describe('EXCEPT deduplicates', () => {
  test('a duplicate-bearing left side minus one value yields DISTINCT survivors', () => {
    const rows = query(
      dupKeys(),
      'MATCH (n:P) RETURN n.k AS k EXCEPT MATCH (m:P) WHERE m.k = 2 RETURN m.k AS k',
    );

    expect(rows.length).toBe(2);
    expect(col(rows, 'k')).toEqual([1, 3]);
  });

  test('EXCEPT with an empty right side still dedups the left', () => {
    const rows = query(
      dupKeys(),
      'MATCH (n:P) RETURN n.k AS k EXCEPT MATCH (m:P) WHERE m.k = 99 RETURN m.k AS k',
    );

    expect(rows.length).toBe(3);
    expect(col(rows, 'k')).toEqual([1, 2, 3]);
  });
});

describe('UNION distinguishes ALL, and nothing else does', () => {
  test('UNION ALL keeps every duplicate from both sides', () => {
    const rows = query(
      dupKeys(),
      'MATCH (n:P) RETURN n.k AS k UNION ALL MATCH (m:P) RETURN m.k AS k',
    );

    // 6 + 6, nothing removed.
    expect(rows.length).toBe(12);
  });

  test('plain UNION dedups across both sides', () => {
    const rows = query(dupKeys(), 'MATCH (n:P) RETURN n.k AS k UNION MATCH (m:P) RETURN m.k AS k');

    expect(rows.length).toBe(3);
    expect(col(rows, 'k')).toEqual([1, 2, 3]);
  });

  test('UNION ALL of disjoint sides keeps both, in neither case deduping', () => {
    const rows = query(
      dupKeys(),
      'MATCH (n:P) WHERE n.k = 1 RETURN n.k AS k UNION ALL MATCH (m:P) WHERE m.k = 3 RETURN m.k AS k',
    );

    expect(rows.length).toBe(4);
    expect(col(rows, 'k')).toEqual([1, 1, 3, 3]);
  });
});

describe('set operations compare rows POSITIONALLY, not by column name', () => {
  test('differently-aliased parts still match, and the left names win', () => {
    // ISO compares positionally, so `AS k` and `AS other` line up; the result adopts the LEFT
    // part's names. A name-keyed comparison would return 0 rows here instead of 3.
    const rows = query(
      dupKeys(),
      'MATCH (n:P) RETURN n.k AS k INTERSECT MATCH (m:P) RETURN m.k AS other',
    );

    expect(rows.length).toBe(3);
    expect(Object.keys(rows[0])).toEqual(['k']);
  });
});
