import { describe, expect, test } from 'bun:test';

import { invertedHopBudget, sampleRulesOutInversion } from './executor/shortcuts.js';

// Item 585. A bounded `-[:T]->{1,2}(y <test>)` count needs, per vertex, how many of its out-edges
// land somewhere that PASSES. Walking out-edges pays one visit per edge in the graph and is FLAT
// in how selective the test is — item 584 measured rejecting every vertex at 355.86ms against
// accepting every vertex at 379.17, with 181.81 unfiltered. Accumulating the same quantity through
// the IN-adjacency of passing vertices instead costs one visit per edge INTO a passing vertex, so
// it scales with selectivity: 3.10x when the test rejects everything, 1.42x at a third, 1.26x on a
// label, and the forward route kept where it wins.
//
// This file tests the DECISION, not the walk, and it exists because nothing else can. Both routes
// return the same count, so a mutation of the cost arithmetic cannot fail a differential test:
// item 585 ran three (always invert; drop the `max >= 2` guard; invert for a vacuous test) and all
// three passed 11 cases pinned against native, exactly as they were bound to. The walk's
// correctness lives in `packages/native/src/varlen-degree-count.test.ts` and in a 900-query
// cross-engine sweep over BOTH routes; its cost model lives here.
describe('invertedHopBudget', () => {
  test('a BROAD start label returns the vertex count as the budget', () => {
    // 200,000 vertices, 1,000,000 edges, every vertex a source: avgDeg 5, reached capped at V,
    // and 200,000 * 5 > 200,000, so the sweep is worth paying for.
    expect(invertedHopBudget(200_000, 1_000_000, 200_000)).toBe(200_000);
  });

  test('a NARROW start label still clears the bar when the fan-out is wide', () => {
    // 1,000 sources at degree 5 reach ~5,000 vertices, each costing ~5 visits: 25,000 edge
    // visits against 200,000 vertices swept. The forward route is cheaper, so: no sweep.
    expect(invertedHopBudget(200_000, 1_000_000, 1_000)).toBeNull();
    // 40,000 sources reach 200,000 (capped) and 200,000 * 5 clears it.
    expect(invertedHopBudget(200_000, 1_000_000, 40_000)).toBe(200_000);
  });

  test('the budget is the REACHED estimate, not the vertex count, when reach is below it', () => {
    // avgDeg 20 here, so 5,000 sources reach 100,000 of the 200,000 vertices — and the budget
    // must be that 100,000, because `degreeOf` is only ever called for vertices actually reached.
    // Returning the vertex count instead would invert on a predicate passing 150,000, where the
    // forward route touches only 100,000.
    expect(invertedHopBudget(200_000, 4_000_000, 5_000)).toBe(100_000);
  });

  test('a SPARSE graph keeps the forward route', () => {
    // One edge per vertex: reached ~= srcCount and each costs ~1 visit, so the forward route
    // never beats one visit per vertex and the sweep would be pure loss.
    expect(invertedHopBudget(200_000, 200_000, 200_000)).toBeNull();
    // Below one edge per vertex it is further from worth it.
    expect(invertedHopBudget(200_000, 50_000, 200_000)).toBeNull();
  });

  test('an EMPTY graph decides without dividing by zero', () => {
    // `avgDeg` is `edgeCount / vertexCount`; at zero vertices that is NaN, and every comparison
    // against NaN is false — so the arithmetic would answer "no sweep" by accident rather than on
    // purpose. The guard makes it deliberate, which is the difference between a correct answer and
    // a correct answer that stops being correct when someone flips the comparison.
    expect(invertedHopBudget(0, 0, 0)).toBeNull();
    expect(invertedHopBudget(0, 10, 5)).toBeNull();
  });

  test('no sources means no sweep', () => {
    // A start label nothing carries: nothing is reached, so there is no degree to compute.
    expect(invertedHopBudget(200_000, 1_000_000, 0)).toBeNull();
  });
});

// The sampled pre-check. Its job is to cap the loss on a test that passes nearly everything: the
// full sweep is O(V) predicate calls and 200,000 of them cost 3-8% of the query when they only
// end up declining. Saying "invert" is NOT its decision to make — the exact `passing.length <
// budget` check still runs — so the only error it can make on the optimistic side is to waste the
// sweep it was trying to avoid.
describe('sampleRulesOutInversion', () => {
  test('a test passing EVERYTHING is ruled out before the sweep', () => {
    // 1024 of 1024 passed, so the projection is all 200,000 against a 200,000 budget: over 2x.
    expect(sampleRulesOutInversion(1024, 1024, 200_000, 200_000)).toBe(true);
  });

  test('a SELECTIVE test is not ruled out', () => {
    // a third pass -> projection 66,667, well under the budget
    expect(sampleRulesOutInversion(1024, 341, 200_000, 200_000)).toBe(false);
    // none pass -> the case inversion wins by the most
    expect(sampleRulesOutInversion(1024, 0, 200_000, 200_000)).toBe(false);
  });

  test('the comparison is TIE-INCLUSIVE, which is the whole point', () => {
    // The budget is capped at the vertex count, so a test passing everything projects EXACTLY the
    // budget. An exclusive comparison — or any margin above it — can never fire for that case,
    // which is the one the sample exists to catch. The first version required a factor of two and
    // was dead on arrival; this test is what found it.
    expect(sampleRulesOutInversion(1024, 1024, 200_000, 200_000)).toBe(true);
    // half pass against a half-size budget: projection is exactly the budget, and the exact check
    // would decline too (100,000 is not < 100,000), so ruling out saves a pointless sweep.
    expect(sampleRulesOutInversion(1024, 512, 200_000, 100_000)).toBe(true);
    // just under the budget must still sweep — the win is real there
    expect(sampleRulesOutInversion(1024, 511, 200_000, 100_000)).toBe(false);
  });

  test('a sample that IS the whole graph defers to the exact check', () => {
    // Nothing was saved by sampling, so the heuristic has no business overriding the real count.
    expect(sampleRulesOutInversion(1024, 1024, 1024, 1)).toBe(false);
    expect(sampleRulesOutInversion(1024, 1024, 500, 1)).toBe(false);
    expect(sampleRulesOutInversion(0, 0, 200_000, 1)).toBe(false);
  });
});
