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

import type { Row } from './executor/core.ts';
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

  /**
   * ⚠️ REVERSED AT ITEM 1778, and the reason is worth stating because the sibling rules go the
   * other way. `deferredRoute` and `outputColumnSorts` decline a parameterized window because a
   * `LIMIT $n` decides between a heap and a sort-and-slice — the ROUTE depends on the value, while
   * the plan cache is shared across params. A skip-only page has no such dependence: every
   * non-negative skip takes the same route and differs only in where `pageSlice` cuts. Declining it
   * cost a **7.3x gap between two spellings of one query**, which is the defect class this repo is
   * named after.
   */
  it('ADMITS a parameterized skip — the route does not depend on its value', () => {
    expect(unsortedPageRoute({ skip: { param: 's' } })).toEqual({ param: 's' });
  });

  it('still declines a parameterized skip WITH a limit', () => {
    expect(unsortedPageRoute({ skip: { param: 's' }, limit: 10 })).toBeNull();
    expect(unsortedPageRoute({ limit: { param: 'n' } })).toBeNull();
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

  const verts = [];

  for (let i = 0; i < 24; i++) {
    verts.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['L'],
        // `k` repeats every 5, so a positional comparison can fail where a value-wise one does not.
        properties: { k: i % 5, n: 100 - i, s: `s${i}` },
      }),
    );
  }

  // A second label the scan must not emit, so a wrong candidate set shows up as a row count.
  g.addVertex({ id: 'other', labels: ['M'], properties: { k: 0, n: 0, s: 'x' } });

  // One out-edge per :L vertex, CROSSED (`* 7 + 3`, coprime with 24) so the far-driven and
  // start-driven walks visit rows in genuinely different orders — on a fixture whose edges run
  // `i -> i` the two orders coincide and the hop rows below would pass without the forced walk.
  for (let i = 0; i < 24; i++) {
    g.addEdge({ id: `e${i}`, from: verts[i], to: verts[(i * 7 + 3) % 24], labels: ['R'] });
  }

  return g;
};

/**
 * THE SAME GRAPH WITH NO SECOND LABEL, and it is load-bearing for every hop row below.
 *
 * ⚠️ MUTATION IS WHY THIS EXISTS RATHER THAN MY READING IT. The hop rung picks the far-driven walk
 * only where no vertex could fail the START label — `vacuousLabel` — so on `build()`, whose stray
 * `:M` vertex makes `:L` non-vacuous, the walk is start-driven ANYWAY and the forced-walk guard is
 * never reached. Removing the force left all 35 tests green against that fixture: item 1064's
 * lesson in `topk-node-scan.test.ts` ("the size is load-bearing"), in a new place. Here every
 * vertex is `:L`, so the far-driven walk is eligible and dropping the force FAILS.
 */
const buildVacuous = (): Graph => {
  const g = new Graph();
  const verts = [];

  for (let i = 0; i < 24; i++) {
    verts.push(g.addVertex({ id: `v${i}`, labels: ['L'], properties: { k: i % 5, n: 100 - i } }));
  }

  for (let i = 0; i < 24; i++) {
    g.addEdge({ id: `e${i}`, from: verts[i], to: verts[(i * 7 + 3) % 24], labels: ['R'] });
  }

  return g;
};

describe('a skip-only page on the node-projection rung', () => {
  /** `[name, the query prefix, which fixture]` — `vacuous` reaches the far-driven walk. */
  const CASES: ReadonlyArray<readonly [string, string, 'labelled' | 'vacuous']> = [
    ['one column', 'MATCH (n:L) RETURN n.k AS k OFFSET ', 'labelled'],
    ['two columns', 'MATCH (n:L) RETURN n.k AS k, n.n AS t OFFSET ', 'labelled'],
    ['an expression column', 'MATCH (n:L) RETURN n.k + 1 AS k, n.s AS s OFFSET ', 'labelled'],
    ['a clause WHERE', 'MATCH (n:L) WHERE n.n > 110 RETURN n.k AS k OFFSET ', 'labelled'],
    ['an inline property', 'MATCH (n:L {k: 2}) RETURN n.n AS t OFFSET ', 'labelled'],
    // --- the hop rung (item 1776's second half) ---------------------------------------------
    //
    // ⚠️ THE FAR-READ HOP IS THE ONE THAT NEEDED THE WALK FORCED. Its rung chooses between a
    // start-driven and a far-driven walk PER CALL, from the start label's vacuity and the fan-in,
    // and the far-driven walk reorders rows deliberately — so slicing whichever walk happened to
    // be chosen would have returned different ROWS, graph-dependently. `hopOrderPlan` forces the
    // start-driven walk for a paged hop, whose order `forceStartDriven`'s doc measures as the
    // general path's. These rows are what pins that: without the force they fail.
    ['a hop reading the FAR end', 'MATCH (a:L)-[:R]->(b) RETURN b.k AS k OFFSET ', 'vacuous'],
    ['a hop reading the START end', 'MATCH (a:L)-[:R]->(b) RETURN a.k AS k OFFSET ', 'vacuous'],
    [
      'a hop reading BOTH ends',
      'MATCH (a:L)-[:R]->(b) RETURN a.k AS s, b.k AS f OFFSET ',
      'vacuous',
    ],
    [
      'a hop with a clause WHERE',
      'MATCH (a:L)-[:R]->(b) WHERE b.n > 108 RETURN b.k AS k OFFSET ',
      'vacuous',
    ],
  ];

  /**
   * ⚠️ THE ORACLE IS AN ABSOLUTE ROW LIST, NOT ANOTHER ROUTE, AND ITEM 1778 IS WHY.
   *
   * Items 1776/1777 compared the rung's rows against the general path's by reaching the general
   * path through the parameterized `OFFSET $s` spelling, which declined the rung on purpose. Item
   * 1778 then gave that spelling the rung too — closing a 7.3x gap between two spellings of one
   * query — and with it went the last general-path spelling of this shape, so that comparison
   * became the rung against itself. Rather than keep a slower route alive to serve as a test
   * fixture, the expectation is now ENUMERATED FROM THE GRAPH: `EXPECTED` below states the rows and
   * their order outright, and the page is that list sliced.
   *
   * It is the stronger assertion of the two. A route oracle only says two paths agree; this says
   * WHICH rows, in WHICH order, so it cannot be satisfied by both routes drifting together — and it
   * is what `count-shortcut.test.ts` and its siblings already do ("the shortcut's ANSWER against an
   * independent enumeration"). The order it pins is the one both engines produce for the unpaged
   * query, which `skip-only-page-parity.ts` reads against native directly.
   *
   * The hop rows are the ones that need it most: their expected order is the START-DRIVEN one —
   * start vertices in insertion order, each followed by its out-edges — which is the order
   * `hopOrderPlan` forces for a paged hop and NOT the order the unpaged far-driven walk produces.
   */
  const V = Array.from({ length: 24 }, (_, i) => ({ k: i % 5, n: 100 - i, s: `s${i}` }));
  /** The hop fixture's one out-edge per vertex: `i -> (i * 7 + 3) % 24`. */
  const FAR = (i: number): number => (i * 7 + 3) % 24;
  const EXPECTED: Record<string, readonly Row[]> = {
    'one column': V.map((v) => ({ k: v.k })),
    'two columns': V.map((v) => ({ k: v.k, t: v.n })),
    'an expression column': V.map((v) => ({ k: v.k + 1, s: v.s })),
    'a clause WHERE': V.filter((v) => v.n > 110).map((v) => ({ k: v.k })),
    'an inline property': V.filter((v) => v.k === 2).map((v) => ({ t: v.n })),
    'a hop reading the FAR end': V.map((_, i) => ({ k: V[FAR(i)].k })),
    'a hop reading the START end': V.map((v) => ({ k: v.k })),
    'a hop reading BOTH ends': V.map((v, i) => ({ s: v.k, f: V[FAR(i)].k })),
    'a hop with a clause WHERE': V.map((_, i) => V[FAR(i)])
      .filter((far) => far.n > 108)
      .map((far) => ({ k: far.k })),
  };

  for (const [name, prefix, fixture] of CASES) {
    const want = EXPECTED[name];

    // The UNPAGED query must already produce that list, or every paged row below is testing a
    // different graph than the comment claims. One assertion per case, before the pages.
    it(`${name}, unpaged — the enumerated rows, in the enumerated order`, () => {
      const g = fixture === 'vacuous' ? buildVacuous() : build();
      const unpaged = query(g, prefix.replace(/ OFFSET $/, ''));

      // ⚠️ THE HOP's UNPAGED SHAPE IS NOT START-DRIVEN, so only its MULTISET is pinned here — the
      // paged rows below are what pin the forced order. `order-is-unspecified` is exactly this:
      // the unpaged walk choice is the engine's, and it is the PAGE that must be sliceable.
      if (fixture === 'vacuous') {
        expect([...unpaged].map((r) => JSON.stringify(r)).sort()).toEqual(
          [...want].map((r) => JSON.stringify(r)).sort(),
        );
      } else {
        expect(unpaged).toEqual([...want]);
      }
    });

    for (const skip of [1, 7, 23]) {
      it(`${name}, OFFSET ${skip} — the enumerated rows, sliced, in both spellings`, () => {
        const g = fixture === 'vacuous' ? buildVacuous() : build();

        expect(query(g, `${prefix}${skip}`)).toEqual(want.slice(skip));
        // ⚠️ AND THE TWO SPELLINGS MUST AGREE, which is the invariant item 1778 exists to restore:
        // a literal and a parameterized bound are one query, so they take one route and cost the
        // same. Before 1778 the parameterized one was 7.3x slower by construction.
        expect(query(g, `${prefix}$s`, { s: skip })).toEqual(want.slice(skip));
      });
    }
  }

  it('a skip past the end returns no rows, in both spellings', () => {
    const g = build();

    expect(query(g, 'MATCH (n:L) RETURN n.k AS k OFFSET 99')).toEqual([]);
    expect(query(g, 'MATCH (n:L) RETURN n.k AS k OFFSET $s', { s: 99 })).toEqual([]);
  });

  /**
   * ⚠️ A PARAMETERIZED BOUND IS VALIDATED BEFORE ANY ROW IS PRODUCED, and that check is what makes
   * item 1778's route safe rather than merely faster: `rows.slice(-2)` would silently return the
   * LAST two rows, which is the wrong-answer shape this engine is least able to detect.
   * `noteCountParam` registers the bound's param at compile time and `compile.ts` validates it
   * eagerly — so the rung can never see a negative, fractional or non-numeric bound. Route-
   * independent, and pinned here because the rung now depends on it.
   */
  it('a negative, fractional or non-numeric parameterized bound raises, not slices', () => {
    const g = build();

    for (const s of [-2, 1.5, '3', null]) {
      expect(() => query(g, 'MATCH (n:L) RETURN n.k AS k OFFSET $s', { s })).toThrow();
    }

    expect(query(g, 'MATCH (n:L) RETURN n.k AS k OFFSET $s', { s: 0 })).toEqual([
      ...EXPECTED['one column'],
    ]);
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
