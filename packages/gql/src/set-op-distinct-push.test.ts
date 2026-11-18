/*
 * Item 2147 — `A UNION B` compiled as `(DISTINCT A) UNION (DISTINCT B)`.
 *
 * 🔑 THE SAME QUESTION WRITTEN WITH THE DISTINCT BY HAND WAS 5x FASTER, which made this an
 * EQUIVALENT-SPELLING GAP — the defect class this repo is organised around:
 *
 * ```text
 *     operator     as written   by hand    after
 *     UNION          14.75 ms     2.97      3.57
 *     EXCEPT         12.84        2.87      3.25
 *     INTERSECT      14.82        2.91      3.05
 * ```
 *
 * 🔑 SOUND BECAUSE SET UNION IS IDEMPOTENT: `DISTINCT(A ∪ B) = DISTINCT(DISTINCT(A) ∪ DISTINCT(B))`, and
 * likewise for `∩` and `\`. ⚠️⚠️ **`UNION ALL` IS EXACTLY WHERE IT FAILS**, and that is the first describe
 * block below — a rewrite that touched it would silently collapse duplicates, which is a WRONG ANSWER no
 * row count from the deduping operators could reveal.
 *
 * ⚠️ The other refusals are paging and grouping: deduping BEFORE a `LIMIT` changes which rows survive it,
 * and a grouped arm is already one row per group.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Three `P` vertices with k = 1, 1, 2; only the first is also `Q`.
 *
 * 🔑 The duplicate `k = 1` across two vertices is what makes every assertion here able to see a dedup,
 * and the single `Q` is what makes the operators differ from each other.
 */
const g = (() => {
  const graph = new Graph();

  graph.addVertex({ id: 'v0', labels: ['P', 'Q'], properties: { k: 1, j: 9 } });
  graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: 1, j: 8 } });
  graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 2, j: 7 } });

  return graph;
})();

const ks = (q: string): unknown[] => query(g, q).map((r) => r.k);
const sortedKs = (q: string): unknown[] => [...ks(q)].sort();

describe('set-op DISTINCT push (item 2147)', () => {
  describe('⚠️⚠️ `UNION ALL` KEEPS ITS DUPLICATES — the case the rewrite must refuse', () => {
    test('the multiplicity is exactly what it was', () => {
      /*
       * 🔑 THE WRONG ANSWER THIS GUARDS. `P` yields k = 1, 1, 2 and `Q` yields 1, so `UNION ALL` is four
       * rows. ⚠️ A rewrite that pushed DISTINCT into either arm would answer three or two — and no
       * assertion on the DEDUPING operators could ever see it, because they collapse duplicates anyway.
       */
      expect(
        sortedKs('MATCH (a:P) RETURN a.k AS k UNION ALL MATCH (a:Q) RETURN a.k AS k'),
      ).toStrictEqual([1, 1, 1, 2]);
    });

    test('⚠️ a CHAIN containing one `ALL` protects every arm', () => {
      /*
       * 🔑 Parts join LEFT-ASSOCIATIVELY, so `A UNION ALL B UNION C` is `(A ∪all B) ∪ C` and pushing into
       * `A` would change the inner multiplicity before the outer dedup ever runs. ⚠️ The rewrite refuses
       * the whole query when ANY operator is `ALL`, which this pins.
       */
      const q =
        'MATCH (a:P) RETURN a.k AS k UNION ALL MATCH (a:Q) RETURN a.k AS k UNION MATCH (a:P) RETURN a.k AS k';

      // The outer UNION dedups the lot, so the answer is the value SET either way...
      expect(sortedKs(q)).toStrictEqual([1, 2]);

      // ⚠️ ... which is why the INNER multiplicity needs its own assertion, above.
      expect(ks('MATCH (a:P) RETURN a.k AS k UNION ALL MATCH (a:Q) RETURN a.k AS k')).toHaveLength(
        4,
      );
    });
  });

  describe('🔑 the three deduping operators answer exactly as the hand-written form does', () => {
    test.each([
      ['UNION', 'UNION'],
      ['EXCEPT', 'EXCEPT'],
      ['INTERSECT', 'INTERSECT'],
    ])('%s', (_name, op) => {
      const asWritten = `MATCH (a:P) RETURN a.k AS k ${op} MATCH (a:Q) RETURN a.k AS k`;
      const byHand = `MATCH (a:P) RETURN DISTINCT a.k AS k ${op} MATCH (a:Q) RETURN DISTINCT a.k AS k`;

      expect(sortedKs(asWritten)).toStrictEqual(sortedKs(byHand));
    });

    test('and the values are right, not merely equal to each other', () => {
      // P's k values are {1, 2}; Q's are {1}.
      expect(
        sortedKs('MATCH (a:P) RETURN a.k AS k UNION MATCH (a:Q) RETURN a.k AS k'),
      ).toStrictEqual([1, 2]);
      expect(
        sortedKs('MATCH (a:P) RETURN a.k AS k EXCEPT MATCH (a:Q) RETURN a.k AS k'),
      ).toStrictEqual([2]);
      expect(
        sortedKs('MATCH (a:P) RETURN a.k AS k INTERSECT MATCH (a:Q) RETURN a.k AS k'),
      ).toStrictEqual([1]);
    });

    test('⚠️ a MULTI-COLUMN arm dedups on the whole row', () => {
      /*
       * 🔑 v0 and v1 share `k` but differ in `j`, so a two-column projection has NO duplicate — the push
       * must not collapse them. ⚠️ This is the case a one-column fixture cannot test.
       */
      const rows = query(
        g,
        'MATCH (a:P) RETURN a.k AS k, a.j AS j UNION MATCH (a:Q) RETURN a.k AS k, a.j AS j',
      );

      expect(rows).toHaveLength(3);
    });
  });

  describe('⚠️ the refusals, each pinned by an ANSWER', () => {
    test('⚠️⚠️ an arm with `LIMIT` — deduping first would change which rows survive', () => {
      /*
       * 🔑 THE SHARPEST REFUSAL. `ORDER BY k LIMIT 2` over k = 1, 1, 2 takes the two ROWS `1, 1`; with a
       * DISTINCT pushed in it would take `1, 2` — a different set reaching the union. ⚠️ So the two
       * spellings genuinely DIFFER here, and the rewrite must not equate them.
       */
      const paged =
        'MATCH (a:P) RETURN a.k AS k ORDER BY k LIMIT 2 UNION MATCH (a:Q) RETURN a.k AS k';
      const pushed =
        'MATCH (a:P) RETURN DISTINCT a.k AS k ORDER BY k LIMIT 2 UNION MATCH (a:Q) RETURN a.k AS k';

      expect(sortedKs(paged)).toStrictEqual([1]);
      // ⚠️ The hand-pushed form reaches {1, 2}: proof the two are NOT interchangeable.
      expect(sortedKs(pushed)).toStrictEqual([1, 2]);
    });

    test('an arm with `SKIP` likewise', () => {
      const q = 'MATCH (a:P) RETURN a.k AS k ORDER BY k SKIP 2 UNION MATCH (a:Q) RETURN a.k AS k';

      // Rows 1, 1, 2 ordered, skip 2 → [2]; union with Q's {1} → {1, 2}.
      expect(sortedKs(q)).toStrictEqual([1, 2]);
    });

    test('an arm that already says DISTINCT is left alone', () => {
      expect(
        sortedKs('MATCH (a:P) RETURN DISTINCT a.k AS k UNION MATCH (a:Q) RETURN a.k AS k'),
      ).toStrictEqual([1, 2]);
    });

    test('an AGGREGATED arm is already one row', () => {
      const rows = query(
        g,
        'MATCH (a:P) RETURN count(*) AS k UNION MATCH (a:Q) RETURN count(*) AS k',
      );

      // 3 and 1, deduped to two rows.
      expect(rows.map((r) => r.k).sort()).toStrictEqual([1, 3]);
    });

    test('a single query with no set operator is untouched', () => {
      expect(ks('MATCH (a:P) RETURN a.k AS k')).toHaveLength(3);
    });
  });
});
