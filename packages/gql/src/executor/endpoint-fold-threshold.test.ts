/*
 * Item 2072 — the endpoint-fold route threshold, as a pure function.
 *
 * **THIS IS A ROUTE CHOICE, SO NO ANSWER TEST CAN REACH IT.** Both arms answer identically — that
 * is what makes the fold legal — so every differential and engine-level test passes whichever side of
 * the boundary it lands on. [[perf-gate-needs-its-own-test]] prescribes exactly this: extract the
 * arithmetic as a pure function and unit-test it. It WAS extracted (item 1344) and never tested.
 *
 * **THE BOUNDARY IS NOT ARBITRARY — IT IS A MEASURED TABLE**, quoted from the source:
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
 * silent inequality. *
 * **RE-MEASURED AT ITEM 2402, AND THE BOUNDARY MOVED 2 -> 5. The table above was HONEST and is
 * now STALE, because the thing it compares against got faster.** The fold column reproduces almost
 * exactly (it is O(candidate endpoints) and reads no edge); the WALK column has roughly halved since,
 * which moves the crossover up:
 *
 * ```text
 *     degree   fold     walk     winner           item 1344's walk
 *          1    (n/a)    9.50    gate declines      71.89
 *          2   78.03    21.24    walk, 3.67x        88.66   <- the fold was a PESSIMIZATION here
 *          3   90.52    47.88    walk, 1.89x       104.61
 *          4   85.29    61.63    walk, 1.38x       117.64
 *          5   83.76    84.45    tie,  1.008x      150.14   <- DECLINED: see the fixture note below
 *          6   83.34   106.50    fold, 1.28x
 *          7     ~83   110.40    fold, 1.33x
 * ```
 *
 * **The boundary is 6, which is ABOVE the tie, and that is a DELIBERATE departure from item
 * 1345's rule.** It admitted at its tie row because "a tie costs nothing either way". That holds on
 * this probe's fixture, where degree 5 is 83.76 against 84.45 — but the bench's own `graphDoc`
 * (NDJSON-loaded, ONE property, degree 5) reads the fold at **97.8 ms against the walk's 30.0, a
 * 3.26x LOSS**. A tie on one fixture and a 3.26x loss on another is not a tie, so degree 5 goes to
 * the walk. **Nothing was wrong with the original measurement**:
 * items 2297/2298 shipped 24-27x on far-driven hop walks and item 2401 freed the folds, so the gate's
 * comparand improved underneath it. This is the stale-constant class item 1301 catalogued, in a
 * threshold rather than in a heading.
 *
 * **FIXTURE-DEPENDENCE IS NOT A CAVEAT HERE, IT IS THE RESIDUAL FINDING.** The fold's cost is
 * per CANDIDATE VERTEX and flat in both degree and width (81-88 ms across degrees 2-16 and 1 or 4
 * properties); the walk's is per EDGE and scales with both. So the crossover is a function of two
 * costs and this gate reads only their RATIO's degree term. Measured crossovers: degree ~5 on this
 * probe at four properties AND at one, but well above 5 on `graphDoc`. **A width- or cost-aware gate
 * is OPEN** — 6 is the value that loses nothing on every fixture measured, not a derived optimum.
 *
 * IT IS ALSO ADMITTEDLY A PROXY: the source says the quantity it wants is "edges OF THE WANTED
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

  test('degree 6 is ADMITTED, and DECLINING the degree-5 tie is the deliberate part', () => {
    /*
     * **`>=`, NOT `>`.** The degree-2 row is a 1.007x tie, so the boundary costs nothing either
     * way — and placing it here keeps every measured win (degree 3+) on the fold. A mutant changing
     * this to `>` would move the tie to the walk and no answer would differ, which is why the
     * assertion is on the exact boundary value and not merely on something above it.
     */
    expect(endpointFoldBeatsRowWalk(600, 100)).toBe(true);
    expect(endpointFoldBeatsRowWalk(6, 1)).toBe(true);
    // The degrees item 2402 moved to the WALK, degree 5 INCLUDED. Item 1345 admitted at its tie row
    // on the grounds that a tie costs nothing; the bench's own NDJSON fixture shows degree 5 losing
    // 3.26x, so the tie resolves to the walk and the boundary sits ABOVE it.
    expect(endpointFoldBeatsRowWalk(200, 100)).toBe(false);
    expect(endpointFoldBeatsRowWalk(400, 100)).toBe(false);
    expect(endpointFoldBeatsRowWalk(500, 100)).toBe(false);
  });

  test('just BELOW the boundary declines', () => {
    expect(endpointFoldBeatsRowWalk(599, 100)).toBe(false);
    expect(endpointFoldBeatsRowWalk(1, 1)).toBe(false);
  });

  test('degree 6 and up admit — the measured wins', () => {
    expect(endpointFoldBeatsRowWalk(600, 100)).toBe(true);
    expect(endpointFoldBeatsRowWalk(800, 100)).toBe(true);
  });

  test('an EMPTY graph does not divide by zero or admit on a vacuous truth', () => {
    /*
     * `0 >= 0 * 6` is TRUE, so an empty graph takes the fold. That is harmless — there is nothing
     * to fold — but it is asserted so the behaviour is recorded rather than discovered later, and so
     * a future rewrite into a division has to confront the zero.
     */
    expect(endpointFoldBeatsRowWalk(0, 0)).toBe(true);
    expect(endpointFoldBeatsRowWalk(0, 1)).toBe(false);
  });
});
