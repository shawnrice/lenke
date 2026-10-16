import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 469: TWO OR MORE aggregates over one scan accumulate as the rows are produced, instead of
// falling off the ladder whole. At 200,000 nodes: `count(n.age), count(*)` 46.4 -> 10.7 ms,
// `min, max` 41.2 -> 15.4, `sum, avg` 64.0 -> 15.4, with the single-aggregate rows flat.
//
// The oracle throughout is the DECLINING spelling of the same question — a `GROUP BY`-shaped or
// `DISTINCT` twin, or the same aggregate asked one at a time — rather than a literal I worked
// out, because the claim is that the two routes agree, not that I can do arithmetic.
describe('two or more aggregates over one scan (item 469)', () => {
  const nums = (): Graph => {
    const g = new Graph();

    for (const k of [0, 1, 2, 2, 5, 7]) {
      g.addVertex({ labels: ['P'], properties: { k } });
    }

    // No `k`: `count(*)` must count it and `count(a.k)` must not.
    g.addVertex({ labels: ['P'], properties: {} });

    return g;
  };

  test('two folds, and each agrees with asking it alone', () => {
    const g = nums();
    const [both] = query<{ lo: number; hi: number }>(
      g,
      'MATCH (a:P) RETURN min(a.k) AS lo, max(a.k) AS hi',
    );

    expect(both.lo).toBe(query<{ lo: number }>(g, 'MATCH (a:P) RETURN min(a.k) AS lo')[0].lo);
    expect(both.hi).toBe(query<{ hi: number }>(g, 'MATCH (a:P) RETURN max(a.k) AS hi')[0].hi);
    expect(both).toEqual({ lo: 0, hi: 7 });
  });

  test('count(*) counts the null row and count(a.k) does not', () => {
    const g = nums();

    expect(query(g, 'MATCH (a:P) RETURN count(a.k) AS n, count(*) AS tot')).toEqual([
      { n: 6, tot: 7 },
    ]);
  });

  test('sum and avg together on an unfiltered scan', () => {
    const g = nums();

    // 17 over SIX values: the row without `k` is filtered out of both.
    expect(query(g, 'MATCH (a:P) RETURN sum(a.k) AS s, avg(a.k) AS m')).toEqual([
      { s: 17, m: 17 / 6 },
    ]);
  });

  test('a mixed trio, each agreeing with its single-aggregate twin', () => {
    const g = nums();
    const [row] = query<{ s: number; n: number; hi: number }>(
      g,
      'MATCH (a:P) RETURN sum(a.k) AS s, count(*) AS n, max(a.k) AS hi',
    );

    expect(row.s).toBe(query<{ s: number }>(g, 'MATCH (a:P) RETURN sum(a.k) AS s')[0].s);
    expect(row.n).toBe(query<{ n: number }>(g, 'MATCH (a:P) RETURN count(*) AS n')[0].n);
    expect(row.hi).toBe(query<{ hi: number }>(g, 'MATCH (a:P) RETURN max(a.k) AS hi')[0].hi);
  });

  test('COLUMN ORDER follows the projection', () => {
    const g = nums();

    // Column order is bytes, not presentation (see `column-order.test.ts`): the fast path builds
    // its row key by key, so the order it writes them in is observable.
    expect(
      Object.keys(query(g, 'MATCH (a:P) RETURN max(a.k) AS hi, count(*) AS n, min(a.k) AS lo')[0]),
    ).toEqual(['hi', 'n', 'lo']);
  });

  test('a FILTERED scan: the folds take the path, the collecting ones decline — all correct', () => {
    const g = nums();

    // `count`/`min`/`max` are order-independent, so a filter is fine for them.
    expect(query(g, 'MATCH (a:P) WHERE a.k > 1 RETURN count(a.k) AS n, max(a.k) AS hi')).toEqual([
      { n: 4, hi: 7 },
    ]);
    // `sum`/`avg` under a filter decline to the general path (items 419, 466, 468) and must still
    // answer — a wrong answer here is what a dropped guard would look like.
    expect(query(g, 'MATCH (a:P) WHERE a.k > 1 RETURN sum(a.k) AS s, count(*) AS n')).toEqual([
      { s: 16, n: 4 },
    ]);
    expect(query(g, 'MATCH (a:P {k: 2}) RETURN sum(a.k) AS s, count(*) AS n')).toEqual([
      { s: 4, n: 2 },
    ]);
  });

  test('DISTINCT in any item declines, and the answer still differs from the non-DISTINCT one', () => {
    const g = nums();

    // The duplicated 2 is what makes these differ at all — without it the guard is vacuous.
    expect(query(g, 'MATCH (a:P) RETURN sum(DISTINCT a.k) AS s, count(*) AS n')).toEqual([
      { s: 15, n: 7 },
    ]);
    expect(query(g, 'MATCH (a:P) RETURN count(DISTINCT a.k) AS d, count(a.k) AS n')).toEqual([
      { d: 5, n: 6 },
    ]);
  });

  test('an empty scan gives every aggregate its own empty answer', () => {
    const g = new Graph();

    g.addVertex({ labels: ['Other'], properties: { k: 1 } });

    expect(
      query(
        g,
        'MATCH (a:P) RETURN count(a.k) AS n, count(*) AS tot, min(a.k) AS lo, sum(a.k) AS s, avg(a.k) AS m',
      ),
    ).toEqual([{ n: 0, tot: 0, lo: null, s: 0, m: null }]);
  });

  test('a GROUP KEY among the items is grouping, not this path', () => {
    const g = nums();
    const rows = query<{ k: number | null; n: number }>(
      g,
      'MATCH (a:P) RETURN a.k AS k, count(*) AS n ORDER BY k',
    );

    // Five distinct values plus the row with no `k`; the 2 appears twice.
    expect(rows.length).toBe(6);
    expect(rows.find((r) => r.k === 2)?.n).toBe(2);
  });

  test('a temporal sum beside a count goes through the same shared function', () => {
    const g = new Graph();

    g.addVertex({ labels: ['D'], properties: { d: 'PT1H' } });
    g.addVertex({ labels: ['D'], properties: { d: 'PT30M' } });

    const [row] = query<{ s: { secs: number }; n: number }>(
      g,
      'MATCH (a:D) RETURN sum(duration(a.d)) AS s, count(*) AS n',
    );

    expect(row.n).toBe(2);
    expect(row.s.secs).toBe(5400);
    // `avg` over a temporal is a data exception whichever route it takes.
    expect(() => query(g, 'MATCH (a:D) RETURN avg(duration(a.d)) AS m, count(*) AS n')).toThrow();
  });

  test('ORDER BY / SKIP / LIMIT decline and still answer', () => {
    const g = nums();

    expect(query(g, 'MATCH (a:P) RETURN count(*) AS n, max(a.k) AS hi LIMIT 1')).toEqual([
      { n: 7, hi: 7 },
    ]);
    expect(query(g, 'MATCH (a:P) RETURN count(*) AS n, max(a.k) AS hi ORDER BY n')).toEqual([
      { n: 7, hi: 7 },
    ]);
  });

  test('an aggregate NESTED in an item declines', () => {
    const g = nums();

    expect(query(g, 'MATCH (a:P) RETURN max(a.k) + 1 AS hi, count(*) AS n')).toEqual([
      { hi: 8, n: 7 },
    ]);
  });
});
