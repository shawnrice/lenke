/**
 * THE SKIP-ONLY PAGE ON THE NODE-PROJECTION RUNG (item 1776).
 *
 * `MATCH (n:L) RETURN n.k OFFSET k` used to decline every projection rung and fall to the general
 * pipeline, at a measured **7.9x** over 200,000 vertices — for TEN FEWER ROWS than the unpaged
 * spelling that took the rung (item 1775). The decline was one condition shared with `LIMIT`, where
 * it is CORRECT: the general path is lazy, so a `LIMIT 10` stops after ten rows where the rung
 * materializes everything (360x in the general path's favour, measured at the same item). A skip
 * alone has no such brake — the engine still emits `N - k` rows either way — so the rung now takes
 * it and slices.
 *
 * ⚠️ THE ORACLE IS THE PARAMETERIZED SPELLING, and that is what makes this a real equivalence test
 * rather than a tautology. `OFFSET $s` declines the rung on purpose (the route is chosen at compile
 * time while the value lives in `params`, which the plan cache is shared across), so
 * `OFFSET 2` and `OFFSET $s` with `s = 2` are the same query down TWO DIFFERENT ROUTES. Comparing
 * them compares the rung against the general pipeline, which is the claim.
 *
 * The comparison is POSITIONAL over the whole row list, not a multiset one. A skip is not
 * order-invariant the way a projection is — skipping the first k of two different visit orders
 * yields different multisets — so `order-is-unspecified` does not license this rewrite, and the
 * identity of the orders is the thing that has to hold. `offset-order-equiv.mjs` is the same check
 * at 5,000 vertices and four skip values.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { unsortedPageRoute } from './executor/ordered-rows.ts';
import { query } from './index.ts';

/**
 * THE RULE ITSELF, as a function. A route choice is answer-equivalent, so a mutant that flips one
 * of these conditions returns the same rows by the other path and survives every behavioural test
 * in this file — [[perf-gate-needs-its-own-test]]. The route assertions in `routes-fired.test.ts`
 * are the other half: they pin which rung a shape actually reaches.
 */
describe('unsortedPageRoute — the admission rule, tested as a function', () => {
  it('admits a literal skip with no limit, returning the skip to slice by', () => {
    expect(unsortedPageRoute({ skip: 10 })).toBe(10);
    expect(unsortedPageRoute({ skip: 1 })).toBe(1);
  });

  it('declines a limit, with or without a skip — the general path is lazy for it', () => {
    expect(unsortedPageRoute({ limit: 10 })).toBeNull();
    expect(unsortedPageRoute({ skip: 10, limit: 10 })).toBeNull();
    // `LIMIT 0` too, which `applyProjection` answers with `[]` before projecting anything.
    expect(unsortedPageRoute({ limit: 0 })).toBeNull();
  });

  it('declines a PARAMETERIZED skip — the plan cache is shared across params', () => {
    expect(unsortedPageRoute({ skip: { param: 's' } })).toBeNull();
    expect(unsortedPageRoute({ skip: { param: 's' }, limit: 10 })).toBeNull();
  });

  it('declines a vacuous SKIP 0 rather than admitting it as a no-op page', () => {
    expect(unsortedPageRoute({ skip: 0 })).toBeNull();
  });

  it('reports 0 — not a decline — when there is no window at all', () => {
    expect(unsortedPageRoute({})).toBe(0);
  });

  it('reports 0 for ANY window under an ORDER BY, which outputColumnSorts owns', () => {
    const orderBy = [{ expr: { kind: 'var', name: 'k' }, descending: false }] as never;

    expect(unsortedPageRoute({ orderBy, skip: 10 })).toBe(0);
    expect(unsortedPageRoute({ orderBy, skip: 10, limit: 5 })).toBe(0);
    expect(unsortedPageRoute({ orderBy, limit: 5 })).toBe(0);
  });
});

/** 24 vertices, so a skip of 1, 7 and 23 each leaves a different-shaped tail. */
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 24; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: ['L'],
      // `k` repeats every 5, so a positional comparison can fail where a value-wise one passes.
      properties: { k: i % 5, n: 100 - i, s: `s${i}` },
    });
  }

  // A second label the scan must not emit, so a wrong candidate set shows up as a row count.
  g.addVertex({ id: 'other', labels: ['M'], properties: { k: 0, n: 0, s: 'x' } });

  return g;
};

describe('a skip-only page on the node-projection rung', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['one column', 'MATCH (n:L) RETURN n.k AS k OFFSET '],
    ['two columns', 'MATCH (n:L) RETURN n.k AS k, n.n AS t OFFSET '],
    ['an expression column', 'MATCH (n:L) RETURN n.k + 1 AS k, n.s AS s OFFSET '],
    ['a clause WHERE', 'MATCH (n:L) WHERE n.n > 110 RETURN n.k AS k OFFSET '],
    ['an inline property', 'MATCH (n:L {k: 2}) RETURN n.n AS t OFFSET '],
  ];

  for (const [name, prefix] of CASES) {
    for (const skip of [1, 7, 23]) {
      it(`${name}, OFFSET ${skip} — identical rows and order to the general path`, () => {
        const g = build();
        const viaRung = query(g, `${prefix}${skip}`);
        const viaGeneral = query(g, `${prefix}$s`, { s: skip });

        expect(viaRung).toEqual(viaGeneral);
      });
    }
  }

  it('a skip past the end returns no rows, on both routes', () => {
    const g = build();

    expect(query(g, 'MATCH (n:L) RETURN n.k AS k OFFSET 99')).toEqual([]);
    expect(query(g, 'MATCH (n:L) RETURN n.k AS k OFFSET $s', { s: 99 })).toEqual([]);
  });

  /**
   * A projection that can FAULT still raises for a row the page discards, because both routes
   * project every row and page the PROJECTED ones. `skipcast_426` records that as the engines'
   * current behaviour — checked natively — and a conformance question rather than something an
   * optimization pass settles, so the rung has to match it rather than improve on it.
   */
  it('a faulting projection raises on BOTH routes, even for a skipped row', () => {
    const g = new Graph();

    g.addVertex({ id: 'bad', labels: ['L'], properties: { s: 'not a number' } });
    g.addVertex({ id: 'good', labels: ['L'], properties: { s: '7' } });

    expect(() => query(g, 'MATCH (n:L) RETURN CAST(n.s AS INTEGER) AS x OFFSET 1')).toThrow();
    expect(() =>
      query(g, 'MATCH (n:L) RETURN CAST(n.s AS INTEGER) AS x OFFSET $s', { s: 1 }),
    ).toThrow();
  });
});
