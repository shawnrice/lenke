/**
 * `outE(T).inV()` fuses to `out(T)` (item 1307) — the REWRITE, its guards, and the equivalence it
 * rests on.
 *
 * THREE KINDS OF ASSERTION, because the change has three kinds of failure.
 *
 * Fusing is ANSWER-EQUIVALENT where it applies, so a fusion that silently stops firing returns the
 * same rows the slow way and no answer test can see it. Item 1303 measured how blunt the weaker
 * instrument is — a route assertion that asked only "which detector fired" passed with the entire
 * rewrite disabled — so `fuseEdgeHop` is called DIRECTLY and the rewrite is asserted AS a rewrite:
 * the step list becomes shorter and holds `out` where it held `outE`, `inV`.
 *
 * Fusing where it is NOT sound is a wrong answer, and exactly one case makes it unsound: a plan
 * that can observe the traverser PATH, because the long spelling puts the EDGE in the path and
 * `out` does not. That is asserted as an answer, on `path()` itself.
 *
 * And the equivalence the whole item rests on is asserted on a fixture built to break it: PARALLEL
 * edges, a MULTI-LABEL edge, and a SELF-LOOP. Item 1306 is why that is not optional — there the
 * analogous-looking rewrite was unsound twice over (it raised where the filter did not, and it did
 * not dedupe), and only reading the source and measuring caught it.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  aggregate,
  as_,
  bothE,
  count,
  hasLabel,
  inE,
  in_,
  inV,
  otherV,
  out,
  outE,
  outV,
  path,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';
import { effectivePlan, fuseEdgeHop, toArray } from './index.js';

/**
 * A fixture built to break the equivalence if it can.
 *
 * `a->b` TWICE (parallel edges, so a per-edge walk and a degree sum can disagree), one edge
 * carrying TWO labels (`['T','S']`, where a type filter must still yield it once), and a SELF-LOOP
 * `a->a` (where the far end is the near end).
 */
const build = (): Graph => {
  const g = new Graph();

  for (const [id, labels] of [
    ['a', ['P']],
    ['b', ['P']],
    ['c', ['Q']],
  ] as ReadonlyArray<readonly [string, string[]]>) {
    g.addVertex({ id, labels, properties: { k: id } });
  }

  const v = (id: string) => g.verticesById.get(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e3', from: v('b'), to: v('c'), labels: ['T', 'S'], properties: {} });
  g.addEdge({ id: 'e4', from: v('a'), to: v('a'), labels: ['T'], properties: {} });

  return g;
};

const kinds = (steps: readonly { kind: string }[]): string[] => steps.map((s) => s.kind);

describe('the rewrite replaces the pair with one hop', () => {
  test('outE(T).inV() becomes out(T), carrying the labels', () => {
    const fused = fuseEdgeHop(traversal(V(), outE('T'), inV(), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'out', 'count']);
    expect((fused.steps[1] as { labels: readonly string[] }).labels).toEqual(['T']);
  });

  test('inE(T).outV() becomes in(T)', () => {
    const fused = fuseEdgeHop(traversal(V(), inE('T'), outV(), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'in', 'count']);
    expect((fused.steps[1] as { labels: readonly string[] }).labels).toEqual(['T']);
  });

  test('the UNTYPED pair fuses too, keeping the empty label list', () => {
    const fused = fuseEdgeHop(traversal(V(), outE(), inV(), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'out', 'count']);
    expect((fused.steps[1] as { labels: readonly string[] }).labels).toEqual([]);
  });

  test('two pairs in one plan both fuse', () => {
    const fused = fuseEdgeHop(traversal(V(), outE('T'), inV(), outE('T'), inV(), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'out', 'out', 'count']);
  });

  test('a plan with no pair is returned UNCHANGED, by identity', () => {
    const plan = traversal(V(), out('T'), count());

    // Identity, not just equality: the rewrite must not allocate a new plan for every traversal
    // that does not contain the pair.
    expect(fuseEdgeHop(plan)).toBe(plan);
  });
});

describe('the rewrite is WIRED, and gated on path tracking', () => {
  // Asserting `fuseEdgeHop` alone leaves alive the mutant that simply stops CALLING it: the suite
  // then answers identically by the slow walk. `effectivePlan` is the composition the executor
  // actually uses, so these two assertions cover the wiring AND its one guard.
  test('effectivePlan fuses when nothing reads the path', () => {
    const fused = effectivePlan(traversal(V(), outE('T'), inV(), count()), build(), false);

    expect(kinds(fused.steps)).toEqual(['V', 'out', 'count']);
  });

  test('effectivePlan does NOT fuse when the path is tracked', () => {
    const plan = traversal(V(), outE('T'), inV(), count());

    // The long hop puts the EDGE in the path and the fused one does not, so a path-reading plan
    // must keep the spelling it was given. This is the guard that makes the whole item sound.
    expect(kinds(effectivePlan(plan, build(), true).steps)).toEqual(['V', 'outE', 'inV', 'count']);
  });
});

describe('ADJACENCY is a guard, not an accident', () => {
  // Any step between the two means the EDGE is observable for some reason other than the path, and
  // a fused hop would no longer have an edge to give it.
  const UNFUSED: ReadonlyArray<readonly [string, ReturnType<typeof traversal>]> = [
    ['an as_ label on the edge', traversal(V(), outE('T'), as_('e'), inV(), count())],
    ['an aggregate of the edge', traversal(V(), outE('T'), aggregate('x'), inV(), count())],
    ['a filter on the edge', traversal(V(), outE('T'), hasLabel('T'), inV(), count())],
    ['a bare outE with no inV', traversal(V(), outE('T'), count())],
    ['inV without a preceding outE', traversal(V(), out('T'), count())],
    // The MIRROR MISMATCH: `outE` pairs with `inV`, never with `outV` — fusing this would take the
    // wrong end of the edge and answer a different question.
    ['outE followed by outV', traversal(V(), outE('T'), outV(), count())],
    ['inE followed by inV', traversal(V(), inE('T'), inV(), count())],
    // `bothE().otherV()` is deliberately out of scope: `otherV` is path-dependent, so the caller's
    // guard already excludes it, and folding it to `both(T)` needs its own argument.
    ['bothE followed by otherV', traversal(V(), bothE('T'), otherV(), count())],
  ];

  for (const [name, plan] of UNFUSED) {
    test(`${name} does not fuse`, () => {
      expect(kinds(fuseEdgeHop(plan).steps)).toEqual(kinds(plan.steps));
    });
  }
});

describe('the equivalence the rewrite rests on', () => {
  const ids = (rows: readonly unknown[]): unknown[] =>
    rows.map((r) => (typeof r === 'object' && r !== null ? (r as { id: unknown }).id : r));

  // Each pair is the same walk in two spellings. Parallel edges, the multi-label edge and the
  // self-loop are all in play, and the assertion is the SEQUENCE, not just the multiset — a
  // reordering would be permitted by this repo's policy but is worth knowing about.
  const PAIRS: ReadonlyArray<
    readonly [string, ReturnType<typeof traversal>, ReturnType<typeof traversal>]
  > = [
    ['count', traversal(V(), out('T'), count()), traversal(V(), outE('T'), inV(), count())],
    ['elements', traversal(V(), out('T')), traversal(V(), outE('T'), inV())],
    [
      'values',
      traversal(V(), out('T'), values('k')),
      traversal(V(), outE('T'), inV(), values('k')),
    ],
    ['untyped', traversal(V(), out()), traversal(V(), outE(), inV())],
    ['incoming', traversal(V(), in_('T')), traversal(V(), inE('T'), outV())],
    [
      'a far-end label after the hop',
      traversal(V(), out('T'), hasLabel('Q'), count()),
      traversal(V(), outE('T'), inV(), hasLabel('Q'), count()),
    ],
  ];

  for (const [name, short, long] of PAIRS) {
    test(`${name} agrees`, () => {
      const g = build();

      expect(ids(toArray(long, g))).toEqual(ids(toArray(short, g)));
    });
  }

  test('the multi-label edge is yielded ONCE by a type-filtered hop', () => {
    const g = build();

    // `e3` carries both `T` and `S`. Walking `T` must reach `c` exactly once.
    expect(Number(toArray(traversal(V(), outE('T'), inV(), count()), g)[0])).toBe(4);
    expect(Number(toArray(traversal(V(), out('T'), count()), g)[0])).toBe(4);
  });
});

describe('a plan that reads the PATH keeps the spelling it was given', () => {
  test('path() DIFFERS between the spellings, which is why the guard exists', () => {
    const g = build();
    const shortPaths = toArray(traversal(V(), out('T'), path()), g);
    const longPaths = toArray(traversal(V(), outE('T'), inV(), path()), g);

    // The long spelling's path holds THREE elements (vertex, edge, vertex) where the short one
    // holds two. If these ever compare equal, the fusion has been applied under path tracking and
    // the guard is gone.
    expect((longPaths[0] as unknown[]).length).toBe(3);
    expect((shortPaths[0] as unknown[]).length).toBe(2);
    expect(longPaths).not.toEqual(shortPaths);
  });

  test('the fused answer is still correct when the path is NOT read', () => {
    const g = build();

    // The same traversal without `path()` is free to fuse, and must answer what it always did.
    expect(Number(toArray(traversal(V(), outE('T'), inV(), count()), g)[0])).toBe(4);
  });
});
