// `rangeCap` — the cap behind item 1758's 2.39x on an indexed wide range.
//
// ⚠️ THIS EXISTS BECAUSE THE CHANGE IS ANSWER-EQUIVALENT. An index seed only has to be a SUPERSET
// (declined filters stay in the plan as residuals and re-validate every element), so capping the
// count — or breaking the cap — cannot change a single row. The gremlin suite and all seven
// byte-identity fuzzers pass either way. `perf-gate-needs-its-own-test`: extract the arithmetic and
// test it directly, because nothing else can see it.
import { describe, expect, test } from 'bun:test';

import { rangeCap } from './index-seed.ts';

/** Mirrors the module's own constants; a drift here should fail loudly rather than silently pass. */
const SEEK_FLOOR_ELEMENTS = 4_096;
const SEEK_MAX_FRACTION = 1 / 8;

describe('rangeCap', () => {
  test('is INFINITE below the floor — the sub-floor gate admits at any count', () => {
    // Below the floor `seekIsWorthIt` returns true regardless of the count, so the ranking between
    // two over-cap candidates WOULD decide which seed runs. A capped count cannot order them, so
    // there must be no cap at all here. This is the property that makes the substitution identical
    // rather than merely harmless.
    expect(rangeCap(0)).toBe(Number.POSITIVE_INFINITY);
    expect(rangeCap(1)).toBe(Number.POSITIVE_INFINITY);
    expect(rangeCap(SEEK_FLOOR_ELEMENTS - 1)).toBe(Number.POSITIVE_INFINITY);
  });

  test('is the source fraction AT and above the floor', () => {
    expect(rangeCap(SEEK_FLOOR_ELEMENTS)).toBe(SEEK_FLOOR_ELEMENTS * SEEK_MAX_FRACTION);
    expect(rangeCap(20_000)).toBe(2_500);
    expect(rangeCap(1_000_000)).toBe(125_000);
  });

  test('the floor boundary is exactly at the floor, not one either side', () => {
    // An off-by-one here would either cap a sub-floor graph (changing which seed it picks) or leave
    // a graph AT the floor uncapped (leaving the regression in place at exactly 4,096 elements).
    expect(rangeCap(SEEK_FLOOR_ELEMENTS - 1)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(rangeCap(SEEK_FLOOR_ELEMENTS))).toBe(true);
  });

  test('never exceeds the gate’s largest possible threshold', () => {
    // `seekIsWorthIt(count, scan, total)` is asked with `scan <= sourceSize`, so the cap must not
    // sit ABOVE `sourceSize * SEEK_MAX_FRACTION` — a higher cap would let a count through that is
    // exact-looking but already declined, which is harmless, while a cap above it in the other
    // direction would be unsound. Pinning the relation is what keeps a future edit honest.
    for (const n of [4_096, 10_000, 20_000, 500_000]) {
      expect(rangeCap(n)).toBeLessThanOrEqual(n * SEEK_MAX_FRACTION);
    }
  });
});
