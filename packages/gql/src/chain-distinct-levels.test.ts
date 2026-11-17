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

  test('⚠️ TWO columns are refused — the multi-column case is separately open', () => {
    const g = ringOf([
      { n: 1, k: 'a' },
      { n: 1, k: 'b' },
      { n: 2, k: 'a' },
    ]);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n, c.k AS k';
    const got = query(g, q, {}) as Record<string, unknown>[];
    const ref = query(g, `${q} ORDER BY n, k`, {}) as never as Record<string, unknown>[];

    expect(got).toHaveLength(ref.length);
    expect(bagOf(got, 'k')).toBe(bagOf(ref, 'k'));
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
