// `edgeDrivenBeatsNoCsrFallback` decides, once `csrHopRoute` has declined, whether the edge-driven
// walk is the better fallback than the start-driven one. It is a ROUTE choice, so every arm answers
// identically — the 5,498-test gql suite, the oracle and all seven fuzzers pass with this function
// returning a constant either way. Nothing but a test written against the function itself can see it
// break, which is why it exists as an exported pure function rather than an inline condition.
//
// WHAT THE NUMBERS BEHIND IT ARE (item 2442, N=200,000, arms alternated, one cell per process):
//
//   vacuous start label, one write per read   far-driven fallback 36.19 ms   edge-driven 14.35
//   vacuous start label, WARM                 far-driven on CSR    8.54      edge-driven 15.62
//
// and item 1938 is the other side of the same constant: a BOOLEAN gate here — always preferring the
// edge pass — measured a 25x REGRESSION at 1% coverage, because the edge-driven walk is O(|E|)
// whatever the label excludes while the start-driven walk iterates the label bucket and is
// sub-linear. So the threshold is load-bearing in both directions, and the three cases below are the
// three it has to get right.
import { describe, expect, test } from 'bun:test';

import { edgeDrivenBeatsNoCsrFallback } from './hop-projection';
import { EDGE_DRIVEN_MIN_COVERAGE } from './labels';

describe('edgeDrivenBeatsNoCsrFallback', () => {
  test('UNKNOWN coverage declines, because the edge pass cannot be priced without it', () => {
    // `labelCoverage` returns undefined when it cannot answer. Treating that as "broad enough"
    // would route a 1%-coverage label to an O(|E|) pass, which is item 1938's 25x.
    expect(edgeDrivenBeatsNoCsrFallback(undefined)).toBe(false);
  });

  test('coverage BELOW the threshold declines; AT or ABOVE it accepts', () => {
    expect(edgeDrivenBeatsNoCsrFallback(0)).toBe(false);
    expect(edgeDrivenBeatsNoCsrFallback(EDGE_DRIVEN_MIN_COVERAGE - 0.01)).toBe(false);

    // AT the threshold accepts: the constant is a lower BOUND, and item 1939 set it from a swept
    // crossover band (0.18-0.35) plus headroom, so the boundary belongs on the accepting side.
    expect(edgeDrivenBeatsNoCsrFallback(EDGE_DRIVEN_MIN_COVERAGE)).toBe(true);
    expect(edgeDrivenBeatsNoCsrFallback(EDGE_DRIVEN_MIN_COVERAGE + 0.01)).toBe(true);
  });

  test('a VACUOUS label is coverage 1.0 and accepts — the case the change was built for', () => {
    // This is the only case the shipped caller actually reaches: the far-driven walk runs under a
    // vacuity gate, so when its no-CSR thunk fires the start label excludes nobody. The assertion
    // pins that the gate does not accidentally exclude it.
    expect(edgeDrivenBeatsNoCsrFallback(1)).toBe(true);
  });

  test('the threshold is the one the rest of the family uses, not a second copy', () => {
    // ONE SPELLING: a private constant here would drift from the dispatch's own coverage check and
    // the two would disagree about the same question. Pinned so a future edit cannot fork it.
    expect(EDGE_DRIVEN_MIN_COVERAGE).toBeGreaterThan(0);
    expect(EDGE_DRIVEN_MIN_COVERAGE).toBeLessThan(1);
    expect(edgeDrivenBeatsNoCsrFallback(EDGE_DRIVEN_MIN_COVERAGE)).toBe(true);
    expect(edgeDrivenBeatsNoCsrFallback(EDGE_DRIVEN_MIN_COVERAGE / 2)).toBe(false);
  });
});
