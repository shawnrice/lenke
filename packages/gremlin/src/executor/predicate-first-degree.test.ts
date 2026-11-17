/*
 * Item 2126 — `filteredHopCount` tests the predicate BEFORE computing the far degree.
 *
 * ⚠️⚠️ **THIS CHANGE IS ANSWER-EQUIVALENT BY CONSTRUCTION, SO NO TEST CAN SEE THE WIN.** It is a route
 * ordering: 32.4 → 17.9 ms at 50% selectivity and 31.1 → 5.5 at 4.4%, with a VACUOUS predicate correctly
 * flat (31.1 → 30.0) because one that rejects nothing cannot benefit. 🔑 What these tests are for is the
 * boundary the reorder MOVED — the `deg === 0` skip used to run before the predicate and now runs after
 * it — so each case below is a vertex where those two orders could disagree.
 *
 * 🔑 THE DISPLACED COMMENT said the old order "keeps the evaluated set identical", and that argument
 * exists to preserve FAULT parity with the edge-driven walk. Item 930 established no `matches` can fault
 * (a mutant removing the short-circuit SURVIVED, and two tests written to assert a throw both failed), so
 * with no faults possible the evaluated set is unobservable. ⚠️ The last test here is that claim's guard:
 * if a predicate ever CAN raise, it fails.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, count, gt, has, hasLabel, out, toArray, traversal } from '../index.js';

/** `P` vertices with the given ages; `edges` are `[fromIndex, toIndex]` pairs of type `KNOWS`. */
const graphOf = (
  ages: readonly (number | undefined)[],
  edges: readonly [number, number][],
  labels: readonly string[][] = [],
): Graph => {
  const g = new Graph();

  for (const [i, age] of ages.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: labels[i] ?? ['P'],
      properties: age === undefined ? {} : { age },
    });
  }

  for (const [i, [from, to]] of edges.entries()) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${from}`)!,
      to: g.getVertexById(`v${to}`)!,
      labels: ['KNOWS'],
      properties: {},
    });
  }

  return g;
};

const counted = (g: Graph, min: number): number => {
  const [n] = toArray(traversal(V(), out('KNOWS'), has('age', gt(min)), count()), g);

  return n as number;
};

describe('filteredHopCount: predicate before degree (item 2126)', () => {
  test('⚠️⚠️ a ZERO-DEGREE vertex whose predicate PASSES contributes nothing', () => {
    /*
     * 🔑 THE CASE THE REORDER MOVED. v2 passes `age > 10` but is nobody's target, so it is not a far
     * endpoint of this hop and must add 0. ⚠️ Under the old order the `deg === 0` skip caught it before
     * the predicate ran; now the predicate runs first and the `deg !== 0` guard catches it. Both answer
     * 1 — the single edge into v1, which also passes.
     */
    const g = graphOf([5, 50, 90], [[0, 1]]);

    expect(counted(g, 10)).toBe(1);
  });

  test('⚠️ a ZERO-DEGREE vertex whose predicate FAILS also contributes nothing', () => {
    // The complementary half: the guard must not let a failing vertex through either.
    const g = graphOf([5, 50, 1], [[0, 1]]);

    expect(counted(g, 10)).toBe(1);
  });

  test('⚠️ a graph where NO vertex has an in-edge counts zero, not every passing vertex', () => {
    /*
     * 🔑 The sharpest form: every vertex passes the predicate and none is a far endpoint. ⚠️ A reorder
     * that dropped the `deg !== 0` guard would answer 3 here — one per passing vertex — which is the
     * wrong answer the displaced skip existed to prevent.
     */
    const g = graphOf([50, 60, 70], []);

    expect(counted(g, 10)).toBe(0);
  });

  test('🔑 a vertex with SEVERAL in-edges contributes its whole degree, once', () => {
    // v2 is the target of three edges and passes, so the count is 3 — the degree, not 1 per vertex.
    const g = graphOf(
      [1, 1, 90],
      [
        [0, 2],
        [1, 2],
        [0, 2],
      ],
    );

    expect(counted(g, 10)).toBe(3);
  });

  test('⚠️ a MISSING property is not a pass — ISO/TinkerPop both filter it out', () => {
    /*
     * 🔑 `undefined` reaches `matches` as an absent value and `predCmp` returns `NaN`, so the comparison
     * is false. ⚠️ This is the mechanism the fault-parity argument rests on: a missing or incomparable
     * value is FILTERED, never thrown. v1 lacks `age` entirely and is the target of an edge.
     */
    const g = graphOf(
      [5, undefined, 90],
      [
        [0, 1],
        [0, 2],
      ],
    );

    expect(counted(g, 10)).toBe(1);
  });

  test('⚠️ a LABEL test still filters, and still composes with the degree guard', () => {
    /*
     * 🔑 `passesLabels` sits in the same group as the property chain and also now runs before the
     * degree. ⚠️ v1 is the target but is not a `Q`, so it is excluded; v2 is a `Q` and the target of
     * one edge.
     */
    const g = graphOf(
      [5, 50, 90],
      [
        [0, 1],
        [0, 2],
      ],
      [['P'], ['P'], ['P', 'Q']],
    );
    const [n] = toArray(
      traversal(V(), out('KNOWS'), hasLabel('Q'), has('age', gt(10)), count()),
      g,
    );

    expect(n).toBe(1);
  });

  test('⚠️⚠️ NO PREDICATE CAN RAISE — the fault-parity claim this reorder depends on', () => {
    /*
     * 🔑 THE REORDER IS ONLY SOUND BECAUSE OF THIS. Moving the predicate above the `deg === 0` skip
     * widens the EVALUATED SET to include zero-degree vertices, which is unobservable **iff** evaluating
     * a predicate cannot fault. ⚠️ So: a cross-type comparison on a vertex that is NOT a far endpoint.
     * Under the old order it was never evaluated; now it is. It must filter, not throw.
     *
     * If this test ever fails, the reorder is unsound and the `deg === 0` skip must go back above the
     * predicate — not the other way round.
     */
    const g = graphOf([5, 50], [[0, 1]]);

    g.addVertex({ id: 'vs', labels: ['P'], properties: { age: 'not a number' } });

    expect(() => counted(g, 10)).not.toThrow();
    expect(counted(g, 10)).toBe(1);
  });
});
