import { describe, expect, test } from 'bun:test';

import {
  Duration,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZonedDateTime,
  ZonedTime,
  isTemporal,
} from './index.js';

/**
 * `isTemporal`'s own tests, which it did not have (item 1393).
 *
 * The predicate gained a `typeof v === 'object' && v !== null` early-out, worth **12.4% of the
 * `point` row (144/144 concordance)** because the six `instanceof`s it short-circuits were running
 * for nearly every value the engine compares. 370 core tests covered it only INDIRECTLY, and the
 * failure mode of a wrong guard is silent rather than loud: a temporal misclassified as
 * non-temporal does not throw, it takes the other comparison branch — and this repo's cross-type
 * comparison policy (string-vs-temporal `=` is no-match, `<=` throws) is settled behaviour that
 * would quietly change.
 *
 * So both directions are pinned: every one of the six types must be recognised, and the values the
 * guard now rejects early must still be rejected.
 */
describe('isTemporal recognises all six temporal types (item 1393)', () => {
  test('LocalDate', () => {
    expect(isTemporal(LocalDate.of(2026, 11, 4))).toBe(true);
  });

  test('LocalTime', () => {
    expect(isTemporal(LocalTime.parse('12:34:56'))).toBe(true);
  });

  test('LocalDateTime', () => {
    expect(isTemporal(LocalDateTime.parse('2026-11-04T12:34:56'))).toBe(true);
  });

  test('ZonedDateTime', () => {
    expect(isTemporal(ZonedDateTime.parse('2026-11-04T12:34:56+01:00'))).toBe(true);
  });

  test('ZonedTime', () => {
    expect(isTemporal(ZonedTime.parse('12:34:56+01:00'))).toBe(true);
  });

  test('Duration', () => {
    expect(isTemporal(Duration.parse('P1D'))).toBe(true);
  });
});

describe('isTemporal rejects what the typeof guard short-circuits (item 1393)', () => {
  // THE GUARD'S OWN CASES. Each of these now exits on one `typeof` instead of six `instanceof`s,
  // so each is a value whose classification the early-out is solely responsible for.
  test('numbers, including the ones a graph actually stores', () => {
    expect(isTemporal(0)).toBe(false);
    expect(isTemporal(42)).toBe(false);
    expect(isTemporal(-1.5)).toBe(false);
    expect(isTemporal(Number.NaN)).toBe(false);
    expect(isTemporal(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test('strings, including ones that LOOK temporal', () => {
    expect(isTemporal('')).toBe(false);
    expect(isTemporal('2026-11-04')).toBe(false);
    expect(isTemporal('P1D')).toBe(false);
  });

  test('booleans', () => {
    expect(isTemporal(true)).toBe(false);
    expect(isTemporal(false)).toBe(false);
  });

  // ⚠️ `v !== null` IS NOT LOAD-BEARING FOR CORRECTNESS, and mutation testing said so: dropping it
  // leaves all 13 tests green, because `typeof null === 'object'` lets null through to
  // `null instanceof LocalDate`, which is false anyway. I had written the opposite here before
  // running the mutant.
  //
  // It stays as a PERFORMANCE guard, and that distinction is worth the line: this engine treats
  // null as a stored, present value, so nulls reach comparisons routinely — and without this half
  // every one of them pays all six `instanceof`s, which is the cost item 1393 exists to remove.
  // The tests below pin the behaviour either way.
  test('null and undefined', () => {
    expect(isTemporal(null)).toBe(false);
    expect(isTemporal(undefined)).toBe(false);
  });

  test('ordinary objects and arrays, which ARE objects and must still be rejected', () => {
    expect(isTemporal({})).toBe(false);
    expect(isTemporal([])).toBe(false);
    expect(isTemporal({ year: 2026, month: 11, day: 4 })).toBe(false);
    expect(isTemporal(new Date())).toBe(false);
  });

  // A FUNCTION is `typeof 'function'`, not `'object'`, so the guard rejects it on the first test.
  // No temporal type is callable, which is what makes that sound.
  test('functions and symbols', () => {
    expect(isTemporal(() => LocalDate.of(2026, 11, 4))).toBe(false);
    expect(isTemporal(LocalDate)).toBe(false);
    expect(isTemporal(Symbol('x'))).toBe(false);
  });

  test('a DUCK-TYPED near-miss is not temporal, which is the point of instanceof', () => {
    // Objects that pass the `typeof` guard and must be rejected by the `instanceof` chain behind
    // it. A forged `constructor` is the sharper case: `instanceof` consults the PROTOTYPE CHAIN, so
    // naming the class proves nothing.
    expect(isTemporal({ constructor: LocalDate, year: 2026, month: 11, day: 4 })).toBe(false);
    expect(isTemporal(Object.create(null) as object)).toBe(false);
  });
});
