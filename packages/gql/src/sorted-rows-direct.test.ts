// `sortedRowsDirect` — `ORDER BY` with no per-row `Map` round-trip (item 2018).
//
// ⚠️⚠️⚠️ **EVERY QUERY HERE IS A COMMA PATTERN, AND THAT IS NOT INCIDENTAL — IT IS THE ONLY WAY TO
// REACH THIS PATH.** My first version of this file used `MATCH (a:T) RETURN a.n AS x ORDER BY x` and
// hop shapes. All 13 tests passed and tested NOTHING: the mutation round came back with
// `sort-removed`, `keys-reversed`, `first-row-dropped`, `cmp-ignores-descending` and
// `cmp-first-key-only` all SURVIVING the file, because node-scan and hop rungs answer those shapes
// entirely and never reach `projectedRows`. [[rung-precedence-decides-speed]] — a willing path is
// starved by a broader one above it, and timing cannot tell declined from served.
//
// 🔑 **HOW THE REACHING SHAPES WERE IDENTIFIED: THE MUTANT WAS USED AS THE DETECTOR.** Deleting the
// `keyed.sort(...)` call and re-running a candidate list, the shapes whose ROW ORDER changed are
// exactly the ones routed here:
//
//     rung     MATCH (a:T) RETURN a.n AS x ORDER BY x
//     rung     MATCH (a:T) RETURN a.t AS t, a.n AS x ORDER BY t, x
//     rung     MATCH (a:T)-[:E]->(b:T) RETURN a.n AS x, b.n AS y ORDER BY x, y
//     REACHES  MATCH (a:T), (b:T) …  ← every comma-pattern spelling
//
// ⚠️ WHAT THIS PATH MUST PRESERVE, none of which a row COUNT or a multiset comparison can see:
// COLUMN order (the output's observable shape, [[column-order-is-observable]]), TIE order (rows that
// compare equal keep INPUT order — the differential fuzzer compares multisets, so it is blind to
// this), each key's DESC/NULLS flags, and the row a faulting projection raises on.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { sortedDirectRoute } from './executor/projection.js';
import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * ⚠️ `t` IS A TIE COLUMN WHOSE GROUPS ARE NOT INTERNALLY SORTED: `t = 1` holds v1, v3, v5 whose
   * `n` reads 50, 40, 30 in input order — neither ascending nor descending. So `ORDER BY t` can
   * only produce that sequence from a STABLE sort, and any reordering of ties shows up.
   *
   * ⚠️ `z` IS NULL on v2 and v5 — stored nulls, which are present values in this engine
   * ([[null-first-class-policy]]) — so the null ordering is observable in both directions.
   */
  for (const [id, n, t, z] of [
    ['v1', 50, 1, 7],
    ['v2', 10, 2, null],
    ['v3', 40, 1, 3],
    ['v4', 20, 2, 9],
    ['v5', 30, 1, null],
  ] as const) {
    g.addVertex({ id, labels: ['T'], properties: { n, t, z } });
  }

  return g;
};

const rows = (g: Graph, q: string): Record<string, unknown>[] =>
  [...query(g, q)] as Record<string, unknown>[];

/* A one-row second leg, so the comma pattern routes here without multiplying the row count. */
const ONE = 'MATCH (a:T), (b:T) WHERE b.n = 10 ';

describe('sortedRowsDirect: the answers', () => {
  const g = build();

  test('TIES KEEP INPUT ORDER, which the differential fuzzer cannot check', () => {
    // `t = 1` is v1, v3, v5 → n reads 50, 40, 30. Neither sorted direction produces that.
    expect(rows(g, `${ONE}RETURN a.t AS t, a.n AS x ORDER BY t`)).toEqual([
      { t: 1, x: 50 },
      { t: 1, x: 40 },
      { t: 1, x: 30 },
      { t: 2, x: 10 },
      { t: 2, x: 20 },
    ]);
    // DESC moves the GROUPS and leaves each group's input order alone — stable both ways.
    expect(rows(g, `${ONE}RETURN a.t AS t, a.n AS x ORDER BY t DESC`)).toEqual([
      { t: 2, x: 10 },
      { t: 2, x: 20 },
      { t: 1, x: 50 },
      { t: 1, x: 40 },
      { t: 1, x: 30 },
    ]);
  });

  test('NULLS sort LAST in both directions, and keep input order among themselves', () => {
    expect(rows(g, `${ONE}RETURN a.z AS z, a.n AS x ORDER BY z`)).toEqual([
      { z: 3, x: 40 },
      { z: 7, x: 50 },
      { z: 9, x: 20 },
      { z: null, x: 10 },
      { z: null, x: 30 },
    ]);
    expect(rows(g, `${ONE}RETURN a.z AS z, a.n AS x ORDER BY z DESC`)).toEqual([
      { z: 9, x: 20 },
      { z: 7, x: 50 },
      { z: 3, x: 40 },
      { z: null, x: 10 },
      { z: null, x: 30 },
    ]);
  });

  test('THE SECOND KEY MUST ACTUALLY BREAK THE TIE — `y DESC` against input order', () => {
    /*
     * ⚠️⚠️ **MY FIRST TWO-KEY TEST COULD NOT SEE A BROKEN SECOND KEY.** With `ORDER BY x, y` the
     * `b` rows arrive as y = 10 then 20, which is ALREADY ascending — so a comparator that ignored
     * every key after the first (or compared `keys[0]` twice) returned the same array, and both
     * mutants survived. `y DESC` makes the required order 20, 10 — the opposite of arrival — so
     * only a working second key produces it.
     */
    expect(
      rows(g, 'MATCH (a:T), (b:T) WHERE b.n < 30 RETURN a.n AS x, b.n AS y ORDER BY x, y DESC'),
    ).toEqual([
      { x: 10, y: 20 },
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 20, y: 10 },
      { x: 30, y: 20 },
      { x: 30, y: 10 },
      { x: 40, y: 20 },
      { x: 40, y: 10 },
      { x: 50, y: 20 },
      { x: 50, y: 10 },
    ]);
  });

  test('TWO keys, both ascending', () => {
    expect(
      rows(g, 'MATCH (a:T), (b:T) WHERE b.n < 30 RETURN a.n AS x, b.n AS y ORDER BY x, y'),
    ).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 10 },
      { x: 30, y: 20 },
      { x: 40, y: 10 },
      { x: 40, y: 20 },
      { x: 50, y: 10 },
      { x: 50, y: 20 },
    ]);
  });

  test('a sort key that is NOT projected', () => {
    // ORDER BY a.z, a.n → z 3,7,9,null,null → x 40,50,20,10,30.
    expect(rows(g, `${ONE}RETURN a.n AS x ORDER BY a.z, a.n`).map((r) => r.x)).toEqual([
      40, 50, 20, 10, 30,
    ]);
  });

  test('COLUMN ORDER is the projection’s, whichever column the key names', () => {
    // ⚠️ Row order is unspecified without ORDER BY, but COLUMN order is bytes.
    expect(Object.keys(rows(g, `${ONE}RETURN a.t AS t, a.n AS x ORDER BY x`)[0])).toEqual([
      't',
      'x',
    ]);
    expect(Object.keys(rows(g, `${ONE}RETURN a.n AS x, a.t AS t ORDER BY x`)[0])).toEqual([
      'x',
      't',
    ]);
  });

  test('the PROJECTION is what raises, on the row the general path raises on', () => {
    /*
     * ⚠️ PROJECT FIRST, THEN THE KEYS. The general path builds each projected row before any
     * comparison, so a projection that raises does so before the sort. A path that evaluated sort
     * keys first could surface a different error, or none.
     */
    expect(() => rows(g, `${ONE}RETURN 1 / (a.t - 1) AS x ORDER BY a.n`)).toThrow();
  });
});

describe('sortedRowsDirect: the general path is the ORACLE', () => {
  const g = build();

  test('every reaching shape matches its windowed twin, element for element', () => {
    /*
     * 🔑 **A WINDOW DECLINES THIS PATH**, so `… LIMIT 1000` over a 5-row result is the SAME query
     * answered by the general route — a real oracle rather than the fast path blessing itself. (The
     * window declines for a reason worth keeping in view: with `SKIP`/`LIMIT` the general path
     * projects only survivors, so projecting everything could raise where the query does not —
     * item 604 measured that on both engines.)
     */
    for (const q of [
      `${ONE}RETURN a.t AS t, a.n AS x ORDER BY t`,
      `${ONE}RETURN a.t AS t, a.n AS x ORDER BY t DESC`,
      `${ONE}RETURN a.z AS z, a.n AS x ORDER BY z`,
      `${ONE}RETURN a.z AS z, a.n AS x ORDER BY z DESC`,
      `${ONE}RETURN a.n AS x ORDER BY a.z, a.n`,
      'MATCH (a:T), (b:T) WHERE b.n < 30 RETURN a.n AS x, b.n AS y ORDER BY x, y',
      'MATCH (a:T), (b:T) RETURN a.n AS x, b.n AS y ORDER BY x DESC, y',
      'MATCH (a:T), (b:T) WHERE a.n > b.n RETURN a.n AS x, b.n AS y ORDER BY y',
    ]) {
      const fast = rows(g, q);
      const general = rows(g, `${q} LIMIT 1000`);

      // ⚠️ A NON-EMPTY RESULT IS ASSERTED FIRST: two empty arrays agree trivially.
      expect(fast.length).toBeGreaterThan(0);
      expect(fast).toEqual(general);
    }
  });
});

describe('sortedRowsDirect: the four refusals, each answering identically', () => {
  const g = build();

  test('an AGGREGATE declines and still sorts', () => {
    const got = rows(g, `${ONE}LET k = a.t RETURN k, count(*) AS c GROUP BY k ORDER BY c, k`);

    expect(got.map((r) => r.c)).toEqual([2, 3]);
    expect(got.map((r) => r.k)).toEqual([2, 1]);
  });

  test('DISTINCT declines and still sorts', () => {
    expect(rows(g, `${ONE}RETURN DISTINCT a.t AS t ORDER BY t`)).toEqual([{ t: 1 }, { t: 2 }]);
  });

  test('a WINDOW declines and still sorts', () => {
    expect(rows(g, `${ONE}RETURN a.n AS x ORDER BY x LIMIT 2`).map((r) => r.x)).toEqual([10, 20]);
    expect(rows(g, `${ONE}RETURN a.n AS x ORDER BY x OFFSET 3`).map((r) => r.x)).toEqual([40, 50]);
    expect(rows(g, `${ONE}RETURN a.n AS x ORDER BY x OFFSET 1 LIMIT 2`).map((r) => r.x)).toEqual([
      20, 30,
    ]);
  });

  test('a key that NEEDS the projected columns declines and still sorts', () => {
    // `orderNeedsOutput` — item 2017's shadowing-alias-in-an-expression shape.
    expect(rows(g, `${ONE}RETURN a.n AS a ORDER BY a + 2`).map((r) => r.a)).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });

  test('NO sort at all still takes the UNSORTED fast path', () => {
    // Row order is unspecified here, so this asserts the multiset and the column shape only.
    const got = rows(g, `${ONE}RETURN a.n AS x`);

    expect(got).toHaveLength(5);
    expect(got.map((r) => r.x as number).sort((p, q) => p - q)).toEqual([10, 20, 30, 40, 50]);
  });
});

describe('sortedDirectRoute: the gate itself', () => {
  /*
   * ⚠️⚠️ **THE FOUR REFUSALS ARE ANSWER-EQUIVALENT — the general path returns the same rows — so
   * NOTHING in the answer tests above can see one being dropped.** The mutation round proved it:
   * "admit aggregating" survived this whole file while every walk mutant was caught. The gate is a
   * pure function for exactly this ([[perf-gate-needs-its-own-test]], item 1776's pattern), and
   * these are the assertions that hold it.
   */
  const proj = (over: Partial<Parameters<typeof sortedDirectRoute>[0]>) =>
    ({
      aggregating: false,
      distinct: false,
      orderNeedsOutput: false,
      orderBy: [{ fn: () => null, descending: false, nullsFirst: false }],
      ...over,
    }) as Parameters<typeof sortedDirectRoute>[0];

  test('TAKES a plain sorted projection', () => {
    expect(sortedDirectRoute(proj({}), false)).toBe(true);
  });

  test('REFUSES each of the four, one at a time', () => {
    expect(sortedDirectRoute(proj({ aggregating: true }), false)).toBe(false);
    expect(sortedDirectRoute(proj({ distinct: true }), false)).toBe(false);
    expect(sortedDirectRoute(proj({ orderNeedsOutput: true }), false)).toBe(false);
    expect(sortedDirectRoute(proj({}), true)).toBe(false);
  });

  test('REFUSES an unsorted projection, which the other fast path owns', () => {
    expect(sortedDirectRoute(proj({ orderBy: [] }), false)).toBe(false);
  });
});
