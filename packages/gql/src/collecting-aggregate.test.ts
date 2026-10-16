import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 468: `sum`/`avg` on an UNFILTERED scan stream their argument's VALUES and hand them to
// the same `aggregateOverValues` the general path runs — 43.7-48.0 ms to 12.6-13.8 at 200,000
// nodes (3.5x), because the general path otherwise keeps a group of BINDINGS and maps each
// through the argument.
//
// They are not folds and cannot be: `sum` picks its operation by looking at the WHOLE
// collection (item 467). That is exactly why this reuses the general function rather than
// reimplementing one — the temporal and array cases below are the part a hand-written fold
// would have got wrong, and they pass because there is only one implementation.
describe('a collecting aggregate on an unfiltered scan (item 468)', () => {
  const nums = (): Graph => {
    const g = new Graph();

    // DUPLICATE values (two 2s), so `sum(DISTINCT a.k)` differs from `sum(a.k)` — 13 against
    // 15. Without a duplicate the DISTINCT guard is vacuous and the mutant admitting it
    // SURVIVES, which is what the first version of this fixture did.
    for (const k of [0, 1, 2, 2, 5, 7]) {
      g.addVertex({ labels: ['P'], properties: { k } });
    }

    // No `k`, so the nullish filter is exercised: it must be skipped, not summed as 0 and not
    // counted in the `avg` divisor.
    g.addVertex({ labels: ['P'], properties: {} });

    return g;
  };

  test('sum and avg over an unfiltered scan', () => {
    const g = nums();

    expect(query(g, 'MATCH (a:P) RETURN sum(a.k) AS m')).toEqual([{ m: 17 }]);
    // 17 over SIX values, not seven: the row without `k` is filtered before the divisor.
    expect(query(g, 'MATCH (a:P) RETURN avg(a.k) AS m')).toEqual([{ m: 17 / 6 }]);
  });

  test('an empty scan gives sum 0 and avg null', () => {
    const g = new Graph();

    g.addVertex({ labels: ['Other'], properties: { k: 1 } });

    expect(query(g, 'MATCH (a:P) RETURN sum(a.k) AS m')).toEqual([{ m: 0 }]);
    expect(query(g, 'MATCH (a:P) RETURN avg(a.k) AS m')).toEqual([{ m: null }]);
  });

  test('a DURATION sum folds, and a non-numeric group THROWS', () => {
    const g = new Graph();

    g.addVertex({ labels: ['D'], properties: { d: 'PT1H' } });
    g.addVertex({ labels: ['D'], properties: { d: 'PT30M' } });

    // The two-pass part: a temporal ANYWHERE selects `temporalSum` for the whole group. A
    // streaming fold could not have decided this until the last value, which is item 467.
    //
    // Compared against the DECLINING spelling over the same rows rather than against a literal:
    // `a.d IS NOT NULL` is true for both, so the general path computes the same sum by the other
    // route. Written first as `'PT1H30M'`, which is the right duration and the wrong
    // REPRESENTATION — the value is structural — so the oracle is better than my expectation
    // here as well as more honest.
    expect(query(g, 'MATCH (a:D) RETURN sum(duration(a.d)) AS m')).toEqual(
      query(g, 'MATCH (a:D) WHERE a.d IS NOT NULL RETURN sum(duration(a.d)) AS m'),
    );
    // And it is 1h30m, asserted on the part of the shape that is stable.
    const [{ m }] = query<{ m: { secs: number } }>(g, 'MATCH (a:D) RETURN sum(duration(a.d)) AS m');

    expect(m.secs).toBe(5400);
    // `avg` over any temporal is a loud data exception, not a silent NaN.
    expect(() => query(g, 'MATCH (a:D) RETURN avg(duration(a.d)) AS m')).toThrow();

    // An ARRAY anywhere throws too.
    const lists = new Graph();

    lists.addVertex({ labels: ['L'], properties: { xs: [1, 2] } });
    expect(() => query(lists, 'MATCH (a:L) RETURN sum(a.xs) AS m')).toThrow();
  });

  test('a FILTERED scan declines and still answers', () => {
    const g = nums();

    // The boundary item 466 established: with a `WHERE` the general path may seed from an index
    // and visit in index order, so a float `sum` could fold differently. These must take the
    // general path — and they must be RIGHT, which is what a wrong answer here would reveal.
    expect(query(g, 'MATCH (a:P) WHERE a.k > 1 RETURN sum(a.k) AS m')).toEqual([{ m: 16 }]);
    expect(query(g, 'MATCH (a:P {k: 5}) RETURN sum(a.k) AS m')).toEqual([{ m: 5 }]);
    expect(query(g, 'MATCH (a:P WHERE a.k > 1) RETURN sum(a.k) AS m')).toEqual([{ m: 16 }]);
    // A DISTINCT aggregate declines, because the general path dedups by value first. The
    // duplicated 2 is what makes this 15 rather than 17 — and what gives the guard teeth.
    expect(query(g, 'MATCH (a:P) RETURN sum(DISTINCT a.k) AS m')).toEqual([{ m: 15 }]);
  });

  test('a float sum over an INDEXED filter agrees with the general path', () => {
    // This is what the unfiltered guard actually protects, and it needs three things at once to
    // be observable: floats whose sum depends on ORDER, an INDEX so the general path seeds and
    // visits in index order rather than bucket order, and a filter to seed from. With integers
    // or without an index the mutant that drops the guard SURVIVES — which it did, until this.
    const g = new Graph();

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });

    // Magnitudes chosen so float addition is not associative over them: 1e16 swallows the 1s
    // unless they are added together first.
    for (const v of [1e16, 1, 1, 1, 1, -1e16]) {
      g.addVertex({ labels: ['F'], properties: { v, tag: 'x' } });
    }

    const seeded = query(g, "MATCH (a:F) WHERE a.tag = 'x' RETURN sum(a.v) AS m");
    const inline = query(g, "MATCH (a:F {tag: 'x'}) RETURN sum(a.v) AS m");

    // Both filtered spellings decline to the general path, so they agree with each other AND
    // with the unfiltered scan over the same six rows. A collecting path that took the filtered
    // shape would fold in bucket order and could differ in the last bits.
    expect(seeded).toEqual(inline);
    expect(seeded).toEqual(query(g, 'MATCH (a:F) RETURN sum(a.v) AS m'));
  });

  test('the aggregate must BE the item, not be nested in one', () => {
    const g = nums();

    expect(query(g, 'MATCH (a:P) RETURN abs(sum(a.k) - 20) AS m')).toEqual([{ m: 3 }]);
    expect(query(g, 'MATCH (a:P) RETURN sum(a.k) + 1 AS m')).toEqual([{ m: 18 }]);
  });
});
