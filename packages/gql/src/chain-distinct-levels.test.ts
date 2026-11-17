/*
 * Item 2119 — `RETURN DISTINCT <far>.<k>` over a 2+-segment chain, off the level recurrence.
 *
 * ⚠️⚠️ **THE ONE THING THAT COULD MAKE THIS A SILENT WRONG ANSWER IS NULL.** `count(DISTINCT x)` counts
 * non-null values; `RETURN DISTINCT x` treats NULL as a present value and emits a row for it. The rung
 * next door (`foldLevel`) SKIPS null by design, so sharing its loop would have made one of the two
 * wrong — `detectChainDistinctCount`'s header records the same trap ("`distinctRows(rows).length` would
 * be a silent wrong answer").
 *
 * 🔑 EVERY TEST COMPARES AGAINST THE GENERAL PATH, which an `ORDER BY` forces (this rung refuses one).
 * So the reference is the engine's own answer for the same question rather than a number I chose.
 *
 * ⚠️ AND THE COMPARISON IS A BAG WITH NULL, NaN AND -0 DISTINGUISHED. `JSON.stringify` renders NaN as
 * `null`, so a JSON bag cannot tell "kept NaN" from "collapsed NaN into null" — the first version of
 * this check could not, and read as passing.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { rowKeyOf } from './executor/clauses.js';
import { valueKey as valueKeyOf } from './executor/rows.js';
import { query } from './index.js';

/** `null`, `NaN` and `-0` rendered distinguishably — see the header. */
const tag = (v: unknown): string => {
  if (v === null) {
    return 'null';
  }

  if (typeof v === 'number' && Number.isNaN(v)) {
    return 'NaN';
  }

  return Object.is(v, -0) ? '-0' : JSON.stringify(v);
};
const bagOf = (rows: readonly Record<string, unknown>[], col: string): string =>
  rows
    .map((r) => tag(r[col]))
    .sort()
    .join(',');

/** A ring, so every vertex is reachable at every depth. `props` sets the far values under test. */
const ringOf = (props: readonly Record<string, unknown>[]): Graph => {
  const g = new Graph();

  for (const [i, p] of props.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: p });
  }

  for (let i = 0; i < props.length; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i + 1) % props.length}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const HOP2 = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n';
const HOP3 = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN DISTINCT d.n AS n';

/*
 * 🔑 THE REFERENCE IS THE GENERAL PATH, forced by an `ORDER BY` the rung refuses. ⚠️ Comparing as a BAG
 * and not a list: row order is unspecified for a `DISTINCT` projection without `ORDER BY`
 * (`order-is-unspecified`), so the two routes may legitimately differ on it.
 */
const bothRoutes = (g: Graph, q: string, col = 'n'): { fused: string; general: string } => ({
  fused: bagOf(query(g, q, {}), col),
  general: bagOf(query(g, `${q} ORDER BY ${col}`, {}), col),
});

describe('chainDistinctLevels (item 2119)', () => {
  test('⚠️⚠️ NULL IS KEPT — a missing key and an explicit null unify, and NaN stays distinct', () => {
    /*
     * 🔑 THE LOAD-BEARING CASE. `v2` and `v5` lack `n` entirely, `v3` holds an explicit `null`, and
     * `v8` holds `NaN`. ISO GQL yields NULL for an absent property, so the three nullish vertices must
     * contribute exactly ONE null row — and `NaN` must NOT merge into it.
     */
    const g = ringOf([
      { n: 1 },
      { n: 2 },
      { other: 9 },
      { n: null },
      { n: 2 },
      { other: 8 },
      { n: 0 },
      { n: -0 },
      { n: Number.NaN },
    ]);
    const { fused, general } = bothRoutes(g, HOP2);

    expect(fused).toBe(general);
    // 🔑 Written out, so a change to BOTH routes cannot pass by agreeing on something wrong.
    expect(fused).toBe('0,1,2,NaN,null');
  });

  test("⚠️ `-0` and `0` are ONE value, which is `valueKey`'s rule and not this rung's", () => {
    const g = ringOf([{ n: 0 }, { n: -0 }, { n: 0 }]);
    const { fused, general } = bothRoutes(g, HOP2);

    expect(fused).toBe(general);
    expect(fused).toBe('0');
  });

  test('🔑 THREE hops agrees too — the recurrence is per level, not per width', () => {
    const g = ringOf([{ n: 1 }, { n: 2 }, { other: 1 }, { n: 2 }, { n: 3 }]);
    const { fused, general } = bothRoutes(g, HOP3);

    expect(fused).toBe(general);
    expect(fused).toBe('1,2,3,null');
  });

  test('⚠️ a LABELLED chain agrees — the level mask is what admits one', () => {
    /*
     * `levelWalk` applies each level's target label as a post-step zeroing, so a real label changes
     * WHICH vertices are reached. ⚠️ A fixture whose label is vacuous would not test that
     * (`label-vacuity-gates-fast-paths`), so one vertex is off-label here.
     */
    const g = new Graph();

    /*
     * ⚠️ THE OFF-LABEL VERTEX IS THE SOLE HOLDER OF ITS VALUE (99), and that is what makes masking
     * observable. My first fixture used `n: i % 3`, so excluding `v3` removed no VALUE from the distinct
     * set — the labelled and unlabelled bags matched and this test's own assertion failed, correctly.
     */
    for (let i = 0; i < 6; i += 1) {
      g.addVertex({
        id: `v${i}`,
        labels: [i === 3 ? 'Q' : 'P'],
        properties: { n: i === 3 ? 99 : i % 3 },
      });
    }

    for (let i = 0; i < 6; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i + 1) % 6}`)!,
        labels: ['E'],
        properties: {},
      });
    }

    const q = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN DISTINCT c.n AS n';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
    // ⚠️ And the label must actually have excluded something, or this asserts nothing about masking.
    const unlabelled = bagOf(
      query(g, 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n', {}),
      'n',
    );

    expect(fused).not.toBe(unlabelled);
  });

  test('⚠️⚠️ an item reading the START is REFUSED, not mis-evaluated', () => {
    /*
     * 🔑 THE GUARD `foldLevel`'s NEIGHBOUR DOES NOT HAVE. The pass binds only the far variable, so an
     * item reading `a` would evaluate against an unbound name — a wrong answer, not a decline. The gate
     * checks the item's free variables rather than assuming, and the answer proves it.
     */
    const g = ringOf([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT a.n AS n';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
    expect(fused).toBe('1,2,3');
  });

  test('⚠️⚠️ `ORDER BY` IS REFUSED, AND ADMITTING IT DROPS THE SORT — a silent wrong answer', () => {
    /*
     * 🔑 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED EVERYTHING ELSE IN THIS FILE. Every other case here
     * compares BAGS, because row order is unspecified for a `DISTINCT` projection without `ORDER BY` —
     * and a bag comparison cannot see a dropped sort. Deleting the `orderBy` clause from the gate was
     * measured directly: `RETURN DISTINCT c.n ORDER BY n` returned **[5,1,4,2,3]** where [1,2,3,4,5] is
     * correct, and all 8 tests still passed.
     *
     * ⚠️ So the refusal is LOAD-BEARING rather than conservative, and this is the one case in the file
     * that must assert a LIST and not a bag.
     */
    const g = ringOf([{ n: 5 }, { n: 1 }, { n: 4 }, { n: 2 }, { n: 3 }]);
    const sorted = query(g, `${HOP2} ORDER BY n`, {}).map((r) => r.n);

    expect(sorted).toStrictEqual([1, 2, 3, 4, 5]);
    // ⚠️ And the values must NOT already be in vertex order, or the assertion is vacuous.
    const unsorted = query(g, HOP2, {}).map((r) => r.n);

    expect(unsorted).not.toStrictEqual([1, 2, 3, 4, 5]);
  });

  test('⚠️ `SKIP`/`LIMIT` are refused for the same reason — order decides WHICH rows survive', () => {
    const g = ringOf([{ n: 5 }, { n: 1 }, { n: 4 }, { n: 2 }, { n: 3 }]);
    const limited = query(g, `${HOP2} ORDER BY n LIMIT 2`, {});

    expect(limited.map((r) => r.n)).toStrictEqual([1, 2]);
  });

  test('🔑 TWO columns are CLAIMED since item 2120 — and agree with the general path', () => {
    /*
     * ⚠️ MEASURED: 834.2 ms -> 30.8 at two hops (27.1x) and 2477.8 -> 29.1 at three (85.2x), with the
     * ONE-column path held at 0.96x by its own specialized loop (folding the two cost it 1.30x).
     */
    const g = ringOf([
      { n: 1, k: 'a' },
      { n: 1, k: 'b' },
      { n: 2, k: 'a' },
      { n: 1, k: 'a' },
      { other: 1, k: 'c' },
      { n: 3 },
    ]);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n, c.k AS k';
    const fused = query(g, q, {});
    const general = query(g, `${q} ORDER BY n, k`, {});

    // 🔑 A JOINT key: `(1,a)` and `(1,b)` are DIFFERENT rows, which a per-column dedupe would merge.
    expect(fused).toHaveLength(general.length);
    expect(bagOf(fused, 'n')).toBe(bagOf(general, 'n'));
    expect(bagOf(fused, 'k')).toBe(bagOf(general, 'k'));
    // ⚠️ And the pairs must match, not just each column's multiset.
    const pairs = (rows: readonly Record<string, unknown>[]): string =>
      rows
        .map((r) => `${tag(r.n)}|${tag(r.k)}`)
        .sort()
        .join(',');

    expect(pairs(fused)).toBe(pairs(general));
  });

  test('⚠️ `rowKeyOf` IS a separator-joined `valueKey` list — the shape the rung mirrors', () => {
    /*
     * 🔑 `distinctLevel` builds its key from the CELLS (`valueKey` joined by `\u0001`) instead of
     * building a row and calling `rowKeyOf`, which would allocate the row even for a duplicate. ⚠️ That
     * is the SAME algorithm, not a second definition — and items 1561/1562 each shipped a silent answer
     * change in exactly this area, so the equivalence is checked on the values that make keying hard.
     */
    const hard: readonly unknown[][] = [
      [0, -0],
      [Number.NaN, Number.NaN],
      [null, undefined],
      ['a\u0001b', 'c'],
      ['a', 'b\u0001c'],
      [1, '1'],
      [true, 'true'],
    ];

    for (const cells of hard) {
      const row: Record<string, unknown> = {};

      for (const [i, c] of cells.entries()) {
        row[`c${i}`] = c;
      }

      /*
       * ⚠️⚠️ **THIS DOES NOT TEST THE RUNG — it pins `rowKeyOf`'s SHAPE, which the rung mirrors.** My
       * first version of this test claimed to assert the rung's key and did not: it compared `rowKeyOf`
       * against a join written here in the test file, so a rung that keyed differently would still have
       * passed. ⚠️ And the rung's separator mutant DOES survive, because `valueKey` prefixes every value
       * with a type tag that already delimits — see `chain-fold-levels.ts`, where that is recorded next
       * to the code rather than left as an unexplained survivor.
       *
       * 🔑 What guards the rung's keying is the ANSWER tests above, against the general path, on the
       * values that make keying hard (`-0`/`0`, `NaN`, null-vs-missing, embedded `\u0001`).
       */
      const joined = cells.map((c) => valueKeyOf(c)).join('\u0001');

      expect(joined).toBe(rowKeyOf(row as never));
    }
  });

  test('⚠️ A JOINT KEY IS NOT TWO INDEPENDENT ONES — the separator matters', () => {
    /*
     * 🔑 `('a\u0001b', 'c')` and `('a', 'b\u0001c')` join to the SAME string if the separator is not
     * distinguishable from the data. ⚠️ `valueKey` prefixes strings (so a raw `\u0001` in a value cannot
     * forge a boundary) — asserted here through the ANSWER rather than the key, because the answer is
     * what a user sees.
     */
    const g = ringOf([
      { n: 'a\u0001b', k: 'c' },
      { n: 'a', k: 'b\u0001c' },
      { n: 'z', k: 'z' },
    ]);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n, c.k AS k';
    const fused = query(g, q, {});

    // THREE distinct pairs, not two: the two ambiguous ones must not collide.
    expect(fused).toHaveLength(3);
    expect(query(g, `${q} ORDER BY n, k`, {})).toHaveLength(3);
  });

  test('⚠️⚠️ a SECOND column reading the START is refused — not just the first', () => {
    /*
     * 🔑 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED. Restricting the far-variable check to
     * `items.slice(0, 1)` left a second column reading `a` to evaluate against an unbound name — a
     * silent wrong answer, and every other test here uses a far-only projection so none noticed.
     *
     * ⚠️ The answer, not the route, is what is asserted: the general path is the reference.
     */
    const g = ringOf([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n, a.n AS an';
    const fused = query(g, q, {});
    const general = query(g, `${q} ORDER BY n, an`, {});
    const pairs = (rows: readonly Record<string, unknown>[]): string =>
      rows
        .map((r) => `${tag(r.n)}|${tag(r.an)}`)
        .sort()
        .join(',');

    expect(pairs(fused)).toBe(pairs(general));
    // ⚠️ And the start column must actually VARY, or an unbound read would coincide with the truth.
    expect(new Set(general.map((r) => tag(r.an))).size).toBeGreaterThan(1);
  });

  test('⚠️ ONE hop is not this rung — and still agrees', () => {
    const g = ringOf([{ n: 1 }, { other: 2 }, { n: 1 }]);
    const q = 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.n AS n';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
    expect(fused).toBe('1,null');
  });

  test('⚠️ an EMPTY reach answers nothing, not a null row', () => {
    /*
     * A chain whose second hop reaches no vertex has no reached far vertex at all — so zero rows, which
     * is different from one null row. ⚠️ A loop that emitted before testing multiplicity would get this
     * wrong.
     */
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
    g.addEdge({
      id: 'e',
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['E'],
      properties: {},
    });

    const { fused, general } = bothRoutes(g, HOP2);

    expect(fused).toBe(general);
    expect(fused).toBe('');
  });
});
