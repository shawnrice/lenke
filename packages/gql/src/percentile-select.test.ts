import { describe, expect, test } from 'bun:test';

import { percentileOf } from './executor/scalars.js';

/**
 * `percentileOf` answers with ONE order statistic rather than a sort (item 1163). This file is
 * its oracle: a REFERENCE implementation that sorts, run against the real one over many inputs.
 *
 * The reference is deliberately the code the fast version replaced — `map` + `filter` + a
 * comparator sort — so "agrees with the reference" means exactly "answers what it answered
 * before", which is the property that matters for a change whose whole point is that the answer
 * does not move.
 */
const reference = (values: readonly unknown[], frac: number, cont: boolean): number | null => {
  const nums = (values as number[])
    .map((v) => (v === 0 ? 0 : v)) // numArg's -0 collapse, which the real one also applies
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  const n = nums.length;

  if (n === 0) {
    return null;
  }

  if (cont) {
    const rn = frac * (n - 1);
    const lo = Math.floor(rn);
    const hi = Math.ceil(rn);

    return lo === hi ? nums[lo] : nums[lo] + (rn - lo) * (nums[hi] - nums[lo]);
  }

  return nums[Math.min(n - 1, Math.max(0, Math.ceil(frac * n) - 1))];
};

/** Integer LCG — item 702's f64 version passed 2^53 and collapsed to a ~11k period. */
const lcg = (seed: number) => {
  let state = seed;

  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;

    return state;
  };
};

const FRACS = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1];

describe('percentileOf answers with a selection', () => {
  test('agrees with the sorting reference on hand-built edge cases', () => {
    const cases: Record<string, unknown[]> = {
      empty: [],
      'one value': [7.5],
      'two ascending': [1, 2],
      'two descending': [2, 1],
      // ALREADY SORTED and REVERSE SORTED are the inputs a first-element pivot degrades on, so
      // they are correctness AND the reason the pivot is median-of-three.
      ascending: Array.from({ length: 64 }, (_, i) => i),
      descending: Array.from({ length: 64 }, (_, i) => 63 - i),
      'all equal': Array.from({ length: 32 }, () => 5),
      'two distinct values': Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 1 : 9)),
      negatives: [-10, 0.5, -3, 8],
      'both zeros': [-0, 0, 3],
      'zeros only': [-0, 0],
      // DROPPED by both, so this checks the fast gather drops exactly the same ones.
      'non-finite mixed in': [1, NaN, 9, Infinity, -Infinity, 4],
      'every value non-finite': [NaN, Infinity, -Infinity],
      'large magnitudes': [1e308, -1e308, 0, 1e-308],
    };

    for (const [name, vals] of Object.entries(cases)) {
      for (const frac of FRACS) {
        for (const cont of [false, true]) {
          const got = percentileOf(vals, frac, cont);
          const want = reference(vals, frac, cont);

          // Object.is, not toBe: it separates -0 from +0 and makes NaN compare equal to itself,
          // which is the whole point on the ±0 and non-finite cases.
          expect(
            Object.is(got, want),
            `${name} / frac=${frac} / cont=${cont}: got ${String(got)}, want ${String(want)}`,
          ).toBe(true);
        }
      }
    }
  });

  test('agrees with the sorting reference over randomized inputs, with the SIZE swept', () => {
    const rnd = lcg(0x5eed_1163);

    // The size is swept because `selectNth` is a size-dependent algorithm: a small input never
    // leaves the first partition, so a fixture small enough to be convenient can sit entirely
    // inside the branch that cannot fail. That exact mistake made a native mutant survive one
    // item earlier (1162, M1).
    for (const n of [1, 2, 3, 5, 9, 17, 33, 64, 129, 512, 2048]) {
      for (let trial = 0; trial < 40; trial += 1) {
        const vals: unknown[] = Array.from({ length: n }, () => {
          const r = rnd() % 10;

          // A narrow value range on purpose, so DUPLICATES are common — a selection and a sort
          // can only disagree where values tie.
          if (r === 0) {
            return NaN;
          }

          if (r === 1) {
            return -0;
          }

          return (rnd() % 20) - 10;
        });

        for (const frac of FRACS) {
          for (const cont of [false, true]) {
            const got = percentileOf(vals, frac, cont);
            const want = reference(vals, frac, cont);

            expect(
              Object.is(got, want),
              `n=${n} trial=${trial} frac=${frac} cont=${cont}: got ${String(got)}, want ${String(want)}, input ${JSON.stringify(vals)}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  test('an ALREADY-SORTED column does not degrade to quadratic', () => {
    // A PERFORMANCE assertion, which this file otherwise avoids — and the one case where that is
    // not flaky, because the gap it guards is five orders of magnitude.
    //
    // `selectNth` picks a median-of-three pivot. A first-element pivot is equally CORRECT, so
    // every assertion above passes with it (item 1163, mutant M6 — predicted to survive, and it
    // did). What it is not is fast: measured over 200,000 already-sorted values,
    //
    //     median-of-three   0.3 ms
    //     first element  5517.2 ms      ~18,000x
    //
    // and an ascending column is the ORDINARY case for a percentile, not an adversarial one. So
    // the property needs its own instrument, per the rule that a route choice is answer-equivalent
    // and therefore invisible to every differential test.
    //
    // The budget is 2 seconds against a 0.3 ms expectation — roughly 6,000x headroom, so no
    // plausible machine or CI contention reaches it, while the mutant exceeds it by 2.7x.
    const n = 200_000;
    const ascending = Array.from({ length: n }, (_, i) => i);
    const started = performance.now();

    // `disc` at 0.5 selects index `ceil(0.5 * n) - 1` = 99,999, and `ascending[i] === i`.
    expect(percentileOf(ascending, 0.5, false)).toBe(n / 2 - 1);

    const elapsed = performance.now() - started;

    expect(
      elapsed < 2000,
      `a sorted column took ${elapsed.toFixed(1)} ms; a quadratic pivot is the likely cause`,
    ).toBe(true);

    // DESCENDING too: it is the other input a naive pivot degrades on, and the two are not the
    // same partition path.
    const descending = Array.from({ length: n }, (_, i) => n - 1 - i);
    const started2 = performance.now();

    expect(percentileOf(descending, 0.5, false)).toBe(n / 2 - 1);
    expect(performance.now() - started2 < 2000).toBe(true);
  });

  test('a non-numeric value still raises, and does so even when it would be dropped', () => {
    // The old code mapped `numArg` over EVERY element before filtering, so a non-number raised
    // regardless of whether the filter would have removed it. The one-pass gather has to keep
    // that, or a query that used to fault starts answering.
    expect(() => percentileOf([1, 2, 'x'], 0.5, false)).toThrow();
    expect(() => percentileOf([1, 'x', NaN], 0.5, false)).toThrow();
    expect(() => percentileOf([true, 1], 0.5, true)).toThrow();
  });
});
