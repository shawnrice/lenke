/**
 * `run`'s memo of a plan's STATIC-CHECK verdict (item 1648): the pass is remembered, a failure never
 * is.
 *
 * ⚠️ WHY A SEPARATE FILE FROM `plan-may-fault.test.ts`, WHICH ALREADY COVERS EVERY THROW SITE. That
 * suite calls `toArray` exactly ONCE per faulting plan, so it cannot see the failure this cache can
 * introduce: mark the plan checked BEFORE the checks run, and every invalid plan throws on its first
 * call and then SILENTLY SUCCEEDS on every call after. One `toArray` per plan is blind to that by
 * construction, and the engine's own suite would stay green. So the tests here are the same plans,
 * called REPEATEDLY.
 *
 * The plan list is deliberately the same shape as that file's — one case per throw site in
 * `checkStep`, plus the nested cases `assertFrontierTypes` recurses for — because the question is
 * not "does this plan raise" (that file owns it) but "does it still raise the SECOND time".
 */
import { describe, expect, it, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { EFF_CHECKED } from './ast.js';
import type { Plan } from './ast.js';
import { fuseLocal, toArray } from './executor.js';
import {
  E,
  V,
  bothV,
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
  traversal,
  union,
  values,
} from './index.js';

const graph = new Graph();

for (let v = 0; v < 6; v += 1) {
  graph.addVertex({ id: `v${v}`, labels: ['P'], properties: { k: v } });
}

for (let e = 0; e < 5; e += 1) {
  graph.addEdge({
    id: `e${e}`,
    labels: ['E'],
    properties: { w: e },
    from: graph.getVertexById(`v${e}`)!,
    to: graph.getVertexById(`v${e + 1}`)!,
  });
}

/** One per throw site in `checkStep`, mirroring `plan-may-fault.test.ts`. */
const FAULTING: readonly (readonly [string, Plan])[] = [
  ['an element step on a path frontier', traversal(V(), path(), out('E'))],
  ['a projection on a path frontier', traversal(V(), path(), values('k'))],
  ['a numeric reduce on a path frontier', traversal(V(), path(), sum())],
  ['a vertex move with no edge', traversal(V(), inV())],
  ['bothV with no edge', traversal(V(), bothV())],
  ['otherV off a bare edge frontier', traversal(E(), otherV())],
  ['a hop off an edge frontier', traversal(V(), outE('E'), out('E'))],
  ['a numeric reduce over elements', traversal(V(), sum())],
  ['order over elements by a bad key', traversal(V(), order())],
  // The nested cases: `assertFrontierTypes` recurses into branch arms, so these reach the walk
  // through a sub-plan rather than a top-level step.
  ['a vertex move inside union', traversal(V(), union(traversal(inV())))],
  [
    'a vertex move inside coalesce',
    traversal(V(), coalesce(traversal(inV()), traversal(out('E')))),
  ],
];

describe('⚠️ the same invalid plan throws EVERY time', () => {
  for (const [label, plan] of FAULTING) {
    it(`keeps raising for ${label}`, () => {
      expect(() => toArray(plan, graph), `${label}: call 1`).toThrow();
      expect(() => toArray(plan, graph), `${label}: call 2`).toThrow();
      expect(() => toArray(plan, graph), `${label}: call 3`).toThrow();
      // And it is never marked, which is the mechanism rather than the symptom.
      expect(plan[EFF_CHECKED], `${label}: must never be marked checked`).toBeUndefined();
    });
  }

  /**
   * ⚠️ AND THE SAME PLAN OBJECT AFTER A SUCCESSFUL RUN OF A DIFFERENT ONE, so a shared flag (a
   * module-level boolean rather than a per-plan slot) cannot pass this file either.
   */
  it('a valid run in between does not clear the fault', () => {
    const valid = traversal(V(), count());
    const invalid = traversal(V(), inV());

    expect(() => toArray(invalid, graph)).toThrow();
    expect(toArray(valid, graph)).toEqual([6]);
    expect(() => toArray(invalid, graph)).toThrow();
    expect(toArray(valid, graph)).toEqual([6]);
    expect(() => toArray(invalid, graph)).toThrow();
  });
});

describe('a passing plan is checked once', () => {
  test('the slot is set after the first run, and the answer does not change', () => {
    const plan = traversal(V(), has('k', gt(2)), count());

    expect(plan[EFF_CHECKED]).toBeUndefined();
    expect(toArray(plan, graph)).toEqual([3]);
    expect(plan[EFF_CHECKED]).toBe(true);
    expect(toArray(plan, graph)).toEqual([3]);
    expect(toArray(plan, graph)).toEqual([3]);
  });

  test('a plan that cannot fault at all is still marked, so the gate is skipped too', () => {
    const plan = traversal(V(), count());

    expect(plan.mayFault).toBe(false);
    expect(toArray(plan, graph)).toEqual([6]);
    expect(plan[EFF_CHECKED]).toBe(true);
  });

  /**
   * ⚠️ THE RESET IN `rewritten` MATTERS MORE FOR THIS SLOT THAN FOR THE PREFIX. A rewrite can
   * INTRODUCE a faulting kind — `fuseLocal` inlines a sub-plan's steps into the top level, which is
   * exactly why `mayFault` is recomputed there — so a verdict inherited through `...plan` would skip
   * a check that should raise.
   */
  test('a pass called on an already-checked plan does not propagate the verdict', () => {
    const plan = traversal(V(), local(out('E')), count());

    expect(toArray(plan, graph)).toEqual([5]);
    expect(plan[EFF_CHECKED]).toBe(true);

    const inlined = fuseLocal(plan);

    expect(inlined).not.toBe(plan);
    expect(inlined[EFF_CHECKED]).toBeUndefined();
  });

  test('the slot stays invisible to JSON', () => {
    const plan = traversal(V(), count());

    toArray(plan, graph);

    // The JSON round-trip is a public API (`serialize.ts`); see `effective-plan-cache.test.ts`.
    // eslint-disable-next-line unicorn/prefer-structured-clone -- see above
    const round = JSON.parse(JSON.stringify(plan)) as Plan;

    expect(Object.keys(round)).toEqual(['steps', 'readsPath', 'kinds', 'mayFault']);
  });
});
