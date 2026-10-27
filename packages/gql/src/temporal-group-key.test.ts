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

  // THE TALLY, which is a DIFFERENT CODE PATH from everything above and was uncovered.
  //
  // `count(DISTINCT t)` goes through `valueSet`; `RETURN t, count(*)` goes through `groupIndex`.
  // They are separate containers with separate per-kind branches, and item 1014 found that out
  // the way this file says these bugs are found: a mutant that dropped `nanos` from
  // `groupIndex`'s datetime key passed all five tests here, while the same mutation in
  // `valueSet` failed two of them. One shape, two implementations, one of them untested.
  const groupCount = (vals: readonly unknown[]): number =>
    (query(withValues(vals), 'MATCH (p:P) RETURN p.t AS k, count(*) AS c') as unknown[]).length;

  test('the GROUP BY tally splits the same values the DISTINCT set does', () => {
    // Each pair differs in ONE field, as above — a dropped field would answer 1, and a key that
    // fails to MATCH equal values (the `get`-side mutation) would answer more than the pair size.
    expect(groupCount([new LocalTime(3600, 0), new LocalTime(3600, 1)])).toBe(2);
    expect(groupCount([new LocalTime(3600, 0), new LocalTime(3601, 0)])).toBe(2);
    expect(groupCount([new LocalDateTime(10, 0), new LocalDateTime(10, 1)])).toBe(2);
    expect(groupCount([new LocalDateTime(10, 0), new LocalDateTime(11, 0)])).toBe(2);
    expect(groupCount([new ZonedDateTime(10, 0, 0), new ZonedDateTime(10, 0, 30)])).toBe(2);
    expect(groupCount([new Duration(0, 0, 0, 0), new Duration(0, 0, 0, 1)])).toBe(2);
    // DUPLICATES COLLAPSE — the direction the pairs above cannot show. Three rows, two values.
    expect(
      groupCount([new LocalDateTime(10, 7), new LocalDateTime(10, 8), new LocalDateTime(10, 7)]),
    ).toBe(2);
    expect(groupCount([new LocalTime(10, 7), new LocalTime(10, 8), new LocalTime(10, 7)])).toBe(2);
    // ...and the counts themselves, so a tally that opens a fresh slot per row is visible even
    // when the group COUNT happens to come out right.
    const rows = query(
      withValues([new LocalDateTime(10, 7), new LocalDateTime(10, 7), new LocalDateTime(10, 8)]),
      'MATCH (p:P) RETURN p.t AS k, count(*) AS c',
    ) as Record<string, unknown>[];

    expect(rows.map((r) => r.c).sort()).toEqual([1, 2]);
  });

  test('two kinds with identical fields stay apart in the TALLY too', () => {
    expect(groupCount([new LocalTime(3600, 7), new LocalDateTime(3600, 7)])).toBe(2);
    expect(groupCount([new LocalDate(5), new Duration(0, 5, 0, 0)])).toBe(2);
    expect(groupCount([new LocalTime(5, 0), 5])).toBe(2);
  });

  // A COLLISION ACROSS THE RAW-KEYED CONTAINERS, which the pairs above cannot reach because the
  // numbers they use are small. A `LocalTime`'s key is `secs * 1e9 + nanos` and a `LocalDate`'s
  // is `days`, both plain numbers — so the two kinds collide iff they share ONE map, and the day
  // count that collides with `LocalTime(5, 0)` is 5e9 rather than 5. A mutant pointing the time
  // map at the date map survived every other case in this file (item 1014).
  test('a date and a time whose RAW KEYS coincide stay apart', () => {
    expect(distinctCount([new LocalDate(5_000_000_000), new LocalTime(5, 0)])).toBe(2);
    expect(groupCount([new LocalDate(5_000_000_000), new LocalTime(5, 0)])).toBe(2);
  });

  // THE FINITE GUARD, which is load-bearing and not belt-and-braces. `secs * 1e9 + nanos` is
  // `NaN` or `Infinity` whenever either field is, so raw keying would put EVERY non-finite time
  // in one group; `valueKey` reaches these through its structural path, where the finite field
  // still separates them. Removing `Number.isFinite` from the time key passed all nine other
  // tests here (item 1014) — it is this pair that fails, answering 1.
  test('a non-finite field does not collapse values their finite fields separate', () => {
    expect(distinctCount([new LocalTime(1, Infinity), new LocalTime(2, Infinity)])).toBe(2);
    expect(groupCount([new LocalTime(1, Infinity), new LocalTime(2, Infinity)])).toBe(2);
    expect(
      distinctCount([new LocalDateTime(1, Number.NaN), new LocalDateTime(2, Number.NaN)]),
    ).toBe(2);
    expect(groupCount([new LocalDateTime(1, Number.NaN), new LocalDateTime(2, Number.NaN)])).toBe(
      2,
    );
  });

  // THE OTHER DIRECTION OF THE SAME GUARD, and the case that caught a mutant the four above did
  // not: when the non-finite field is the one the raw key would key OUTERMOST, dropping the
  // guard SEPARATES values that `valueKey` collapses. `JSON.stringify` renders `NaN` and
  // `Infinity` both as `null`, so these two datetimes are ONE group — item 843 chose to keep that
  // collapse bit-for-bit rather than "improve" it inside a speedup, and this is that decision
  // still holding. A `dateTimeKeyable` stubbed to `true` answers 2 here and passes every other
  // test in this file (item 1014).
  //
  // `LocalTime` is NOT asserted alongside it: the same pair of times answers 2 today, through a
  // path neither item changed. That asymmetry between the kinds is pre-existing and is recorded
  // rather than altered here, since changing it inside a performance item is exactly what 843
  // declined to do.
  // THE ZONED GUARDS (item 1018), which are the direction a `true`-stubbed guard breaks.
  test('a non-finite zoned field keeps the fallback grouping, in both directions', () => {
    // NON-FINITE OFFSET: the fallback renders it in a form that swallows the rest, so these two
    // ZonedDateTimes are ONE group despite differing `secs`. Measured, not assumed — the same
    // asymmetry item 1017 found on the Gremlin path. Raw keying would SPLIT them, so a guard
    // stubbed to `true` answers 2 and passes every other test in this file.
    const offsetPair = [new ZonedDateTime(1, 0, Number.NaN), new ZonedDateTime(2, 0, Number.NaN)];

    expect(distinctCount(offsetPair)).toBe(1);
    expect(groupCount(offsetPair)).toBe(1);
    // NON-FINITE NANOS goes the other way: the finite `secs` still separates them, so two.
    const nanosPair = [new ZonedTime(1, Number.NaN, 60), new ZonedTime(2, Number.NaN, 60)];

    expect(distinctCount(nanosPair)).toBe(2);
    expect(groupCount(nanosPair)).toBe(2);
    // AND THE PACKING BOUND. `zonedTailKey` packs `(nanos, offset)` into one number and declines
    // an offset outside ±2^20 minutes rather than letting it overflow into the `nanos` field.
    // These two differ ONLY in an offset past that bound, so they must stay apart through the
    // fallback — a packing that silently wrapped would merge them.
    const hugePair = [new ZonedDateTime(1, 0, 2 ** 21), new ZonedDateTime(1, 0, 2 ** 22)];

    expect(distinctCount(hugePair)).toBe(2);
    expect(groupCount(hugePair)).toBe(2);
    // ...and the pair that shows WHY the bound is 2^20 and not merely "large". The packing is
    // `nanos * 2 ** 21 + (offset + 2 ** 20)`, so the additive term must stay under 2^21 or it
    // carries into the `nanos` field. These two values differ in `nanos` and in `offset` by
    // exactly the amount that cancels under a widened bound: with the guard at 2^20 the second
    // is DECLINED and reaches the fallback, so they are two groups; with the bound widened both
    // are packed and collide into one. The previous pair cannot show this, because `nanos = 0`
    // leaves nothing for the offset to carry into — a mutant widening the bound survived it.
    const carryPair = [new ZonedDateTime(1, 1, 0), new ZonedDateTime(1, 0, 2 ** 21)];

    expect(distinctCount(carryPair)).toBe(2);
    expect(groupCount(carryPair)).toBe(2);
  });

  test('two non-finite datetimes collapse, as valueKey has them', () => {
    const pair = [new LocalDateTime(Number.NaN, 0), new LocalDateTime(Number.POSITIVE_INFINITY, 0)];

    expect(distinctCount(pair)).toBe(1);
    expect(groupCount(pair)).toBe(1);
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
    // A `LocalDate` beside the RAW NUMBER its `days` equals (item 850). `valueSet`/`groupIndex`
    // key a finite date on `days` in their own container precisely so this pair cannot collide;
    // keying it into the primitive set instead would merge a date with an unrelated integer, and
    // nothing else in this file would notice.
    expect(distinctCount([new LocalDate(5), 5])).toBe(2);
    expect(distinctCount([5, new LocalDate(5)])).toBe(2);
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
