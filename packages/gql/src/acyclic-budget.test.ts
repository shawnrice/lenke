// The ACYCLIC route's work ceiling, as arithmetic (item 2002).
//
// ⚠️⚠️ **THE CEILING WAS THE ONE THING THIS ROUTE GOT WRONG, and it was wrong in a way no answer
// test could see.** Sized as `levels * (|V| + |E|)` — copied from `perSourceBudget` — the UNSEEDED
// count, the 520x case the whole route was built for, DECLINED on the budget and stayed at 869 ms
// while the seeded case took the route and went 15.28 -> 1.05 ms. The answers were identical either
// way, because declining falls through to the general clause loop. So a 19x regression against the
// route's own purpose was invisible to every correctness test, and only the measurement caught it.
//
// 🔑 **THAT IS WHY THE BUDGET GETS ITS OWN TEST** ([[perf-gate-needs-its-own-test]]: a route choice
// is answer-equivalent, so extract the arithmetic and test THAT). The claim pinned here is not a
// specific constant — it is that the ceiling is large enough to ADMIT the shape the route exists
// for. A mutant that shrinks the factor is answer-equivalent and silently restores the 869 ms.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { acyclicPerSourceCount } from './executor/acyclic-count.js';

/** `n` vertices, `fanout` out-edges each, built the way the engine's own fixtures are. */
const build = (n: number, fanout: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 7 } });
  }

  // ⚠️ SPLIT ON THE REPEAT INDEX. `to = (a*k + b) % N` is invariant under `k -> k + N`, so a flat
  // loop over `k < n * fanout` sends one vertex's whole fanout to the SAME target — the graph stays
  // FUNCTIONAL, every degree looks right, and a k-hop count becomes `fanout^k * n` by construction.
  // Here it would also make almost every path non-acyclic, so the route would be measured against
  // an answer of nearly zero.
  for (let e = 0; e < n * fanout; e += 1) {
    const i = e % n;
    const hop = Math.floor(e / n);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1))!,
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % n) + 1))!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const spec = (max: number) => ({
  types: ['E'],
  min: 1,
  max,
  inward: false,
  startName: undefined,
  passes: () => true,
});

describe('the ACYCLIC route admits the shape it exists for', () => {
  test('an UNSEEDED depth-2 count over every vertex is NOT declined', () => {
    /*
     * This is the case the first budget refused. At `n` vertices and fanout 5 the DFS does
     * `n * (5 + 25)` edge steps, while the old ceiling was `2 * (n + 5n)` = `12n` — so the walk
     * exceeded it by 2.5x at EVERY size, which is why the decline was total rather than
     * size-dependent and why no sweep would have revealed a crossover.
     */
    const g = build(400, 5);

    expect(acyclicPerSourceCount(g, spec(2))).toBeGreaterThan(0);
  });

  test('a depth-3 unseeded count is NOT declined either', () => {
    // Deeper means more work per source, so a ceiling that admits depth 2 need not admit depth 3.
    const g = build(400, 5);

    expect(acyclicPerSourceCount(g, spec(3))).toBeGreaterThan(0);
  });

  test('the count GROWS with the bound, so a non-decline is not a trivial zero', () => {
    // ⚠️ `> 0` ALONE IS NOT ENOUGH: a route that declined would return `undefined`, but one that
    // returned a WRONG small number would also pass that. A quantified `{1,k}` counts every path of
    // length 1..k, so raising the bound must raise the count.
    const g = build(400, 5);
    const one = acyclicPerSourceCount(g, spec(1))!;
    const two = acyclicPerSourceCount(g, spec(2))!;
    const three = acyclicPerSourceCount(g, spec(3))!;

    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  test('DECLINES rather than hanging when the depth makes the walk explode', () => {
    /*
     * The ceiling's actual job. At fanout 5 and depth 12 the path count per source is ~5^12, so no
     * budget should admit it — and the alternative (the general clause loop) would not finish
     * either. Declining returns control instead of sitting in the DFS.
     *
     * ⚠️ KEPT SMALL ON PURPOSE: 120 vertices, so if the ceiling were removed entirely this test
     * would TIME OUT rather than consume the machine. [[dogfood-sim-resource-limits]] — this repo
     * has taken the box down four times, and an unbounded search in a unit suite is that shape.
     */
    const g = build(120, 5);

    expect(acyclicPerSourceCount(g, spec(12))).toBeUndefined();
  });
});
