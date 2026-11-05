/**
 * ITEM 1507 — `Plan.mayFault` lets `assertFrontierTypes` skip `checkSteps`' whole frontier walk for
 * a plan that contains no step `checkStep` can raise for. That walk was **27.5%** of a 123 ns
 * reused-plan call; gating it took `V().count()` from 124 to 77 ns (1.61x).
 *
 * ⚠️ BEING WRONG HERE LOSES A FAULT, NOT AN ANSWER. Every other gate in items 1504-1506 guarded an
 * answer-equivalent rewrite, where a mistake costs speed. This one guards VALIDATION: if `mayFault`
 * is wrongly false, a plan that TinkerPop and the native engine both reject will happily run and
 * return rows. So this file is about the faults still firing, and it checks the two ways the flag
 * can be wrong:
 *
 *  1. a kind missing from `MAY_FAULT_KINDS` — the flag is false for a plan that can raise;
 *  2. the flag not PROPAGATING into sub-plans — `assertFrontierTypes` recurses into union/choose
 *     arms, so `V().union(inV())` must still be checked. I nearly shipped exactly that hole: the
 *     first version computed the flag over top-level steps only, like the `kinds` mask, which is
 *     the right rule for the fusion gates and the wrong one here.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  E,
  V,
  bothV,
  choose,
  coalesce,
  count,
  gt,
  has,
  inV,
  local,
  order,
  otherV,
  out,
  outE,
  path,
  sum,
  toArray,
  traversal,
  union,
  values,
} from './index.js';

const graph = new Graph();

for (let i = 0; i < 6; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
}

for (let e = 0; e < 5; e += 1) {
  graph.addEdge({
    id: `e${e}`,
    labels: ['E'],
    from: graph.getVertexById(`v${e}`)!,
    to: graph.getVertexById(`v${e + 1}`)!,
  });
}

describe('⚠️ every fault checkStep raises still raises', () => {
  // One case per throw site in `checkStep`, because the gate is derived from exactly those seven.
  for (const [label, plan] of [
    ['an element step on a path frontier', traversal(V(), path(), out('E'))],
    ['a projection on a path frontier', traversal(V(), path(), values('k'))],
    ['a numeric reduce on a path frontier', traversal(V(), path(), sum())],
    ['a vertex move with no edge', traversal(V(), inV())],
    ['bothV with no edge', traversal(V(), bothV())],
    ['otherV off a bare edge frontier', traversal(E(), otherV())],
    ['a hop off an edge frontier', traversal(V(), outE('E'), out('E'))],
    ['a numeric reduce over elements', traversal(V(), sum())],
    ['order over elements by a bad key', traversal(V(), order())],
  ] as const) {
    it(`raises for ${label}`, () => {
      expect(plan.mayFault, `${label}: mayFault must be true`).toBe(true);
      expect(() => toArray(plan, graph), label).toThrow();
    });
  }
});

describe('⚠️ a fault NESTED in a sub-plan still raises — the hole I nearly shipped', () => {
  // `assertFrontierTypes` recurses into branch arms, so the flag must propagate inward. A
  // top-level-only flag (the `kinds` mask's rule) would skip the check and LOSE every one of these.
  // ⚠️ THE FLAG IS WHAT THIS GUARDS, and for two of these shapes it is ALL that can be asserted.
  // `local(inV())` and `union(local(inV()))` do NOT raise — `local`'s arm starts from an `unknown`
  // frontier, and the engine's rule is that an unknown frontier never faults (a branch output MIGHT
  // be a vertex). That is pre-existing behaviour, not something the gate changed: when `mayFault`
  // is true the walk runs exactly the code it ran before, so a non-throw at `mayFault: true` is the
  // engine's own answer. My first version asserted a throw for both and failed — the expectation
  // was wrong, not the engine.
  //
  // So: the flag must propagate for ALL of them (that is the hole), and the throw is asserted only
  // where the frontier is actually known.
  for (const [label, plan, raises] of [
    ['inside union', traversal(V(), union(traversal(inV()))), true],
    ['inside coalesce', traversal(V(), coalesce(traversal(inV()), traversal(out('E')))), true],
    [
      'inside a choose branch',
      traversal(V(), choose(traversal(has('k', gt(1))), traversal(inV()))),
      true,
    ],
    ['inside local (unknown frontier, no raise)', traversal(V(), local(traversal(inV()))), false],
    [
      'TWO levels deep (unknown frontier, no raise)',
      traversal(V(), union(traversal(local(traversal(inV()))))),
      false,
    ],
  ] as const) {
    it(`propagates the flag for a vertex move ${label}`, () => {
      expect(plan.mayFault, `${label}: mayFault must propagate out of the sub-plan`).toBe(true);

      if (raises) {
        expect(() => toArray(plan, graph), label).toThrow();
      } else {
        expect(() => toArray(plan, graph), label).not.toThrow();
      }
    });
  }

  it('a path step nested in a sub-plan sets the flag too', () => {
    expect(traversal(V(), union(traversal(path()))).mayFault).toBe(true);
    expect(traversal(V(), local(traversal(path()))).mayFault).toBe(true);
  });
});

describe('the flag is false only for plans that genuinely cannot fault', () => {
  for (const [label, plan] of [
    ['a bare count', traversal(V(), count())],
    ['a filtered count', traversal(V(), has('k', gt(3)), count())],
    ['two filters', traversal(V(), has('k', gt(1)), has('k', gt(2)), count())],
  ] as const) {
    it(`${label} has mayFault false and still answers`, () => {
      expect(plan.mayFault, label).toBe(false);
      expect(() => toArray(plan, graph), label).not.toThrow();
    });
  }

  it('⚠️ a hop DOES set the flag — `out` is in the gate set', () => {
    // `out` can raise off an edge or scalar frontier, so a hop cannot skip the walk. This is why
    // the `hop` row of the probe barely moved (162 → 161 ns) while `count` went 124 → 77.
    expect(traversal(V(), out('E'), count()).mayFault).toBe(true);
    expect(toArray(traversal(V(), out('E'), count()), graph)).toEqual([5]);
  });

  it('the flag is monotone across appends', () => {
    expect(traversal(V(), count()).mayFault).toBe(false);
    expect(traversal(V(), inV()).mayFault).toBe(true);
    // Appending a clean step after a faulting one keeps it set.
    expect(traversal(V(), inV(), count()).mayFault).toBe(true);
  });
});

describe('the gated plans still answer correctly', () => {
  it('a count that skips the walk answers as it did', () => {
    expect(toArray(traversal(V(), count()), graph)).toEqual([6]);
    expect(toArray(traversal(V(), has('k', gt(3)), count()), graph)).toEqual([2]);
  });
});
