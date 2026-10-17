// The five ISO aggregates that had NO scan rung: `collect` / `collect_list`, `stddev_pop`,
// `stddev_samp`, `percentile_cont` and `percentile_disc`. Priced as an enum — all eleven names,
// the same scan, the same argument — six took the rung and these five fell to the general path,
// which materializes a group of BINDINGS and maps each through the argument (item 530).
//
// They reach `aggregateOverValues`, the ONE shared implementation the general path also calls, so
// the arithmetic is identical by construction rather than by replication. What a test still has
// to pin is the ORDER (a `collect` list's order is its bytes), the percentile FRACTION, and the
// nullish rule.
//
// Every case is asked twice: admitted, and with `WHERE n.age >= 0` appended — true for every
// vertex here, but enough to make `unfilteredScan` false so the rung declines and the general
// path answers the same question.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  // Ascending ids but DESCENDING ages, so a `collect` list that came back in the wrong order is
  // visible rather than coincidentally right.
  g.addVertex({ id: 'a', labels: ['P'], properties: { age: 40, s: 'x' } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { age: 30, s: 'y' } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { age: 20, s: 'z' } });
  g.addVertex({ id: 'd', labels: ['P'], properties: { age: 10 } });
  // NO `age` at all: the nullish rule drops it from every one of these.
  g.addVertex({ id: 'e', labels: ['P'], properties: { s: 'w' } });
  g.addVertex({ id: 'q', labels: ['Q'], properties: { age: 99 } });

  return g;
};

const g = build();

/** The rung's answer and the general path's, for the same question. */
const both = (expr: string, label = 'P'): unknown => {
  const q = `MATCH (n:${label}) RETURN ${expr} AS m`;
  const one = (query(g, q)[0] as Record<string, unknown>).m;
  // `WHERE true` keeps EVERY row while making `unfilteredScan` false, so the rung declines and
  // the general path answers the identical question.
  //
  // The first version used `WHERE n.age >= 0`, which is UNKNOWN for the one vertex with no
  // `age` — so it dropped that row and `collect(n.s)` came back one element short. The twin
  // caught it, which is the twin doing its job: a declining twin that asks a DIFFERENT question
  // is worse than none, because it reads as a divergence in the code under test.
  const twin = `MATCH (n:${label}) WHERE true RETURN ${expr} AS m`;

  expect(JSON.stringify((query(g, twin)[0] as Record<string, unknown>).m)).toBe(
    JSON.stringify(one),
  );

  return one;
};

describe('the values-aggregate scan rung (item 530)', () => {
  test('collect keeps the scan ORDER, which is the whole observable part of it', () => {
    expect(both('collect(n.age)')).toEqual([40, 30, 20, 10]);
    expect(both('collect_list(n.age)')).toEqual([40, 30, 20, 10]);
    // Strings, and a vertex missing the key, so the nullish drop is visible in the LENGTH.
    expect(both('collect(n.s)')).toEqual(['x', 'y', 'z', 'w']);
    expect(both('collect(n.age)', 'Q')).toEqual([99]);
    // A key nothing carries collects nothing — an empty list, not a list of nulls.
    expect(both('collect(n.nope)')).toEqual([]);
  });

  test('the standard deviations', () => {
    // Population over 40/30/20/10: mean 25, variance 125, sqrt = 11.180339887498949.
    expect(both('stddev_pop(n.age)')).toBeCloseTo(11.180339887498949, 12);
    // Sample: variance 166.66…, sqrt = 12.909944487358056.
    expect(both('stddev_samp(n.age)')).toBeCloseTo(12.909944487358056, 12);
    // ISO's empty / single-row answers: `pop` is null over 0 rows, `samp` over fewer than 2.
    expect(both('stddev_pop(n.nope)')).toBeNull();
    expect(both('stddev_samp(n.age)', 'Q')).toBeNull();
    expect(both('stddev_pop(n.age)', 'Q')).toBe(0);
  });

  test('the percentiles, and the FRACTION the rung has to carry', () => {
    // Four values 10/20/30/40 sorted. The fraction is what distinguishes these calls, so a
    // rung that dropped it would answer every one of them the same.
    expect(both('percentile_disc(n.age, 0)')).toBe(10);
    // ISO's DISC picks the smallest value whose cumulative distribution reaches the
    // fraction: ceil(0.5 x 4) = 2, so the second of 10/20/30/40. Checked against the NATIVE
    // engine, which answers 20 too — the first version of this line guessed 30.
    expect(both('percentile_disc(n.age, 0.5)')).toBe(20);
    expect(both('percentile_disc(n.age, 1)')).toBe(40);
    expect(both('percentile_cont(n.age, 0)')).toBe(10);
    expect(both('percentile_cont(n.age, 0.5)')).toBe(25);
    expect(both('percentile_cont(n.age, 1)')).toBe(40);
    // OUT OF RANGE is clamped, and the clamp has to be the same one `compileAggregate` applies.
    // `2` clamps to the maximum in BOTH engines — native used to PANIC here (`index out of
    // bounds` in the `cont` interpolation) and item 530 clamps it at the point of use.
    expect(both('percentile_cont(n.age, 2)')).toBe(40);
    expect(both('percentile_disc(n.age, 2)')).toBe(40);
    // A NEGATIVE fraction is a REFUSAL in this engine, not a clamp: `-1` is a unary-minus
    // expression rather than a literal token, so `compileAggregate` raises before any value is
    // read. Native accepts it and clamps to the minimum — an open cross-engine divergence on an
    // input ISO does not define, recorded rather than papered over.
    expect(() => query(g, 'MATCH (n:P) RETURN percentile_cont(n.age, -1) AS m')).toThrow();
  });

  test('the shapes the rung must refuse are unchanged', () => {
    const m = (q: string): unknown => (query(g, q)[0] as Record<string, unknown>).m;

    // DISTINCT needs every value kept apart, so it is refused and still right.
    expect(m('MATCH (n:P) RETURN collect(DISTINCT n.age) AS m')).toEqual([40, 30, 20, 10]);
    // A non-literal fraction is a data exception, raised by the general path exactly as before.
    expect(() => m('MATCH (n:P) RETURN percentile_cont(n.age, n.age) AS m')).toThrow();
    // Wrong arity, both ways.
    expect(() => m('MATCH (n:P) RETURN percentile_cont(n.age) AS m')).toThrow();
    // NOT a throw, in EITHER engine: only the percentiles validate their arity, so a second
    // argument to `stddev_pop` is accepted and ignored. Verified against native (which answers
    // 11.180339887498949 for both spellings) rather than assumed, and pinned here because the
    // rung REFUSES the two-argument form, so the general path is what answers it.
    expect(m('MATCH (n:P) RETURN stddev_pop(n.age, 1) AS m')).toBeCloseTo(11.180339887498949, 12);
    // GROUP BY leaves the single-aggregate shape entirely.
    expect((query(g, 'MATCH (n:P) RETURN n.age AS k, collect(n.s) AS m') as unknown[]).length).toBe(
      5,
    );
  });

  test('two aggregates in one projection take the multi-item path', () => {
    const row = query(
      g,
      'MATCH (n:P) RETURN collect(n.age) AS m, stddev_pop(n.age) AS s',
    )[0] as Record<string, unknown>;

    expect(row.m).toEqual([40, 30, 20, 10]);
    expect(row.s).toBeCloseTo(11.180339887498949, 12);

    const twin = query(
      g,
      'MATCH (n:P) WHERE true RETURN collect(n.age) AS m, stddev_pop(n.age) AS s',
    )[0] as Record<string, unknown>;

    expect(JSON.stringify(twin)).toBe(JSON.stringify(row));
  });
});
