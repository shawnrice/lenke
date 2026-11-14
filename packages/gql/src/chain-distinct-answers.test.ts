import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the chain rung's new `DISTINCT` admission produces — item 1820.
 *
 * ⚠️ WHY A SECOND FILE WHEN `chain-projection.test.ts` ALREADY ASSERTS THE ROUTE. That file asks
 * "does the rung fire", which is a boolean about admission. It cannot catch a rung that fires and
 * then dedupes WRONGLY — and dedupe is where this engine has already shipped two silent answer
 * changes (items 1561 and 1562, both in the one-column fast path, both found by mutation rather
 * than by a passing suite). A route test plus a timing number would have looked like complete
 * coverage for a change whose whole risk is in the values.
 *
 * ⚠️ EVERY CASE BELOW IS A VALUE THE KEYING COULD GET WRONG, not a value that merely exercises the
 * path. `0`/`-0`, `NaN`, `null`, a column that is an ELEMENT rather than a scalar, and two columns
 * where only the second differs — these are the shapes `rowKeyOf`'s own comment calls out, and the
 * reason this rung calls `distinctRows` rather than keying rows itself.
 *
 * ⚠️ AND EACH EXPECTS A SET, COMPARED ORDER-INSENSITIVELY. `order-is-unspecified` is owner policy:
 * the rung's walk order is its own and is not part of the answer, so asserting a row ORDER here
 * would pin something the engine does not promise and would break on any future walk change.
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

/** A chain deep enough for this rung (three segments), with duplicate far-end values by design. */
const chainGraph = (farValues: readonly unknown[]): Graph => {
  const g = new Graph();
  const n = farValues.length;

  // Four levels of `n` vertices each, so every level-0 vertex reaches every level-3 vertex and the
  // undeduped row count is n^4 — which is what makes the dedupe observable rather than incidental.
  //
  // ⚠️ EVERY LEVEL CARRIES THE SAME VALUES, and the first cut of this fixture put them on level 3
  // ALONE. That was invisible while only the three-hop rung was tested — it reads the far end, which
  // was level 3 — and it silently broke every two-hop test added at item 1822, because a two-hop
  // chain ends at level 2 and read the placeholder there instead. It also made the cross-width
  // check vacuous, which is the test most worth having. A fixture whose values live at ONE depth
  // can only be read at one depth.
  for (let level = 0; level < 4; level += 1) {
    for (let i = 0; i < n; i += 1) {
      g.addVertex({
        id: `L${level}_${i}`,
        labels: level === 0 ? ['L'] : ['M'],
        properties: { k: farValues[i], s: `s${i % 2}` },
      });
    }
  }

  let e = 0;

  for (let level = 0; level < 3; level += 1) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const from = g.getVertexById(`L${level}_${i}`);
        const to = g.getVertexById(`L${level + 1}_${j}`);

        if (from === null || to === null) {
          throw new Error('fixture is broken: a level vertex is missing after insertion');
        }

        g.addEdge({ id: `e${e}`, from, to, labels: ['R'] });
        e += 1;
      }
    }
  }

  return g;
};

const CHAIN = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M)';

/** Sorted by the rendered value, so the comparison is about the SET and never the walk order. */
const setOf = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort((x, y) => x.localeCompare(y));

describe('the chain rung dedupes the way the rest of the engine does', () => {
  test('collapses duplicate far-end values to one row each', () => {
    const g = chainGraph([1, 2, 2, 3, 3, 3]);

    // 6^4 = 1,296 undeduped rows, three distinct values.
    expect(query(g, `${CHAIN} RETURN d.k AS k`).length).toBe(1296);
    expect(setOf(query(g, `${CHAIN} RETURN DISTINCT d.k AS k`))).toEqual(
      setOf([{ k: 1 }, { k: 2 }, { k: 3 }]),
    );
  });

  /**
   * ⚠️ `0` AND `-0` ARE ONE ROW, and this is the case a hand-rolled `Set` of raw values gets right
   * by accident and a hand-rolled string key gets WRONG (`String(-0)` is `'0'`, but `-0` stringified
   * through other routes is not). `valueKey` maps both to `n0` deliberately.
   */
  test('0 and -0 are the same row', () => {
    const g = chainGraph([0, -0]);

    expect(query(g, `${CHAIN} RETURN DISTINCT d.k AS k`)).toEqual([{ k: 0 }]);
  });

  /**
   * ⚠️ NaN IS EQUAL TO ITSELF HERE, which is NOT JavaScript's `===` and not the predicate rule.
   * `nan-comparison-policy`: predicates keep NaN JS-unordered, while sort/min/max and KEYING use a
   * total order where NaN equals NaN — otherwise byte-identity with the Rust engine fails. Item
   * 1561 nearly missed this because `JSON.stringify(NaN)` is the string `null`.
   */
  test('NaN collapses to a single row', () => {
    const g = chainGraph([Number.NaN, Number.NaN, 1]);
    const rows = query(g, `${CHAIN} RETURN DISTINCT d.k AS k`);

    expect(rows.length).toBe(2);
    expect(rows.some((r) => Number.isNaN(r.k))).toBe(true);
    expect(rows.some((r) => r.k === 1)).toBe(true);
  });

  /** A stored null is a present value (`null-first-class-policy`), so it is one row of its own. */
  test('null is a row, not a dropped row', () => {
    const g = chainGraph([null, null, 1]);

    expect(setOf(query(g, `${CHAIN} RETURN DISTINCT d.k AS k`))).toEqual(
      setOf([{ k: null }, { k: 1 }]),
    );
  });

  /**
   * ⚠️ TWO COLUMNS WHERE ONLY THE SECOND DIFFERS — the case a one-column fast path applied to a
   * multi-column row would collapse, which is precisely the silent answer change item 1561
   * introduced and item 1562 guarded. `s` is `s0`/`s1` by index parity, so `k` alone would read
   * two rows where the pair reads four.
   */
  test('a second column that differs keeps the rows apart', () => {
    const g = chainGraph([1, 1, 2, 2]);

    expect(setOf(query(g, `${CHAIN} RETURN DISTINCT d.k AS k, d.s AS s`))).toEqual(
      setOf([
        { k: 1, s: 's0' },
        { k: 1, s: 's1' },
        { k: 2, s: 's0' },
        { k: 2, s: 's1' },
      ]),
    );
  });

  /**
   * ⚠️ THE DEDUPED ANSWER MUST EQUAL THE GENERAL PATH'S, and the way to get the general path for
   * the SAME question is a spelling this rung declines. `ORDER BY` is one (it is still refused), so
   * the two routes answer the same query and their SETS are compared — the strongest available
   * check that admitting the rung did not change the answer, rather than that the rung is
   * self-consistent.
   */
  test('agrees with the route that declines the rung, on the same query', () => {
    const g = chainGraph([3, 1, 2, 2, null, 1]);

    const viaRung = query(g, `${CHAIN} RETURN DISTINCT d.k AS k`);
    const viaGeneral = query(g, `${CHAIN} RETURN DISTINCT d.k AS k ORDER BY k`);

    expect(setOf(viaRung)).toEqual(setOf(viaGeneral));
    expect(viaRung.length).toBe(4);
  });

  /**
   * ⚠️ AN ELEMENT COLUMN keys by ID and not by object identity — `rowKeyOf`'s comment is explicit
   * that two row objects can hold different instances for one id. Each far vertex is distinct here,
   * so the count is the level width and a mutant keying on identity would still pass; what this
   * pins is that an element column does not THROW or collapse to one row in the new tail.
   */
  test('an element column dedupes by id', () => {
    const g = chainGraph([1, 2, 3]);
    const rows = query(g, `${CHAIN} RETURN DISTINCT d AS d`);

    expect(rows.length).toBe(3);
  });
});

/**
 * ⚠️ THE TWO-HOP RUNG GOT THE SAME ADMISSION AT ITEM 1822, and it needs its OWN answer tests rather
 * than inheriting these: it is a different module (`hop2-projection.ts`), a different walk, and a
 * different row-building point. The shared argument is in `rows.ts`; the shared keying is
 * `distinctRows`; nothing else is shared, so nothing else may be assumed.
 *
 * The cases are deliberately the SAME ones, because the way to find out that two rungs disagree is
 * to ask them the same question — and the one that matters most is the cross-route check at the
 * end, which compares each rung's deduped answer against the general matcher's for the same query.
 */
describe('the two-hop rung dedupes identically', () => {
  const HOP2 = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)';

  test('collapses duplicates, keeps a second differing column apart', () => {
    const g = chainGraph([1, 2, 2, 3, 3, 3]);

    // 6^3 = 216 undeduped rows at two hops, three distinct values.
    expect(query(g, `${HOP2} RETURN c.k AS k`).length).toBe(216);
    expect(setOf(query(g, `${HOP2} RETURN DISTINCT c.k AS k`))).toEqual(
      setOf([{ k: 1 }, { k: 2 }, { k: 3 }]),
    );
  });

  test('0 and -0 are one row, NaN is one row, null is a row', () => {
    expect(query(chainGraph([0, -0]), `${HOP2} RETURN DISTINCT c.k AS k`)).toEqual([{ k: 0 }]);
    expect(
      query(chainGraph([Number.NaN, Number.NaN]), `${HOP2} RETURN DISTINCT c.k AS k`).length,
    ).toBe(1);
    expect(setOf(query(chainGraph([null, null, 1]), `${HOP2} RETURN DISTINCT c.k AS k`))).toEqual(
      setOf([{ k: null }, { k: 1 }]),
    );
  });

  test('a second column that differs keeps the rows apart', () => {
    const g = chainGraph([1, 1, 2, 2]);

    expect(setOf(query(g, `${HOP2} RETURN DISTINCT c.k AS k, c.s AS s`))).toEqual(
      setOf([
        { k: 1, s: 's0' },
        { k: 1, s: 's1' },
        { k: 2, s: 's0' },
        { k: 2, s: 's1' },
      ]),
    );
  });

  /** ⚠️ The cross-route check: `ORDER BY` declines the rung, so this is rung against general path. */
  test('agrees with the route that declines the rung, on the same query', () => {
    const g = chainGraph([3, 1, 2, 2, null, 1]);

    expect(setOf(query(g, `${HOP2} RETURN DISTINCT c.k AS k`))).toEqual(
      setOf(query(g, `${HOP2} RETURN DISTINCT c.k AS k ORDER BY k`)),
    );
  });

  /**
   * ⚠️ AND THE TWO RUNGS AGAINST EACH OTHER, which neither rung's own tests can ask. Both widths
   * read the same far-end property over the same levels of the same fixture, so their deduped
   * answers must be the same SET — the level-3 values are reachable at both depths here. This is
   * the assertion that catches one rung's dedupe drifting from the other's.
   */
  test('the two widths agree with each other on the same fixture', () => {
    const g = chainGraph([5, 5, 6, 7, 7]);
    const CHAIN3 = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M)';

    expect(setOf(query(g, `${HOP2} RETURN DISTINCT c.k AS k`))).toEqual(
      setOf(query(g, `${CHAIN3} RETURN DISTINCT d.k AS k`)),
    );
  });
});
