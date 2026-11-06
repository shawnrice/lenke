/**
 * A VACUOUS `hasLabel` with SEVERAL labels is dropped (item 1547).
 *
 * `hasLabel` is ANY-match, so a disjunction one of whose labels is on every element removes
 * nothing. `dropVacuousLabels` required `labels.length === 1` and so left those filters in the
 * plan, which then took the general route where the dropped form is closed-form. Measured at
 * 200,000 vertices, one arm per process:
 *
 * ```text
 *   V().hasLabel(P, Q).count()            1.287 -> 0.007 ms     184x
 *   V().hasLabel(P, Q).out(E).count()     9.075 -> 0.010        908x
 * ```
 *
 * ⚠️ A DROP IS ANSWER-EQUIVALENT WHEN IT IS CORRECT, which is why these tests read the PLAN. Item
 * 1304's and item 1382's vacuous-label work is the precedent, and `perf-gate-needs-its-own-test`
 * is the rule: without a route assertion every mutant that disables the drop passes every answer
 * test in the package.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { effectivePlan } from './executor/index.js';
import { E, V, count, hasLabel, out, toArray, traversal } from './index.js';

/** `P` on every vertex, `Q` on half, `R` on none; `T` on every edge, `U` on one. */
const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < 6; i += 1) {
    vs.push({
      v: g.addVertex({
        id: `v${i}`,
        labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
        properties: { n: i },
      }),
      i,
    });
  }

  for (let i = 0; i < 6; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i].v,
      to: vs[(i + 1) % 6].v,
      labels: i === 0 ? ['T', 'U'] : ['T'],
      properties: { w: i },
    });
  }

  return g;
};

const kinds = (g: Graph, t: Parameters<typeof toArray>[0]): string[] =>
  effectivePlan(t as never, g, false).steps.map((s) => s.kind);

describe('item 1547 — a vacuous MULTI-label hasLabel is dropped', () => {
  test('a disjunction containing an every-element label is DROPPED', () => {
    const g = build();

    // `P` is on all six, so `hasLabel(P, Q)` matches all six and removes nothing.
    expect(kinds(g, traversal(V(), hasLabel('P', 'Q'), count()))).toEqual(['V', 'count']);
    expect(kinds(g, traversal(V(), hasLabel('Q', 'P'), count()))).toEqual(['V', 'count']);
    // Three labels, the universal one last.
    expect(kinds(g, traversal(V(), hasLabel('R', 'Q', 'P'), count()))).toEqual(['V', 'count']);
  });

  test('CONTROL: a NON-vacuous disjunction is KEPT', () => {
    const g = build();

    // `Q` is on half and `R` on none, so this removes rows and must stay.
    expect(kinds(g, traversal(V(), hasLabel('Q', 'R'), count()))).toEqual([
      'V',
      'hasLabel',
      'count',
    ]);
    expect(kinds(g, traversal(V(), hasLabel('Q'), count()))).toEqual(['V', 'hasLabel', 'count']);
  });

  test('the ANSWERS are unchanged either way', () => {
    const g = build();

    expect(toArray(traversal(V(), hasLabel('P', 'Q'), count()), g)).toEqual([6]);
    expect(toArray(traversal(V(), hasLabel('P'), count()), g)).toEqual([6]);
    expect(toArray(traversal(V(), hasLabel('Q', 'R'), count()), g)).toEqual([3]);
    expect(toArray(traversal(V(), hasLabel('P', 'Q'), out('T'), count()), g)).toEqual([6]);
    expect(toArray(traversal(V(), hasLabel('Q', 'R'), out('T'), count()), g)).toEqual([3]);
  });

  test('the EDGE source works the same way', () => {
    const g = build();

    // `T` is on every edge.
    expect(kinds(g, traversal(E(), hasLabel('T', 'U'), count()))).toEqual(['E', 'count']);
    expect(toArray(traversal(E(), hasLabel('T', 'U'), count()), g)).toEqual([6]);
    // `U` is on one edge only, so alone it is not vacuous.
    expect(kinds(g, traversal(E(), hasLabel('U'), count()))).toEqual(['E', 'hasLabel', 'count']);
    expect(toArray(traversal(E(), hasLabel('U'), count()), g)).toEqual([1]);
  });

  test('⚠️ the test is SUFFICIENT, not COMPLETE, and the answer is still right', () => {
    // Two labels that UNION to every vertex while neither bucket covers it alone. Deciding this
    // needs a real union, which this pass will not pay for on every query — so the filter is KEPT
    // and the answer comes from applying it, which is correct if slower.
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['X'], properties: {} });
    g.addVertex({ id: 'b', labels: ['Y'], properties: {} });

    expect(kinds(g, traversal(V(), hasLabel('X', 'Y'), count()))).toEqual([
      'V',
      'hasLabel',
      'count',
    ]);
    expect(toArray(traversal(V(), hasLabel('X', 'Y'), count()), g)).toEqual([2]);
  });

  test('CONTROL: a hasLabel AFTER a hop is never dropped, vacuous or not', () => {
    // It tests the hop's ENDPOINTS, which are a different set from the source — the leading-run
    // rule `dropVacuousLabels` already had. `P` is on every vertex and this still must stay.
    const g = build();

    expect(kinds(g, traversal(V(), out('T'), hasLabel('P', 'Q'), count()))).toEqual([
      'V',
      'out',
      'hasLabel',
      'count',
    ]);
  });
});
