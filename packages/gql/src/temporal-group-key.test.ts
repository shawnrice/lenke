import { describe, expect, test } from 'bun:test';

import {
  Duration,
  Graph,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZonedDateTime,
  ZonedTime,
} from '@lenke/core';

import { query } from './index.js';

// Item 843: `valueKey`'s TEMPORAL arm, which keys a temporal off its own fields instead of
// through `JSON.stringify`. `count(DISTINCT <date>)` over 200,000 rows cost 81.3 ms against 4.2
// for the same query over a number — 19.5x, and 15.6x against a STRING column, so it was a
// stringify per row rather than "non-numeric is slower". PRE 80.6 -> POST 19.3, 4.17x, disjoint.
//
// THESE TESTS EXIST BECAUSE NOTHING COVERED THE SHAPE. A mutant reducing `LocalDate`'s key to a
// constant — collapsing EVERY date into one DISTINCT group — passed all 2,635 tests. That is the
// third time in four items that a temporal arm shipped into a gap in the suite (items 840 and 841
// found the same thing in the Rust engine), so the cases below are built to catch a DROPPED FIELD
// and a SHARED PREFIX, which are the two ways a hand-written key goes wrong.
const one = (g: Graph, q: string): unknown => {
  const rows = query(g, q) as Record<string, unknown>[];

  return rows[0]?.m;
};

/** A graph whose `P` nodes carry `t` = each of `vals`, so DISTINCT over `t` counts the classes. */
const withValues = (vals: readonly unknown[]): Graph => {
  const g = new Graph();

  vals.forEach((t, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { t, n: i } });
  });

  return g;
};

const distinctCount = (vals: readonly unknown[]): unknown =>
  one(withValues(vals), 'MATCH (p:P) RETURN count(DISTINCT p.t) AS m');

describe('temporal values as a DISTINCT / GROUP BY key (item 843)', () => {
  test('a duplicate collapses and distinct values do not — every kind', () => {
    // Each case holds THREE values of one kind where exactly two are equal, so the answer is 2.
    // A key that drops a field would answer 1; a key that distinguishes equal values would
    // answer 3. Both failure directions are therefore visible.
    expect(
      distinctCount([new LocalDate(19_724), new LocalDate(19_725), new LocalDate(19_724)]),
    ).toBe(2);
    expect(
      distinctCount([new LocalTime(3600, 0), new LocalTime(3601, 0), new LocalTime(3600, 0)]),
    ).toBe(2);
    expect(
      distinctCount([
        new LocalDateTime(1_700_000_000, 0),
        new LocalDateTime(1_700_000_001, 0),
        new LocalDateTime(1_700_000_000, 0),
      ]),
    ).toBe(2);
    expect(
      distinctCount([
        new ZonedDateTime(1_700_000_000, 0, 60),
        new ZonedDateTime(1_700_000_000, 0, 120),
        new ZonedDateTime(1_700_000_000, 0, 60),
      ]),
    ).toBe(2);
    expect(
      distinctCount([
        new ZonedTime(3600, 0, 60),
        new ZonedTime(3600, 0, 120),
        new ZonedTime(3600, 0, 60),
      ]),
    ).toBe(2);
    expect(
      distinctCount([new Duration(1, 2, 3, 4), new Duration(1, 2, 3, 5), new Duration(1, 2, 3, 4)]),
    ).toBe(2);
  });

  // ONE FIELD AT A TIME. The test above varies a single field per kind, but only one of them —
  // so a key that drops a DIFFERENT field would still pass it. Here every field of every
  // multi-field kind is the sole difference in its own pair, which is what makes a dropped field
  // impossible to miss.
  test('each field alone distinguishes two values', () => {
    expect(distinctCount([new LocalTime(3600, 0), new LocalTime(3600, 1)])).toBe(2);
    expect(distinctCount([new LocalDateTime(10, 0), new LocalDateTime(10, 1)])).toBe(2);
    expect(distinctCount([new ZonedDateTime(10, 0, 0), new ZonedDateTime(10, 1, 0)])).toBe(2);
    expect(distinctCount([new ZonedDateTime(10, 0, 0), new ZonedDateTime(10, 0, 30)])).toBe(2);
    expect(distinctCount([new ZonedTime(10, 0, 0), new ZonedTime(10, 1, 0)])).toBe(2);
    expect(distinctCount([new ZonedTime(10, 0, 0), new ZonedTime(10, 0, 30)])).toBe(2);
    expect(distinctCount([new Duration(0, 0, 0, 0), new Duration(1, 0, 0, 0)])).toBe(2);
    expect(distinctCount([new Duration(0, 0, 0, 0), new Duration(0, 1, 0, 0)])).toBe(2);
    expect(distinctCount([new Duration(0, 0, 0, 0), new Duration(0, 0, 1, 0)])).toBe(2);
    expect(distinctCount([new Duration(0, 0, 0, 0), new Duration(0, 0, 0, 1)])).toBe(2);
  });

  // A SHARED PREFIX is the other way a hand-written key goes wrong, and it is invisible to every
  // case above because each of those holds ONE kind. `LocalTime` and `LocalDateTime` carry the
  // same two fields, so with one prefix between them these two values would collapse into one
  // group while being different values of different types.
  test('two kinds with identical fields stay apart', () => {
    expect(distinctCount([new LocalTime(3600, 7), new LocalDateTime(3600, 7)])).toBe(2);
    expect(distinctCount([new ZonedTime(3600, 7, 60), new ZonedDateTime(3600, 7, 60)])).toBe(2);
    // A `Duration` whose `days` equals a `LocalDate`'s, which is the pair that shares a field NAME
    // rather than a shape.
    expect(distinctCount([new LocalDate(5), new Duration(0, 5, 0, 0)])).toBe(2);
  });

  test('DISTINCT rows and GROUP BY agree with the count', () => {
    const g = withValues([new LocalDate(1), new LocalDate(2), new LocalDate(1)]);

    expect((query(g, 'MATCH (p:P) RETURN DISTINCT p.t AS m') as unknown[]).length).toBe(2);

    // GROUP BY the temporal: two groups, of two rows and one.
    const groups = query(
      g,
      'MATCH (p:P) LET k = p.t RETURN k, count(*) AS m GROUP BY k ORDER BY m',
    ) as Record<string, unknown>[];

    expect(groups.map((r) => r.m)).toEqual([1, 2]);
  });

  test('a non-finite field keeps the JSON.stringify classing', () => {
    // `temporalKey` returns `undefined` for a non-finite field so the stringify fallback keeps
    // its exact grouping. `JSON.stringify` renders both `NaN` and `Infinity` as `null`, so these
    // two collapse into ONE group — preserved deliberately rather than improved, because this
    // item is a speedup and not a semantics change.
    expect(
      distinctCount([new LocalDate(Number.NaN), new LocalDate(Number.POSITIVE_INFINITY)]),
    ).toBe(1);
    // …and a non-finite value is still distinct from a finite one.
    expect(distinctCount([new LocalDate(Number.NaN), new LocalDate(5)])).toBe(2);
  });
});
