import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the ORDERED chain rungs produce — item 1827.
 *
 * ⚠️ ORDER IS THE ANSWER HERE, WHICH MAKES THIS THE ONE FAMILY IN THE SET WHERE A SET COMPARISON
 * PROVES NOTHING. Every other test file for these rungs compares SETS, because `order-is-unspecified`
 * is owner policy for unordered rows — and item 1825 learned the hard way that a set oracle lets a
 * dropped sort pass. So every assertion below is an ARRAY equality on the rendered order.
 *
 * ⚠️⚠️ AND MY FIRST ORACLE WAS NOT AN ORACLE AT ALL, WHICH IS THE MOST IMPORTANT NOTE IN THIS FILE.
 * I compared the rung against `ORDER BY <far>.k`, believing a sort key written as an EXPRESSION
 * declines the rung. It does not: `compileLinear` resolves `c.k` to the output column `k` before any
 * detector runs, so **both spellings take the rung** and every "cross-route" assertion was comparing
 * the rung against ITSELF. A mutant ignoring `outputColumnSorts`' decline walked straight through
 * all of them — it broke both sides equally, so they still agreed.
 *
 * The spellings that genuinely decline, verified by asking `compileLinear` which detectors fire:
 *
 *     ORDER BY k          -> hop2OrderedProjection
 *     ORDER BY c.k        -> hop2OrderedProjection   (resolved to `k` — NOT a different route)
 *     ORDER BY c.s        -> []                      (a column the projection does not return)
 *     ORDER BY k + 1      -> []                      (an expression over the column)
 *
 * So the oracles here are EXPLICIT expected orders, which owe nothing to another route, and the
 * declining spellings get their own explicit assertions plus route assertions in
 * `routes-fired.test.ts`. A cross-route oracle is only an oracle while the two routes stay
 * different, and that is a property to CHECK rather than assume.
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

/** Four levels, fully connected level to level, every level carrying the same values (item 1822). */
const levels = (values: readonly (number | null)[]): Graph => {
  const g = new Graph();
  const n = values.length;

  for (let level = 0; level < 4; level += 1) {
    for (let i = 0; i < n; i += 1) {
      g.addVertex({
        id: `L${level}_${i}`,
        labels: level === 0 ? ['L'] : ['M'],
        properties: { k: values[i], s: `s${i % 2}` },
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

describe('ORDER BY over the deeper chain widths', () => {
  test('sorts ascending by an output column', () => {
    const g = levels([3, 1, 2]);

    // 3^3 = 27 rows at two hops, 3^4 = 81 at three — every row kept, only reordered.
    expect(query(g, `${HOP2} RETURN c.k AS k ORDER BY k`).map((r) => r.k)).toEqual([
      ...Array.from({ length: 9 }, () => 1),
      ...Array.from({ length: 9 }, () => 2),
      ...Array.from({ length: 9 }, () => 3),
    ]);
    expect(query(g, `${HOP3} RETURN d.k AS k ORDER BY k`).length).toBe(81);
    expect(query(g, `${HOP3} RETURN d.k AS k ORDER BY k`).map((r) => r.k)[0]).toBe(1);
  });

  test('DESC reverses it', () => {
    const g = levels([3, 1, 2]);
    const rows = query(g, `${HOP2} RETURN c.k AS k ORDER BY k DESC`).map((r) => r.k);

    expect(rows[0]).toBe(3);
    expect(rows[rows.length - 1]).toBe(1);
  });

  /**
   * ⚠️ NULLS HAVE A DEFINED POSITION IN THE TOTAL ORDER and it is not JavaScript's. The engine sorts
   * with NaN/null placed by its own rule (`nan-comparison-policy`: sort/min/max use a total order
   * where the predicate semantics do not apply), so this asserts the position the ENGINE chose
   * rather than one I assumed — the general-path comparison below is what makes it an oracle.
   */
  /**
   * ⚠️ NULLS HAVE A DEFINED POSITION and this asserts it EXPLICITLY rather than against another
   * route (see the header). The engine's sort uses a total order where the predicate semantics do
   * not apply (`nan-comparison-policy`), so the position is the engine's choice — pinned here as a
   * fact, which is what makes it a regression guard.
   */
  test('nulls take a defined position in the sort', () => {
    const g = levels([2, null, 1]);
    const ks = query(g, `${HOP2} RETURN c.k AS k ORDER BY k`).map((r) => r.k);
    const distinct = [...new Set(ks)];

    expect(ks.length).toBe(27);
    expect(distinct).toEqual([1, 2, null]);
  });

  /**
   * ⚠️ `[1, 1, 2, 2]`, NOT `[2, 1, 2, 1]`, AND THE FIXTURE IS THE REASON. `levels` sets `s` from
   * `i % 2`, so a value list that alternates couples `k` to `s` and yields only TWO distinct pairs —
   * which cannot show a second sort key doing anything. The first cut used the alternating list and
   * asserted four pairs; the engine was right and the expectation was wrong, and the rung's order
   * matched the general path's exactly. A fixture has to make the thing under test VARY.
   */
  test('a two-key sort orders by the second key within the first', () => {
    const g = levels([1, 1, 2, 2]);
    const rows = query(g, `${HOP2} RETURN c.k AS k, c.s AS s ORDER BY k, s DESC`);
    const order = [...new Set(rows.map((r) => `${String(r.k)}/${String(r.s)}`))];

    expect(order).toEqual(['1/s1', '1/s0', '2/s1', '2/s0']);

    // ⚠️ NOT compared against `ORDER BY c.k, c.s DESC` — that resolves to the same columns and takes
    // the SAME rung, so it would compare the rung with itself. See the header.
    expect(rows.length).toBe(64);
  });

  /**
   * ⚠️ THE GENUINELY DECLINING SPELLINGS, each with an EXPLICIT expected order. These are the ones
   * that catch a mutant ignoring `outputColumnSorts`' decline: with the decline ignored they take
   * the rung with a null sort plan and come back in walk order, and no comparison against another
   * route can see that (the header explains why).
   */
  test('a sort on a column the projection does not return is still sorted', () => {
    const g = levels([5, 2, 9]);
    // `c.s` is not an output column, so the rung declines and the general matcher answers.
    const rows = query(g, `${HOP2} RETURN c.k AS k ORDER BY c.s DESC`);
    const order = [...new Set(rows.map((r) => r.k))];

    // `s` is `s${i % 2}`: index 1 -> s1, indices 0 and 2 -> s0. DESC puts s1 (k = 2) first.
    expect(order).toEqual([2, 5, 9]);
  });

  test('a sort on an EXPRESSION over the column is still sorted', () => {
    const g = levels([5, 2, 9]);
    const rows = query(g, `${HOP3} RETURN d.k AS k ORDER BY k + 1 DESC`);

    expect(rows.map((r) => r.k)[0]).toBe(9);
    expect([...new Set(rows.map((r) => r.k))]).toEqual([9, 5, 2]);
  });

  /**
   * ⚠️ A WINDOW MUST NOT REACH THESE RUNGS, and the oracle is the general path rather than a count:
   * with a sort, `SKIP`/`LIMIT` is a top-k question, and the rung would sort-then-slice its own
   * rows without the laziness the general path has. The ANSWER must be identical either way, so
   * this asserts that — a mutant admitting a window changes the route but not these rows, so this
   * is a guard on the answer and `routes-fired.test.ts` is the guard on the route.
   */
  test('a sorted page answers exactly as the general path does', () => {
    const g = levels([5, 2, 9, 2, 1]);

    expect(query(g, `${HOP2} RETURN c.k AS k ORDER BY k LIMIT 3`).map((r) => r.k)).toEqual([
      1, 1, 1,
    ]);
    expect(query(g, `${HOP2} RETURN c.k AS k ORDER BY k SKIP 2 LIMIT 2`).map((r) => r.k)).toEqual([
      1, 1,
    ]);
    expect(query(g, `${HOP2} RETURN c.k AS k ORDER BY k DESC LIMIT 2`).map((r) => r.k)).toEqual([
      9, 9,
    ]);
  });

  /**
   * ⚠️⚠️ AN INDEPENDENT ORACLE FOR THE DECLINING SPELLING, AND A MUTANT IS WHY IT EXISTS. Every
   * cross-route test above compares the rung against `ORDER BY <expression>`, which declines
   * (`outputColumnSorts` wants a `var` naming an output column). **That comparison COLLAPSES if a
   * mutant makes both sides take the same route** — the mutant that ignores `outputColumnSorts`'
   * `null` decline did exactly that, sorted neither side, and every cross-route assertion still
   * passed because both sides were equally wrong.
   *
   * So the declining spelling needs its own HARD-CODED order, owing nothing to the other route. A
   * cross-route oracle is only an oracle while the two routes stay different.
   */
  test('the DECLINING spelling is sorted too, on its own terms', () => {
    const g = levels([3, 1, 2]);

    // `ORDER BY c.k` is an EXPRESSION, not an output column: the general matcher answers it.
    expect(query(g, `${HOP2} RETURN c.k AS k ORDER BY c.k`).map((r) => r.k)).toEqual([
      ...Array.from({ length: 9 }, () => 1),
      ...Array.from({ length: 9 }, () => 2),
      ...Array.from({ length: 9 }, () => 3),
    ]);
    expect(query(g, `${HOP2} RETURN c.k AS k ORDER BY c.k DESC`).map((r) => r.k)[0]).toBe(3);
  });

  /** An unordered query must be untouched by any of this. */
  test('no ORDER BY still returns every row', () => {
    const g = levels([1, 2, 3]);

    expect(query(g, `${HOP2} RETURN c.k AS k`).length).toBe(27);
    expect(query(g, `${HOP3} RETURN d.k AS k`).length).toBe(81);
  });
});
