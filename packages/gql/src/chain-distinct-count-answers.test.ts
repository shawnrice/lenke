import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the `count(DISTINCT …)` chain rungs produce — item 1824.
 *
 * THIS IS AN AGGREGATE, WHICH MAKES A WRONG ANSWER THE WORST CLASS HERE, and the trap is
 * specific and documented: **`count(DISTINCT x)` EXCLUDES nulls while `RETURN DISTINCT x` KEEPS
 * null as a row.** Over `1, null, absent, 2, 1` the count is 2 and the rows are three. So the
 * obvious implementation of these rungs — take the rung's rows, `distinctRows(...).length` — is a
 * silent wrong answer on any fixture carrying a null or an absent property, and every test in this
 * file that does not involve a null would pass anyway.
 *
 * WHICH IS WHY HALF OF THESE CASES ARE NULL CASES. The route change is answer-equivalent on
 * clean data, so clean data proves nothing.
 *
 * AND THE ORACLE IS NEVER A HAND-COUNTED NUMBER ALONE where it can be the GENERAL PATH'S OWN
 * ANSWER. A spelling the rungs decline (`ORDER BY`, or a `WITH` in front) routes the same question
 * through the general matcher, so the two can be compared directly — which catches a rung that is
 * merely self-consistent.
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Four levels of `n` vertices, fully connected level to level, so every depth is reachable and the
 * undeduped row count at depth d is `n^(d+1)`. Every level carries the same values, which item
 * 1822 learned the hard way: a fixture whose values live at ONE depth can only be read at one
 * depth, and it silently broke every test at a different width.
 */
const levels = (values: readonly unknown[]): Graph => {
  const g = new Graph();
  const n = values.length;

  for (let level = 0; level < 4; level += 1) {
    for (let i = 0; i < n; i += 1) {
      const properties: Record<string, unknown> = { s: `s${i % 2}` };

      // `undefined` means the property is ABSENT, which is a different code path from a stored
      // null — and `count(DISTINCT)` must treat both as "not a value" while `RETURN DISTINCT`
      // treats a stored null as a row. Both appear below.
      if (values[i] !== undefined) {
        properties.k = values[i];
      }

      g.addVertex({
        id: `L${level}_${i}`,
        labels: level === 0 ? ['L'] : ['M'],
        properties,
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

const HOP2 = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)';
const HOP3 = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M)';

describe('count(DISTINCT) over a chain', () => {
  test('counts the distinct values, not the rows', () => {
    const g = levels([1, 2, 2, 3, 3, 3]);

    expect(query(g, `${HOP3} RETURN d.k AS k`).length).toBe(1296);
    expect(query(g, `${HOP3} RETURN count(DISTINCT d.k) AS c`)).toEqual([{ c: 3 }]);
    expect(query(g, `${HOP2} RETURN count(DISTINCT c.k) AS c`)).toEqual([{ c: 3 }]);
  });

  /**
   * THE NULL CASE, AND IT IS THE WHOLE POINT. A stored null and an absent property are both
   * excluded from the count, so `[1, null, undefined, 2, 1]` counts **2** — while
   * `RETURN DISTINCT k` over the same data is THREE rows (1, 2 and null). Asserting both here
   * pins the difference rather than the count alone.
   */
  test('a stored null and an absent property are both excluded', () => {
    const g = levels([1, null, undefined, 2, 1]);

    expect(query(g, `${HOP3} RETURN count(DISTINCT d.k) AS c`)).toEqual([{ c: 2 }]);
    expect(query(g, `${HOP2} RETURN count(DISTINCT c.k) AS c`)).toEqual([{ c: 2 }]);

    // The twin spelling, which KEEPS the null — the asymmetry a shared implementation would lose.
    expect(query(g, `${HOP3} RETURN DISTINCT d.k AS k`).length).toBe(3);
  });

  test('every value null or absent counts ZERO, not one', () => {
    const g = levels([null, undefined, null]);

    expect(query(g, `${HOP3} RETURN count(DISTINCT d.k) AS c`)).toEqual([{ c: 0 }]);
    expect(query(g, `${HOP2} RETURN count(DISTINCT c.k) AS c`)).toEqual([{ c: 0 }]);
  });

  test('a property no vertex carries counts ZERO', () => {
    const g = levels([1, 2, 3]);

    expect(query(g, `${HOP3} RETURN count(DISTINCT d.missing) AS c`)).toEqual([{ c: 0 }]);
  });

  /** `0`/`-0` are one value and NaN equals itself for keying — `valueKey`'s rules, not `===`. */
  test('0 and -0 are one value; NaN is one value', () => {
    expect(query(levels([0, -0]), `${HOP3} RETURN count(DISTINCT d.k) AS c`)).toEqual([{ c: 1 }]);
    expect(
      query(levels([Number.NaN, Number.NaN, 1]), `${HOP3} RETURN count(DISTINCT d.k) AS c`),
    ).toEqual([{ c: 2 }]);
  });

  /**
   * AN EXPRESSION WRAPPING THE AGGREGATE MUST NOT TAKE THE RUNG. `count(DISTINCT k) + 1` folds
   * the same aggregate, but the row's value is the arithmetic — a rung answering the fold's result
   * directly would silently drop the `+ 1`. This is the identity test in both detectors.
   */
  test('an expression WRAPPING the aggregate still answers correctly', () => {
    const g = levels([1, 2, 2, 3]);

    expect(query(g, `${HOP3} RETURN count(DISTINCT d.k) + 1 AS c`)).toEqual([{ c: 4 }]);
    expect(query(g, `${HOP2} RETURN count(DISTINCT c.k) + 1 AS c`)).toEqual([{ c: 4 }]);
  });

  /** A carried far-end `WHERE` must still filter before the set. */
  test('a far-end WHERE filters before the count', () => {
    const g = levels([1, 2, 3, 4, 5]);

    expect(query(g, `${HOP3} WHERE d.k > 3 RETURN count(DISTINCT d.k) AS c`)).toEqual([{ c: 2 }]);
    expect(query(g, `${HOP2} WHERE c.k > 3 RETURN count(DISTINCT c.k) AS c`)).toEqual([{ c: 2 }]);
  });

  /**
   * THE CROSS-ROUTE ORACLE. `ORDER BY` declines these rungs, so the same question goes through
   * the general matcher and the two answers must agree — the check that catches a rung which is
   * merely self-consistent. Null and absent values are in the fixture deliberately.
   */
  test('agrees with the general path on the same question', () => {
    const g = levels([3, 1, 2, 2, null, undefined, 1]);

    for (const chain of [HOP2, HOP3]) {
      const far = chain === HOP2 ? 'c' : 'd';
      const viaRung = query(g, `${chain} RETURN count(DISTINCT ${far}.k) AS c`);
      const viaGeneral = query(g, `${chain} RETURN count(DISTINCT ${far}.k) AS c ORDER BY c`);

      expect(viaRung).toEqual(viaGeneral);
      expect(viaRung).toEqual([{ c: 3 }]);
    }
  });

  /** The two widths against each other, which neither rung's own tests can ask. */
  test('the two widths agree with each other', () => {
    const g = levels([5, 5, 6, 7, null]);

    expect(query(g, `${HOP2} RETURN count(DISTINCT c.k) AS c`)).toEqual(
      query(g, `${HOP3} RETURN count(DISTINCT d.k) AS c`),
    );
  });

  /** A non-distinct `count(*)` must NOT be captured by these rungs — it has its own closed form. */
  test('count(*) is unaffected', () => {
    const g = levels([1, 2, 2]);

    expect(query(g, `${HOP3} RETURN count(*) AS c`)).toEqual([{ c: 81 }]);
    expect(query(g, `${HOP2} RETURN count(*) AS c`)).toEqual([{ c: 27 }]);
  });
});

/**
 * `min`/`max` and plain `count(x)` over the same chains — item 1830, which widened item 1824's
 * `count(DISTINCT)` detector into an ALLOWLIST of order-invariant folds.
 *
 * THE ORACLE IS VERIFIED TO DECLINE BEFORE IT IS USED, which item 1827 learned the hard way: a
 * "cross-route" comparison is worthless if both spellings take the same route. Asked directly of
 * `compileLinear`:
 *
 * ```text
 *   RETURN max(d.k) AS m          -> chainFoldedAggregate
 *   RETURN max(d.k) + 0 AS m      -> []   (the wrapping refusal — a real second route)
 *   RETURN max(d.k) AS m ORDER BY m -> [] (a sort declines it too)
 *   RETURN max(d.k), min(d.k)     -> []   (one aggregate only)
 * ```
 *
 * AND THE REFUSALS MATTER MORE THAN THE ADMISSIONS HERE. `sum`/`avg` are order-sensitive in the
 * last ulp and `collect`'s order IS its answer, so a rung whose walk order differs from the general
 * path's would break byte-identity with Rust. Those three are asserted to stay OFF this rung in
 * `routes-fired.test.ts`; what follows is the answers for the ones that are on it.
 */
describe('min/max and count(x) over a chain', () => {
  test('max and min take the extremes, not the first row', () => {
    const g = levels([5, 2, 9, 1]);

    expect(query(g, `${HOP3} RETURN max(d.k) AS m`)).toEqual([{ m: 9 }]);
    expect(query(g, `${HOP3} RETURN min(d.k) AS m`)).toEqual([{ m: 1 }]);
    expect(query(g, `${HOP2} RETURN max(c.k) AS m`)).toEqual([{ m: 9 }]);
    expect(query(g, `${HOP2} RETURN min(c.k) AS m`)).toEqual([{ m: 1 }]);
  });

  /** Nulls never reach `step`, so they neither win nor poison the extremum. */
  test('a null and an absent property are ignored by the extremum', () => {
    const g = levels([5, null, undefined, 2]);

    expect(query(g, `${HOP3} RETURN max(d.k) AS m`)).toEqual([{ m: 5 }]);
    expect(query(g, `${HOP3} RETURN min(d.k) AS m`)).toEqual([{ m: 2 }]);
  });

  /** Every value null/absent means NO value reached the fold — the answer is null, not 0. */
  test('an extremum over nothing is null', () => {
    const g = levels([null, undefined]);

    expect(query(g, `${HOP3} RETURN max(d.k) AS m`)).toEqual([{ m: null }]);
    expect(query(g, `${HOP2} RETURN min(c.k) AS m`)).toEqual([{ m: null }]);
    expect(query(g, `${HOP3} RETURN max(d.missing) AS m`)).toEqual([{ m: null }]);
  });

  test('count(x) counts the non-null values, not the rows', () => {
    const g = levels([5, null, undefined, 2]);

    // 4^4 = 256 rows at three hops; half the far values are null or absent.
    expect(query(g, `${HOP3} RETURN d.k AS k`).length).toBe(256);
    expect(query(g, `${HOP3} RETURN count(d.k) AS c`)).toEqual([{ c: 128 }]);
    expect(query(g, `${HOP3} RETURN count(*) AS c`)).toEqual([{ c: 256 }]);
  });

  /**
   * THE VERIFIED CROSS-ROUTE ORACLE. `max(d.k) + 0` is the WRAPPING refusal, confirmed above to
   * fire no rung at all — so this compares the rung against the general matcher on the same data,
   * rather than against itself.
   */
  test('agrees with the general path on the same question', () => {
    const g = levels([5, 2, 9, 1, null]);
    const viaRung = query(g, `${HOP3} RETURN max(d.k) AS m`)[0].m;
    const viaGeneral = query(g, `${HOP3} RETURN max(d.k) + 0 AS m`)[0].m;

    expect(viaRung).toBe(viaGeneral);
    expect(viaRung).toBe(9);
  });

  /** The two widths against each other, which neither rung's own tests can ask. */
  test('the two widths agree', () => {
    const g = levels([7, 3, 7, 1]);

    expect(query(g, `${HOP2} RETURN max(c.k) AS m`)).toEqual(
      query(g, `${HOP3} RETURN max(d.k) AS m`),
    );
  });
});
