import { describe, expect, it } from 'bun:test';

/**
 * ITEM 1491 — `cmpSameType` gained a DATE/DATE short-circuit, replacing four cross-module calls
 * (`isTemporal` twice, `temporalRelCmp`, `cmpNum`) with one `instanceof` pair and an inline
 * integer compare. Measured: the `has('d', gt(<date>))` arm 5.20 -> 3.17 ms (1.64x) and the
 * `order()` arm 15.51 -> 12.28 (1.26x) over 200,000 vertices, with every numeric control and the
 * temporal no-comparison control flat.
 *
 * ⚠️ THE RISK IS BYTE-IDENTITY, NOT SPEED. The new branch has to reproduce `cmpNum(a.days, b.days)`
 * exactly, and `cmpNum` is NOT the same function as the number/number branch directly above it:
 * `cmpNum` tests `<` then `>` and falls through to 0, so a `NaN` day count compares EQUAL to
 * everything, where a NaN *number* returns NaN (unordered, matching no ordering predicate). Both
 * behaviours are deliberate and they differ. Every test below exists to pin one of them.
 */
import { LocalDate, LocalDateTime, LocalTime } from '@lenke/core';
import { Graph } from '@lenke/core';

import {
  V,
  between,
  count,
  gt,
  gte,
  has,
  lt,
  lte,
  order,
  toArray,
  traversal,
  values,
} from './index.js';
import { compareValues } from './predicates.js';

const d = (iso: string): LocalDate => LocalDate.parse(iso);

describe('the date fast path orders exactly as the generic chain did', () => {
  it('orders two dates by day count', () => {
    expect(compareValues(d('2020-01-01'), d('2020-01-02'))).toBe(-1);
    expect(compareValues(d('2020-01-02'), d('2020-01-01'))).toBe(1);
    expect(compareValues(d('2020-01-01'), d('2020-01-01'))).toBe(0);
  });

  it('orders across epoch, where the day count is negative', () => {
    expect(compareValues(d('1969-12-31'), d('1970-01-01'))).toBe(-1);
    expect(compareValues(d('1900-01-01'), d('2100-01-01'))).toBe(-1);
    expect(new LocalDate(-1).days).toBe(-1);
  });

  it('returns -1/0/1 EXACTLY, not an arbitrary difference', () => {
    // `cmpNum` normalizes; a `a.days - b.days` implementation would return 365 here and the
    // predicates would still pass, while `order()`'s comparator contract and the byte-identity
    // fuzzers would see different numbers.
    expect(compareValues(d('2020-01-01'), d('2021-01-01'))).toBe(-1);
    expect(compareValues(d('2021-01-01'), d('2020-01-01'))).toBe(1);
  });

  it('⚠️ a NaN day count compares EQUAL, not unordered — unlike a NaN number', () => {
    // `new LocalDate(NaN)` is constructible (the constructor checks the ARGUMENT COUNT, not the
    // value), so this is reachable. `cmpNum` falls through to 0 for it. The number/number branch
    // immediately above the fast path returns NaN for a NaN operand instead, deliberately. If the
    // fast path were written with that behaviour the two would diverge.
    const nan = new LocalDate(Number.NaN);

    expect(compareValues(nan, d('2020-01-01'))).toBe(0);
    expect(compareValues(d('2020-01-01'), nan)).toBe(0);
    expect(compareValues(nan, nan)).toBe(0);
    // And the contrast it must NOT copy:
    expect(Number.isNaN(compareValues(Number.NaN, 1))).toBe(true);
  });

  it('a DATE against another temporal KIND is still incomparable — IN BOTH ORDERS', () => {
    // The fast path must not claim a pair it cannot order; these fall through to the generic
    // branch, where `temporalRelCmp` returns null and `compareValues` throws.
    //
    // ⚠️ BOTH ORDERS, BECAUSE ONE DIRECTION IS BLIND. A mutant widening the guard to
    // `isTemporal(a) && b instanceof LocalDate` survived the date-first assertions alone: with a
    // date on the LEFT the mutated guard is false and the generic branch still runs. With the
    // date on the RIGHT it fires, reads `a.days` off a `LocalTime` (undefined), and both
    // comparisons against `undefined` are false — so it returns 0 and two incomparable temporals
    // silently order EQUAL. A comparator's guard has two operands and a test for it needs two.
    for (const other of [new LocalTime(0, 0), new LocalDateTime(0, 0)]) {
      expect(() => compareValues(d('2020-01-01'), other)).toThrow();
      expect(() => compareValues(other, d('2020-01-01'))).toThrow();
    }
  });

  it('a DATE against a scalar is still incomparable — in both orders', () => {
    for (const other of [0, 'x', true]) {
      expect(() => compareValues(d('2020-01-01'), other)).toThrow();
      expect(() => compareValues(other, d('2020-01-01'))).toThrow();
    }
  });

  it('the NON-date branches are untouched', () => {
    expect(compareValues(1, 2)).toBe(-1);
    expect(compareValues('a', 'b')).toBe(-1);
    expect(compareValues(false, true)).toBe(-1);
    expect(compareValues(new LocalTime(1, 0), new LocalTime(2, 0))).toBe(-1);
    expect(compareValues(new LocalDateTime(1, 0), new LocalDateTime(2, 0))).toBe(-1);
  });
});

const fixture = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 30; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { ord: i, d: { '@date': `2020-01-${String(i + 1).padStart(2, '0')}` } },
    });
  }

  return g;
};

describe('the traversal surface answers identically through the fast path', () => {
  const g = fixture();
  const cut = d('2020-01-16');

  it('every ordering predicate selects the same set as its numeric twin', () => {
    for (const [name, tPlan, nPlan] of [
      [
        'gt',
        traversal(V(), has('d', gt(cut)), count()),
        traversal(V(), has('ord', gt(15)), count()),
      ],
      [
        'gte',
        traversal(V(), has('d', gte(cut)), count()),
        traversal(V(), has('ord', gte(15)), count()),
      ],
      [
        'lt',
        traversal(V(), has('d', lt(cut)), count()),
        traversal(V(), has('ord', lt(15)), count()),
      ],
      [
        'lte',
        traversal(V(), has('d', lte(cut)), count()),
        traversal(V(), has('ord', lte(15)), count()),
      ],
      [
        'between',
        traversal(V(), has('d', between(d('2020-01-06'), d('2020-01-11'))), count()),
        traversal(V(), has('ord', between(5, 10)), count()),
      ],
    ] as const) {
      expect(toArray(tPlan, g), name).toEqual(toArray(nPlan, g));
    }
  });

  it('order() over dates yields them chronologically', () => {
    const got = toArray(traversal(V(), values('d'), order()), g);

    expect(got.length).toBe(30);
    expect(JSON.stringify(got[0])).toBe(JSON.stringify({ '@date': '2020-01-01' }));
    expect(JSON.stringify(got[29])).toBe(JSON.stringify({ '@date': '2020-01-30' }));

    // And the order is the numeric order of the same ordinals, element by element — the check that
    // a wrong sign in the fast path would fail while the endpoints above still passed.
    const nums = toArray(traversal(V(), values('ord'), order()), g);

    expect(nums).toEqual([...Array(30).keys()]);
    expect(got.map((x) => JSON.stringify(x))).toEqual(
      nums.map((n) =>
        JSON.stringify({ '@date': `2020-01-${String(Number(n) + 1).padStart(2, '0')}` }),
      ),
    );
  });

  it('a cross-kind has() FILTERS rather than throwing — TinkerPop semantics, both orders', () => {
    // `predCmp` turns the null into NaN so no ordering predicate matches. A fast path that threw
    // for a pair it could not order would break this; one that CLAIMED the pair would match
    // everything instead of nothing.
    expect(toArray(traversal(V(), has('d', gt(new LocalTime(0, 0))), count()), g)).toEqual([0]);
    // The reverse operand order, reached by comparing a TIME property against a date.
    const h = new Graph();

    h.addVertex({ id: 't0', labels: ['P'], properties: { t: { '@localtime': '12:00:00' } } });
    expect(toArray(traversal(V(), has('t', gt(d('2020-01-01'))), count()), h)).toEqual([0]);
    expect(toArray(traversal(V(), has('t', lt(d('2020-01-01'))), count()), h)).toEqual([0]);
  });
});
