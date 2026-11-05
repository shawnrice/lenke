import { describe, expect, it } from 'bun:test';

/**
 * ITEM 1492 — `specializePredicate` builds a monomorphic closure for one predicate so a hot loop
 * stops calling the megamorphic `matches`. Measured: `V().has('num', gt(N)).count()` 2.54 -> 1.34 ms
 * (1.92x) over 200,000 vertices, the general `has` row filter 6.25 -> 5.63 (1.12x), three
 * real controls flat.
 *
 * ⚠️ THE ENTIRE RISK IS THAT A SPECIALIZATION IS NOT THE SAME FUNCTION AS ITS `matches` ARM. So the
 * test is a DIFFERENTIAL, not a list of expectations: for the cross-product of every op, every
 * operand type and every value a property read can produce, a specialized closure must return
 * EXACTLY what `matches` returns. Writing expected booleans by hand would encode my belief about
 * `matches` instead of `matches`, and the belief is the thing that can be wrong.
 *
 * The matrix is also what makes the UNSPECIALIZED shapes testable: every predicate for which
 * `specializePredicate` returns `undefined` is asserted to do so, so a change that starts
 * specializing one (a temporal operand, say) fails here rather than silently answering from a
 * derivation nobody did.
 */
import { LocalDate, LocalDateTime, LocalTime } from '@lenke/core';

import {
  between,
  containing,
  endingWith,
  eq,
  gt,
  gte,
  inside,
  lt,
  lte,
  neq,
  not,
  outside,
  regex,
  startsWith,
  within,
  without,
} from './index.js';
import { matches, specializePredicate } from './predicates.js';

/** Every value a property read can produce, plus the absence marker. */
const VALUES: readonly unknown[] = [
  undefined,
  null,
  0,
  -0,
  1,
  -1,
  3600,
  3601,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '',
  'a',
  'b',
  's5',
  's50',
  true,
  false,
  LocalDate.parse('2020-01-01'),
  new LocalTime(0, 0),
  new LocalDateTime(0, 0),
  [1, 2],
  { k: 1 },
];

/** Operand types, including the ones that must NOT specialize. */
const NUM_OPERANDS = [0, 1, 3600, -1, Number.NaN] as const;
const STR_OPERANDS = ['', 'a', 's5'] as const;
const OTHER_OPERANDS = [true, null, LocalDate.parse('2020-01-01'), new LocalTime(0, 0)] as const;

const show = (v: unknown): string =>
  typeof v === 'object' && v !== null ? (v.constructor?.name ?? 'object') : String(v);

describe('a specialized closure is EXACTLY its matches arm', () => {
  for (const make of [eq, neq, gt, gte, lt, lte]) {
    for (const operand of [...NUM_OPERANDS, ...STR_OPERANDS]) {
      it(`${make.name}(${show(operand)}) agrees with matches on every value`, () => {
        const pred = make(operand);
        const fast = specializePredicate(pred);

        expect(fast, `${make.name}(${show(operand)}) should specialize`).toBeDefined();

        for (const v of VALUES) {
          expect(fast?.(v), `${make.name}(${show(operand)}) on ${show(v)}`).toBe(matches(pred, v));
        }
      });
    }
  }
});

describe('shapes that must NOT specialize', () => {
  it('an ordering or equality predicate over a NON-SCALAR operand declines', () => {
    for (const make of [eq, neq, gt, gte, lt, lte]) {
      for (const operand of OTHER_OPERANDS) {
        expect(
          specializePredicate(make(operand)),
          `${make.name}(${show(operand)}) must NOT specialize — no operator form was derived for it`,
        ).toBeUndefined();
      }
    }
  });

  it('every other op declines', () => {
    const preds = [
      between(0, 10),
      inside(0, 10),
      outside(0, 10),
      within([1, 2]),
      without([1, 2]),
      startsWith('a'),
      endingWith('a'),
      containing('a'),
      regex('^a'),
      not(gt(1)),
    ];

    for (const p of preds) {
      expect(specializePredicate(p), `op ${p.op} must not specialize`).toBeUndefined();
    }
  });

  it('`present` declines — it is already one test, with nothing to hoist', () => {
    // Reached through the synthetic `hasKey` rewrite rather than a public constructor.
    expect(specializePredicate({ op: 'present' })).toBeUndefined();
  });
});

describe('the cases the derivation turns on', () => {
  it('a NaN OPERAND matches nothing, on both paths', () => {
    for (const make of [gt, gte, lt, lte]) {
      const pred = make(Number.NaN);
      const fast = specializePredicate(pred);

      for (const v of VALUES) {
        expect(fast?.(v)).toBe(false);
        expect(matches(pred, v)).toBe(false);
      }
    }
  });

  it('a NaN VALUE matches no ordering predicate, on both paths', () => {
    for (const make of [gt, gte, lt, lte]) {
      const pred = make(0);

      expect(specializePredicate(pred)?.(Number.NaN)).toBe(false);
      expect(matches(pred, Number.NaN)).toBe(false);
    }
  });

  it('a CROSS-TYPE value is filtered, not thrown, on both paths', () => {
    // The `typeof` guard in the specialization stands in for `cmpSameType` returning null -> NaN.
    for (const [pred, v] of [
      [gt(0), 'a'],
      [gt('a'), 0],
      [gte(0), true],
      [lt(0), LocalDate.parse('2020-01-01')],
      [lte('a'), [1]],
    ] as const) {
      expect(specializePredicate(pred)?.(v)).toBe(false);
      expect(matches(pred, v)).toBe(false);
    }
  });

  it('⚠️ `-0` and `0` are EQUAL under eq, on both paths', () => {
    // `===` says true for `-0 === 0`; `Object.is` would say false. A specialization written with
    // `Object.is` would pass every other test here and diverge on this one value.
    expect(specializePredicate(eq(0))?.(-0)).toBe(true);
    expect(matches(eq(0), -0)).toBe(true);
    expect(specializePredicate(neq(0))?.(-0)).toBe(false);
    expect(matches(neq(0), -0)).toBe(false);
  });

  it('⚠️ `NaN` is NOT equal to itself under eq, on both paths', () => {
    expect(specializePredicate(eq(Number.NaN))?.(Number.NaN)).toBe(false);
    expect(matches(eq(Number.NaN), Number.NaN)).toBe(false);
    expect(specializePredicate(neq(Number.NaN))?.(Number.NaN)).toBe(true);
    expect(matches(neq(Number.NaN), Number.NaN)).toBe(true);
  });

  it('⚠️ `neq` is TRUE for a MISSING value, on both paths', () => {
    // Not `value != null && …` — `neq` has no presence guard, so an absent key does not equal the
    // operand and therefore satisfies `neq`. A specialization that added a presence guard (copying
    // the ordering arms' shape) would flip this.
    expect(specializePredicate(neq(1))?.(undefined)).toBe(true);
    expect(matches(neq(1), undefined)).toBe(true);
    expect(specializePredicate(neq(1))?.(null)).toBe(true);
    expect(matches(neq(1), null)).toBe(true);
  });

  it('string ordering is lexicographic on both paths, including the empty string', () => {
    for (const [pred, v, want] of [
      [gt(''), 'a', true],
      [gt('a'), '', false],
      [lt('b'), 'a', true],
      [gte('a'), 'a', true],
      [lte('a'), 'b', false],
    ] as const) {
      expect(specializePredicate(pred)?.(v)).toBe(want);
      expect(matches(pred, v)).toBe(want);
    }
  });
});
