import { describe, expect, test } from 'bun:test';

import { Graph, LocalDate, LocalDateTime } from '@lenke/core';

import { query } from './index.js';

// Item 1049: `count(DISTINCT x)` became a left fold (`distinctCountFold`), which opened the
// streaming group path and the seeded hop walk to it — `count(DISTINCT e.amount)` over an indexed
// edge key went from 25.2 ms to 0.049.
//
// WHY THIS FILE EXISTS, AND IT IS A SURVIVING MUTANT. Replacing `valueKey(v)` with the raw value —
// so the Set dedups by REFERENCE IDENTITY and two value-equal temporals stop collapsing — passed
// all 2,866 tests. `temporal-group-key.test.ts` already covers that hazard, but only through
// `MATCH (p:P) RETURN count(DISTINCT p.t)`, which takes the dedicated `distinctCount` route and
// never reaches a fold. THE GROUPED SPELLING is what reaches `stepFolded`, and nothing exercised
// it with a value-equal container.
//
// That is the same shape as items 840, 841 and 843: a temporal arm shipping into a gap in the
// suite because the covering test took a different route to the same-looking question.

/** `P` nodes in two groups, each carrying `t` — so a GROUPED distinct count over `t` reaches the
 *  streaming fold rather than the node-scan route. */
const grouped = (vals: readonly unknown[]): Graph => {
  const g = new Graph();

  vals.forEach((t, i) => {
    // Two groups, so the path is genuinely the grouping one and not a single-bucket degenerate.
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { t, g: i % 2 === 0 ? 'a' : 'b' } });
  });

  return g;
};

const byGroup = (vals: readonly unknown[]): Record<string, unknown> => {
  const rows = query(
    grouped(vals),
    // `LET` first: GROUP BY takes a BOUND NAME, not an expression or an output alias.
    'MATCH (p:P) LET gk = p.g RETURN gk AS g, count(DISTINCT p.t) AS m GROUP BY gk',
  ) as Record<string, unknown>[];

  return Object.fromEntries(rows.map((r) => [String(r.g), r.m]));
};

describe('a GROUPED count(DISTINCT) folds and still keys by valueKey (item 1049)', () => {
  test('value-equal LocalDates collapse within their group', () => {
    // Group `a` gets indices 0 and 2 — the two EQUAL dates — so it must answer 1, not 2. Group `b`
    // gets index 1 alone and answers 1. Reference-identity dedup answers 2 for group `a`, which is
    // exactly the surviving mutant.
    expect(byGroup([new LocalDate(19_724), new LocalDate(19_725), new LocalDate(19_724)])).toEqual({
      a: 1,
      b: 1,
    });
  });

  test('DISTINCT values in one group do NOT collapse', () => {
    // The other failure direction: a key that collapses everything would answer 1 here. Indices 0
    // and 2 are DIFFERENT dates now, so group `a` must answer 2.
    expect(byGroup([new LocalDate(19_724), new LocalDate(19_725), new LocalDate(19_726)])).toEqual({
      a: 2,
      b: 1,
    });
  });

  test('LocalDateTime too, where a dropped field is the classic error', () => {
    expect(
      byGroup([
        new LocalDateTime(1_700_000_000, 0),
        new LocalDateTime(1_700_000_001, 0),
        new LocalDateTime(1_700_000_000, 0),
      ]),
    ).toEqual({ a: 1, b: 1 });
  });

  test('a value-equal LIST collapses — containers key structurally as well', () => {
    expect(byGroup([[1, 2], [3], [1, 2]])).toEqual({ a: 1, b: 1 });
  });

  test('NULLS are excluded, not counted as a distinct class', () => {
    // Both paths filter nullish before the fold; a fold that saw them would answer 2 for group `a`.
    expect(byGroup([null, 'x', 'y'])).toEqual({ a: 1, b: 1 });
  });

  test('a group whose every value is NULL counts 0', () => {
    expect(byGroup([null, 'x', null])).toEqual({ a: 0, b: 1 });
  });

  test('numbers and strings stay in disjoint key spaces', () => {
    // `valueKey` type-tags its primitives for this reason. Group `a` holds 1 and '1'.
    expect(byGroup([1, 'other', '1'])).toEqual({ a: 2, b: 1 });
  });
});
