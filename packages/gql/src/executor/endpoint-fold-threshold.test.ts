/*
 * Item 2072 — the endpoint-fold route threshold, as a pure function.
 *
 * ⚠️⚠️ **THIS IS A ROUTE CHOICE, SO NO ANSWER TEST CAN REACH IT.** Both arms answer identically — that
 * is what makes the fold legal — so every differential and engine-level test passes whichever side of
 * the boundary it lands on. [[perf-gate-needs-its-own-test]] prescribes exactly this: extract the
 * arithmetic as a pure function and unit-test it. It WAS extracted (item 1344) and never tested.
 *
 * 🔑 **THE BOUNDARY IS NOT ARBITRARY — IT IS A MEASURED TABLE**, quoted from the source:
 *
 * ```text
 *     degree   fold     walk     winner
 *          1   87.68    71.89    walk, 1.22x   <- the rung was a PESSIMIZATION here
 *          2   89.29    88.66    tie,  1.007x
 *          3   87.54   104.61    fold, 1.19x
 *          4   86.90   117.64    fold, 1.35x
 *          5  110.31   150.14    fold, 1.36x
 * ```
 *
 * "Admitting AT two is deliberate: that row is a tie, so the boundary costs nothing either way, and
 * putting it here keeps every measured WIN (degree 3 and up) on the fold." These tests pin that
 * sentence, so a future edit that moves the threshold has to argue with the table rather than with a
 * silent inequality.
 *
 * ⚠️ IT IS ALSO ADMITTEDLY A PROXY: the source says the quantity it wants is "edges OF THE WANTED
 * TYPES per CANDIDATE endpoint", and `Graph` carries no per-type edge count, so whole-graph
 * `edgeCount`/`vertexCount` stand in because both are O(1). The tests below are about the arithmetic
 * it actually performs, not about the quantity it would prefer.
 */
import { describe, expect, test } from 'bun:test';

import { endpointFoldBeatsRowWalk } from './hop-endpoint-extremum.js';

describe('endpointFoldBeatsRowWalk — the measured threshold (item 2072)', () => {
  test('degree 1 DECLINES — the table measured the fold as a 1.22x PESSIMIZATION there', () => {
    expect(endpointFoldBeatsRowWalk(100, 100)).toBe(false);
    expect(endpointFoldBeatsRowWalk(1, 1)).toBe(false);
  });

  test('⚠️ degree 2 is ADMITTED, and the inclusive boundary is the deliberate part', () => {
    /*
     * ⚠️⚠️ **`>=`, NOT `>`.** The degree-2 row is a 1.007x tie, so the boundary costs nothing either
     * way — and placing it here keeps every measured win (degree 3+) on the fold. A mutant changing
     * this to `>` would move the tie to the walk and no answer would differ, which is why the
     * assertion is on the exact boundary value and not merely on something above it.
     */
    expect(endpointFoldBeatsRowWalk(200, 100)).toBe(true);
    expect(endpointFoldBeatsRowWalk(2, 1)).toBe(true);
  });

  test('just BELOW the boundary declines', () => {
    expect(endpointFoldBeatsRowWalk(199, 100)).toBe(false);
    expect(endpointFoldBeatsRowWalk(1, 1)).toBe(false);
  });

  test('degree 3 and up admit — the measured wins', () => {
    expect(endpointFoldBeatsRowWalk(300, 100)).toBe(true);
    expect(endpointFoldBeatsRowWalk(500, 100)).toBe(true);
  });

  test('⚠️ an EMPTY graph does not divide by zero or admit on a vacuous truth', () => {
    /*
     * ⚠️ `0 >= 0 * 2` is TRUE, so an empty graph takes the fold. That is harmless — there is nothing
     * to fold — but it is asserted so the behaviour is recorded rather than discovered later, and so
     * a future rewrite into a division has to confront the zero.
     */
    expect(endpointFoldBeatsRowWalk(0, 0)).toBe(true);
    expect(endpointFoldBeatsRowWalk(0, 1)).toBe(false);
  });
});
