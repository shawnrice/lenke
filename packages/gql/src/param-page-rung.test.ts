import { describe, expect, test } from 'bun:test';

/**
 * A PARAMETERIZED page takes the projection rungs — item 1867.
 *
 * `outputColumnSorts` refused a `$param` window, so `ORDER BY x LIMIT 3` took a rung and
 * `ORDER BY x LIMIT $n` took none: **10.5x on the workload screen's `projection` family** (31.6 ms
 * against 3.0 with `ORDER BY` deleted, item 1866). The refused spelling is the one every paginated
 * endpoint sends; the admitted one is one no application writes.
 *
 * ⚠️ THE REASON IT GAVE WAS HALF RIGHT, AND THE HALF THAT IS RIGHT IS WHY THE TOP-K RUNGS STILL
 * REFUSE. `planCache` is a `WeakMap<Query, Plan>` keyed on the AST, which `parseCache` keys by
 * TEXT — so one compiled plan really is reused across different `$n` values, and a route that
 * depended on the value would be wrong for the next page. It does not: this route is
 * sort-then-slice either way, and `sortRowsByColumns` chooses heap-vs-sort at RUN time against the
 * real row count. `deferredRoute` is the one that picks a heap at COMPILE time and sizes it from
 * the bound, and its `typeof limit !== 'number'` stays.
 *
 * ⚠️ SO THE LOAD-BEARING TEST IS NOT "DOES IT ANSWER" BUT "DOES IT ANSWER THE SAME ACROSS TWO
 * DIFFERENT BINDINGS OF ONE PLAN". A per-call resolution that leaked the first page's bound into
 * the second would pass every single-query test in this file and fail only that one.
 */
import { Graph } from '@lenke/core';

import { outputColumnSorts } from './executor/ordered-rows.js';
import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * The `page` field of the plan `outputColumnSorts` builds, as plain data.
 *
 * ⚠️ IT HAS ITS OWN TEST BECAUSE ROUTING A LITERAL WINDOW THROUGH `page` IS ANSWER-EQUIVALENT, so
 * no answer test can see it — and a mutant that does exactly that SURVIVED the first run. It is not
 * harmless: the re-entry it causes is what measured the literal `OFFSET 100 LIMIT 20` control at
 * **0.68 -> 1.00 ms (1.47x SLOWER)** before `sortRowsByColumns` was restructured to branch once.
 * `perf-gate-needs-its-own-test`: a route choice needs its gate asserted directly.
 */
const planPage = (src: string): { skip: unknown; limit: unknown } | undefined => {
  const q = parse(src) as never as {
    parts: readonly { clauses: readonly { kind: string; projection?: unknown }[] }[];
  };
  const ret = q.parts[0].clauses.find((c) => c.kind === 'return');

  return (
    outputColumnSorts(ret as never, ['x', 's', 'y']) as unknown as
      | { page?: { skip: unknown; limit: unknown } }
      | null
      | undefined
  )?.page;
};

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

/** Distinct `k` so the sort is a total order and a wrong page is visible as wrong VALUES. */
const build = (n: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i, s: `s${i % 7}` } });
  }

  for (let i = 0; i + 1 < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`) as never,
      to: g.getVertexById(`v${i + 1}`) as never,
      labels: ['E'],
    });
  }

  return g;
};

const col = (g: Graph, text: string, params: Record<string, unknown> = {}): unknown[] =>
  query(g, text, params).map((r) => r.x);

const NODE = 'MATCH (n:T) RETURN n.k AS x, n.s AS s ORDER BY x';
const HOP = 'MATCH (a:T)-[:E]->(b:T) RETURN b.k AS x, a.k AS y ORDER BY x';

describe('a parameterized page takes the rung', () => {
  test('every spelling routes, where only the literal ones did', () => {
    for (const tail of [
      'LIMIT 3',
      'LIMIT $n',
      'OFFSET $s',
      'OFFSET $s LIMIT $n',
      'OFFSET 3 LIMIT $n',
      'OFFSET $s LIMIT 3',
    ]) {
      expect(routes(`${NODE} ${tail}`)).toContain('nodeProjection');
      expect(routes(`${HOP} ${tail}`)).toContain('hopProjection');
    }
  });

  /**
   * ⚠️ ONLY A PARAMETERIZED WINDOW TRAVELS ON `page`. A literal one must resolve at compile time
   * and carry none, so `sortRowsByColumns` runs its original body with no re-entry — see the note
   * on `planPage` for the 1.47x that costs when it does not.
   */
  test('a LITERAL window carries no deferred page; a parameterized one does', () => {
    expect(planPage(`${NODE} LIMIT 3`)).toBeUndefined();
    expect(planPage(`${NODE} OFFSET 5 LIMIT 3`)).toBeUndefined();
    expect(planPage(NODE)).toBeUndefined();

    expect(planPage(`${NODE} LIMIT $n`)).toEqual({ skip: 0, limit: { param: 'n' } });
    expect(planPage(`${NODE} OFFSET $s`)).toEqual({ skip: { param: 's' }, limit: undefined });
    expect(planPage(`${NODE} OFFSET $s LIMIT $n`)).toEqual({
      skip: { param: 's' },
      limit: { param: 'n' },
    });
    // A MIXED window is parameterized as a whole — one literal half does not make it literal.
    expect(planPage(`${NODE} OFFSET 3 LIMIT $n`)).toEqual({ skip: 3, limit: { param: 'n' } });
  });

  /**
   * ⚠️ THE ONE THAT CATCHES A LEAKED BOUND. The same compiled plan is driven twice with different
   * params — the parse and plan caches are keyed on the TEXT, so the second call reuses the first
   * call's plan — and the two answers must differ exactly as the bounds do.
   */
  test('one plan, two bindings, two different pages', () => {
    const g = build(50);

    expect(col(g, `${NODE} OFFSET $s LIMIT $n`, { s: 0, n: 3 })).toEqual([0, 1, 2]);
    expect(col(g, `${NODE} OFFSET $s LIMIT $n`, { s: 10, n: 3 })).toEqual([10, 11, 12]);
    expect(col(g, `${NODE} OFFSET $s LIMIT $n`, { s: 47, n: 3 })).toEqual([47, 48, 49]);
    // And back to the first page, so an accumulated offset would show.
    expect(col(g, `${NODE} OFFSET $s LIMIT $n`, { s: 0, n: 3 })).toEqual([0, 1, 2]);
  });

  /**
   * ⚠️ THE PAGINATION PROPERTY, which is what an application actually relies on: walking the pages
   * must reconstruct the whole ordered result exactly once. A dropped or duplicated row at a page
   * boundary is the classic failure and no single-page assertion sees it.
   */
  test('walking the pages reconstructs the full ordered result', () => {
    const g = build(37);
    const all = col(g, NODE);
    const walked: unknown[] = [];

    for (let s = 0; s < 40; s += 4) {
      walked.push(...col(g, `${NODE} OFFSET $s LIMIT $n`, { s, n: 4 }));
    }

    expect(walked).toEqual(all);
    expect(all).toHaveLength(37);
  });

  test('the same over a hop, with two columns', () => {
    const g = build(40);
    const all = query(g, HOP).map((r) => `${String(r.x)}/${String(r.y)}`);
    const walked: string[] = [];

    for (let s = 0; s < 45; s += 5) {
      walked.push(
        ...query(g, `${HOP} OFFSET $s LIMIT $n`, { s, n: 5 }).map(
          (r) => `${String(r.x)}/${String(r.y)}`,
        ),
      );
    }

    expect(walked).toEqual(all);
  });

  /** Edge bounds: a zero limit, an offset past the end, and a limit past the end. */
  test('degenerate bounds answer what the literal spelling answers', () => {
    const g = build(20);

    expect(col(g, `${NODE} LIMIT $n`, { n: 0 })).toEqual([]);
    expect(col(g, `${NODE} OFFSET $s`, { s: 100 })).toEqual([]);
    expect(col(g, `${NODE} LIMIT $n`, { n: 999 })).toEqual(col(g, NODE));
    expect(col(g, `${NODE} OFFSET $s LIMIT $n`, { s: 18, n: 99 })).toEqual([18, 19]);
  });

  /**
   * ⚠️ THE NULL CONTROL the build was required to show (item 1866's third condition): the LITERAL
   * spelling must be UNCHANGED, because this touched a gate every projection rung reads. A param
   * page that worked while silently moving the literal page's answer is a regression, not a win.
   */
  test('CONTROL — the literal spelling answers exactly as before', () => {
    const g = build(30);

    expect(col(g, `${NODE} LIMIT 3`)).toEqual([0, 1, 2]);
    expect(col(g, `${NODE} OFFSET 5 LIMIT 3`)).toEqual([5, 6, 7]);
    expect(col(g, `${NODE} OFFSET 28`)).toEqual([28, 29]);
    expect(col(g, `${NODE} LIMIT 0`)).toEqual([]);
    // And a literal page equals its parameterized twin on the same bounds.
    expect(col(g, `${NODE} OFFSET 5 LIMIT 3`)).toEqual(
      col(g, `${NODE} OFFSET $s LIMIT $n`, { s: 5, n: 3 }),
    );
  });

  /**
   * ⚠️ A BAD BOUND MUST STILL RAISE, on this route as on the general one. `compileProjection` calls
   * `noteCountParam` for both bounds, so the check is route-independent — but "route-independent"
   * is a claim about code I did not write, so it is tested rather than cited. A negative bound
   * reaching `rows.slice()` unchecked would silently return the LAST k rows.
   */
  test('a negative or missing bound raises rather than slicing from the end', () => {
    const g = build(20);

    expect(() => col(g, `${NODE} LIMIT $n`, { n: -1 })).toThrow();
    expect(() => col(g, `${NODE} OFFSET $s`, { s: -5 })).toThrow();
    expect(() => col(g, `${NODE} LIMIT $n`, {})).toThrow();
  });

  /** DESC, so the window is applied after the order rather than to the arrival order. */
  test('a descending sort pages from the other end', () => {
    const g = build(10);

    expect(
      col(g, 'MATCH (n:T) RETURN n.k AS x ORDER BY x DESC OFFSET $s LIMIT $n', { s: 0, n: 3 }),
    ).toEqual([9, 8, 7]);
    expect(
      col(g, 'MATCH (n:T) RETURN n.k AS x ORDER BY x DESC OFFSET $s LIMIT $n', { s: 8, n: 5 }),
    ).toEqual([1, 0]);
  });
});
