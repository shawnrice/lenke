// `rangeCap` — the cap behind item 1758's 2.39x on an indexed wide range.
//
// ⚠️ THIS EXISTS BECAUSE THE CHANGE IS ANSWER-EQUIVALENT. An index seed only has to be a SUPERSET
// (declined filters stay in the plan as residuals and re-validate every element), so capping the
// count — or breaking the cap — cannot change a single row. The gremlin suite and all seven
// byte-identity fuzzers pass either way. `perf-gate-needs-its-own-test`: extract the arithmetic and
// test it directly, because nothing else can see it.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { rangeCap, seedForStep } from './index-seed.ts';

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

describe('seedForStep with cap 0 — "exact seeds only"', () => {
  // `node-values.ts` requires `removable: true` and a range candidate never is, so it pays an
  // O(distinct values in range) count and discards it. Item 1759 measured that at 1.62x on
  // `V().has('n', lt(10000)).values('s')`, and `cap === 0` is the contract that suppresses it.
  const indexed = (): Graph => {
    const g = new Graph();

    for (let i = 0; i < 200; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
    }

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

    return g;
  };

  const step = (pred: unknown) => ({ kind: 'has', key: 'n', pred }) as never;

  test('suppresses a RANGE seed entirely', () => {
    const idx = indexed().vertexPropertyIndex;

    expect(seedForStep(step({ op: 'lt', value: 100 }), idx, 0)).toBeNull();
    expect(seedForStep(step({ op: 'gt', value: 100 }), idx, 0)).toBeNull();
  });

  test('⚠️ still returns an EXACT seed — suppressing those would lose the fast path', () => {
    const idx = indexed().vertexPropertyIndex;
    const seed = seedForStep(step({ op: 'eq', value: 7 }), idx, 0);

    // This is the assertion with teeth: a mutant that returned `null` for every predicate at cap 0
    // would pass the test above and silently disable the `node-values` fast path it exists to serve.
    expect(seed).not.toBeNull();
    expect(seed?.removable).toBe(true);
    expect(seed?.count).toBe(1);
  });

  test('an uncapped call DOES return the range seed, so cap 0 is the only suppressor', () => {
    const idx = indexed().vertexPropertyIndex;
    const seed = seedForStep(step({ op: 'lt', value: 100 }), idx, Number.POSITIVE_INFINITY);

    expect(seed).not.toBeNull();
    expect(seed?.removable).toBe(false);
    expect(seed?.count).toBe(100);
  });
});
