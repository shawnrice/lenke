import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, both, out, run, toArray, traversal, values } from './index.js';

/**
 * THE UNTYPED HOP'S HAND WALK (item 2454), and the case it must not get wrong.
 *
 * `out()` means "every edge type". Item 2454 admitted it into the multi-type branch of
 * `hop-values.ts` — "every bucket" is "these buckets" with a different fill — which took
 * `out().values(k)` from 253 ms to 123 at 200,000 vertices and closed `spelling:gremlin`'s
 * `out()`-against-`out(T,U)` group from 2.4x to ~1.2x.
 *
 * WHY THESE TESTS EXIST RATHER THAN THE SUITE'S EXISTING COVERAGE. A route change is
 * ANSWER-EQUIVALENT on every shape that does not hit the stale case: the 2,863-test gremlin suite,
 * all seven byte-identity fuzzers and `fuzz gremlin` pass with this arm present OR absent, because
 * both routes answer correctly on a single-label graph. The only thing that can break is a
 * MULTI-LABEL edge, which sits in two of the buckets the untyped fill now walks.
 *
 * AND DEPTH 1 ALONE WOULD NOT HAVE CAUGHT IT. The index records a prior incident on exactly this
 * shape: "a 146-case sweep found 13 divergences, EVERY ONE an `out()` at depth 2 or more — zero
 * labels means 'every bucket', so a multi-type edge is visited once per label it carries". A
 * one-hop test can pass while the second hop multiplies the duplication, so every case below runs
 * at BOTH depths, and the fixtures differ in exactly one bit: whether an edge carries two labels.
 */
const build = (multiLabel: boolean): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 3 } });

  // a -> b carries BOTH labels in the multi-label fixture and only `T` otherwise. It is the one bit
  // that differs, so a duplicated row shows up as a changed multiset rather than a changed count.
  g.addEdge({
    id: 'e1',
    from: a,
    to: b,
    labels: multiLabel ? ['T', 'U'] : ['T'],
    properties: {},
  });
  // b -> c gives the second hop somewhere to go, so a depth-2 duplication is observable.
  g.addEdge({ id: 'e2', from: b, to: c, labels: ['T'], properties: {} });

  return g;
};

const sorted = (xs: readonly unknown[]): unknown[] => [...xs].sort();

describe('out() with no labels emits a multi-label edge exactly once', () => {
  test('depth 1: the multi-label fixture matches the single-label one', () => {
    // `a -> b` is ONE edge either way, so `out()` from every vertex yields b and c once each.
    const expected = [2, 3];

    expect(sorted(toArray(traversal(V(), out(), values('k')), build(false)))).toEqual(expected);
    expect(sorted(toArray(traversal(V(), out(), values('k')), build(true)))).toEqual(expected);
  });

  test('DEPTH 2: the depth the prior 13 divergences all shared', () => {
    // a -> b -> c and b -> c -> (nothing). Only `a` has a two-hop path, so exactly one row.
    const expected = [3];

    expect(sorted(toArray(traversal(V(), out(), out(), values('k')), build(false)))).toEqual(
      expected,
    );
    expect(sorted(toArray(traversal(V(), out(), out(), values('k')), build(true)))).toEqual(
      expected,
    );
  });

  test('the LAZY and EAGER halves agree, because the branch has two copies of the loop', () => {
    // `toArray` reads `drain()`; `run` walks the iterator. The untyped fill was patched in BOTH,
    // and a fix applied to one copy only would show up here and nowhere else.
    for (const multi of [false, true]) {
      const g = build(multi);
      const plan = traversal(V(), out(), values('k'));

      expect(sorted([...run(plan, g)])).toEqual(sorted(toArray(plan, g)));
    }

    const g = build(true);
    const deep = traversal(V(), out(), out(), values('k'));

    expect(sorted([...run(deep, g)])).toEqual(sorted(toArray(deep, g)));
  });

  test('out() equals out(every label), which is the equivalence the fast arm claims', () => {
    // Naming every label in the graph is naming none. This is the property `spelling:gremlin`'s
    // group measures for COST; here it is asserted for the ANSWER, on the fixture that can break it.
    for (const multi of [false, true]) {
      const g = build(multi);

      expect(sorted(toArray(traversal(V(), out(), values('k')), g))).toEqual(
        sorted(toArray(traversal(V(), out('T', 'U'), values('k')), g)),
      );
    }
  });

  /*
   * TWO CASES ADDED AFTER MUTANTS SURVIVED, which is the whole reason the battery was run.
   *
   * The first cut of this file caught `drop-dedupe` and MISSED two others:
   *
   *   fill-first-bucket-only  push only the FIRST bucket    5 pass / 0 fail   SURVIVED
   *   admit-both              let `kind === 'both'` in      5 pass / 0 fail   SURVIVED
   *
   * Both for the same reason — the fixture could not express the defect. Every vertex above has its
   * edges in ONE bucket (the multi-label edge is in two, but it is the SAME edge), so walking only
   * the first bucket loses nothing; and no test used `both()`, so admitting it was invisible.
   */
  test('a vertex with DIFFERENT edges in different buckets yields all of them', () => {
    // `fill-first-bucket-only` lives here: `a` has one `T` edge and one `U` edge, to DIFFERENT
    // vertices, so a fill that stops after the first bucket drops a row. The multi-label fixtures
    // above cannot catch that, because their two buckets hold the same edge.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const viaT = g.addVertex({ id: 'viaT', labels: ['P'], properties: { k: 7 } });
    const viaU = g.addVertex({ id: 'viaU', labels: ['P'], properties: { k: 8 } });

    g.addEdge({ id: 't', from: a, to: viaT, labels: ['T'], properties: {} });
    g.addEdge({ id: 'u', from: a, to: viaU, labels: ['U'], properties: {} });

    expect(sorted(toArray(traversal(V(), out(), values('k')), g))).toEqual([7, 8]);
    // And the equivalence still holds on the shape that exercises both buckets.
    expect(sorted(toArray(traversal(V(), out(), values('k')), g))).toEqual(
      sorted(toArray(traversal(V(), out('T', 'U'), values('k')), g)),
    );
  });

  test('both() at zero labels is NOT taken by this arm, and answers both directions', () => {
    // `admit-both` lives here. The branch sets `forward = kind === 'out'`, so admitting `both`
    // would walk `adjTo` ONLY and silently lose the out-direction. `both()` must keep the general
    // path, which interleaves to TinkerPop's contract.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['T'], properties: {} });

    // `a` reaches b outward, `b` reaches a inward: one row each, both directions present.
    expect(sorted(toArray(traversal(V(), both(), values('k')), g))).toEqual([1, 2]);
  });

  test('a vertex whose only edge is multi-label still yields ONE row', () => {
    // The narrowest form of the duplication: one vertex, one edge, two labels. If the earlier-buckets
    // test is removed this returns two rows, and no count-based assertion elsewhere would notice.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 9 } });

    g.addEdge({ id: 'only', from: a, to: b, labels: ['T', 'U'], properties: {} });

    expect(toArray(traversal(V(), out(), values('k')), g)).toEqual([9]);
  });
});
