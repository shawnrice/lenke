import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `detectNodeAggregate` (audit item 420): the SCAN twin of `detectHopAggregate` (418). One
// foldable aggregate over exactly the rows `detectNodeProjection` already scans, folded as they
// are produced. ~39ms -> ~11ms at 200,000 vertices.
//
// The ORACLE for every admitted shape is the same question written as TWO aggregates, which
// `foldedAggs.length !== 1` refuses, so the general path answers it on the same fixture.
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 6; i++) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, s: `s${i}` } });
  }

  // No `k` and no `s`: an ABSENT value, which an aggregate must skip rather than fold.
  g.addVertex({ id: 'vn', labels: ['P'], properties: {} });
  // Not a `:P`, so a labelled scan must not see it and an unlabelled one must.
  g.addVertex({ id: 'vr', labels: ['R'], properties: { k: 99 } });

  return g;
};

const viaGeneral = (g: Graph, q: string): unknown[] => {
  const i = q.indexOf(' AS ');
  const agg = /RETURN (.+) AS /.exec(q)?.[1];

  if (agg === undefined) {
    throw new Error('oracle needs `RETURN <agg> AS <name>`');
  }

  const rows = query(g, `${q.slice(0, i)} AS m, ${agg} AS m2`) as Array<Record<string, unknown>>;

  return rows.map(({ m }) => ({ m }));
};

describe('node aggregate', () => {
  const g = build();

  test.each([
    ['max', 'MATCH (a:P) RETURN max(a.k) AS m', 5],
    ['min', 'MATCH (a:P) RETURN min(a.k) AS m', 0],
    ['count', 'MATCH (a:P) RETURN count(a.k) AS m', 6],
    // Strings fold through the same `compareValues` total order the general path uses.
    ['max string', 'MATCH (a:P) RETURN max(a.s) AS m', 's5'],
    ['min string', 'MATCH (a:P) RETURN min(a.s) AS m', 's0'],
    // A clause `WHERE`, an inline `WHERE` and inline properties are all carried by the scan.
    ['clause where', 'MATCH (a:P) WHERE a.k > 2 RETURN max(a.k) AS m', 5],
    ['clause where min', 'MATCH (a:P) WHERE a.k > 2 RETURN min(a.k) AS m', 3],
    ['inline where', 'MATCH (a:P WHERE a.k > 2) RETURN min(a.k) AS m', 3],
    ['inline props', 'MATCH (a:P {k: 3}) RETURN count(a.k) AS m', 1],
    // No label: the `:R` vertex is in scope, and its 99 is the maximum.
    ['unlabelled', 'MATCH (a) RETURN max(a.k) AS m', 99],
  ])('%s', (_name, q, want) => {
    const rows = query(g, q) as Array<Record<string, unknown>>;
    const got: unknown[] = rows.map(({ m }) => ({ m }));

    expect(got).toEqual([{ m: want }]);
    expect(got).toEqual(viaGeneral(g, q));
  });

  // An ungrouped aggregate over an EMPTY scan owes ONE row holding null, from `fold.finish` over
  // an untouched accumulator. A path returning NO rows here is wrong in a way no non-empty
  // fixture can see.
  test('empty scan still yields one row of null', () => {
    const rows: unknown[] = query(g, 'MATCH (a:Z) RETURN max(a.k) AS m');

    expect(rows).toEqual([{ m: null }]);
    expect(rows).toEqual(viaGeneral(g, 'MATCH (a:Z) RETURN max(a.k) AS m'));
  });

  // `count(a.k)` is 6 over 7 `:P` vertices BECAUSE one has no `k`.
  test('an absent value is skipped, not folded', () => {
    expect(query(g, 'MATCH (a:P) RETURN count(*) AS c')).toEqual([{ c: 7 }]);
    expect(query(g, 'MATCH (a:P) RETURN count(a.k) AS m')).toEqual([{ m: 6 }]);
  });

  // An explicit `GROUP BY` over a SINGLE aggregate item, which is the shape where a detector
  // that only counted items would be fooled. Both of this path's GROUP BY guards decline it, and
  // the mutation run showed which one matters: `groupKeys` is the compiled GROUP BY expressions
  // when any are written, so dropping the AST check changes nothing. The test is still the one
  // that pins the ANSWER — seven groups, not one row. (`counted-groups.test.ts` records the
  // neighbouring trap for its own detector, where the item-count check declined first and a
  // mutant dropping the GROUP BY check survived for that reason.)
  test('refuses an explicit GROUP BY over a single aggregate item', () => {
    expect(query(g, 'MATCH (a:P) RETURN max(a.k) AS m GROUP BY a.k')).toEqual([
      { m: 0 },
      { m: 1 },
      { m: 2 },
      { m: 3 },
      { m: 4 },
      { m: 5 },
      { m: null },
    ]);
  });

  // `sum`/`avg` USED to be refused here, for the reason the comment gave: they are not in
  // `foldFor` because they are order-DEPENDENT (item 419). Item 468 admits them on the
  // UNFILTERED scan alone, where the order is the same container traversal both paths make —
  // so they moved from this list to `collecting-aggregate.test.ts`, which pins the boundary.
  //
  // The REFUSED shapes. Each must still answer correctly — a wrong answer means it was taken.
  test.each([
    // `count(*)` has its own O(groups) path.
    ['count star', 'MATCH (a:P) RETURN count(*) AS m', [{ m: 7 }]],
    ['distinct agg', 'MATCH (a:P) RETURN max(DISTINCT a.k) AS m', [{ m: 5 }]],
    // Nested in a FUNCTION call: `abs(...)` is `kind: 'func'` with one argument, so without the
    // identity check this answers `min(a.k)` (0) instead of `abs(0 - 10)` (10). The `+ 1` form
    // cannot catch that — a `+` node is refused by the next guard anyway.
    ['agg inside abs', 'MATCH (a:P) RETURN abs(min(a.k) - 10) AS m', [{ m: 10 }]],
    ['agg plus one', 'MATCH (a:P) RETURN max(a.k) + 1 AS m', [{ m: 6 }]],
    ['order by', 'MATCH (a:P) RETURN max(a.k) AS m ORDER BY m', [{ m: 5 }]],
    ['limit', 'MATCH (a:P) RETURN max(a.k) AS m LIMIT 1', [{ m: 5 }]],
    // A hop is `detectHopAggregate`'s shape, not this one.
    ['a hop', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m', [{ m: null }]],
  ])('refuses %s', (_name, q, want) => {
    expect(query(g, q)).toEqual(want);
  });
});
// ITEM 1197: the aggregate no longer has to BE the projection item. `unfilteredScanAgg` finds the
// one inside `size(collect(a.k))`, the streamed value is handed to the wrapping expression through
// `foldedGroupView` — the same channel the general path reads a pre-folded aggregate from — and the
// wrapped spellings dropped from 6.5-10.2x the bare one to 1.0-1.3x.
//
// THE ORACLE IS THE ONE THIS FILE ALREADY USES, and it works here for the same structural reason:
// adding a second aggregate makes the arity gate refuse the shape, so the identical expression is
// answered by the general path over the identical fixture. These routes are answer-equivalent, so
// `routes-fired.test.ts` is what holds the ROUTE; this holds the ANSWER.
describe('a WRAPPED aggregate agrees with the general path', () => {
  const g = build();

  test.each([
    // `collect` drops the absent `k`, so six values — not seven rows. Asserting the literal here
    // as well as the oracle means a change to BOTH paths together still fails.
    ['size over collect', 'MATCH (a:P) RETURN size(collect(a.k)) AS m', 6],
    ['cardinality over collect', 'MATCH (a:P) RETURN cardinality(collect(a.k)) AS m', 6],
    // A wrapper OUTSIDE the POLY_STR_LIST set, so the two do not share argument typechecking.
    ['coalesce over collect', 'MATCH (a:P) RETURN coalesce(size(collect(a.k)), 1) AS m', 6],
    // The argument is a LITERAL, so no column is read and the fold is trivial — yet the old route
    // declined this too, at 6.5x.
    ['size over a literal collect', 'MATCH (a:P) RETURN size(collect(1)) AS m', 7],
    // Arithmetic around the aggregate, which is the shape the general path's own comment names.
    ['arithmetic around collect', 'MATCH (a:P) RETURN size(collect(a.k)) + 1 AS m', 7],
    // Nested TWO deep, so a one-level search would miss the aggregate and decline.
    ['doubly wrapped', 'MATCH (a:P) RETURN abs(size(collect(a.k)) - 10) AS m', 4],
    // An unlabelled scan sees the `:R` vertex too — seven `k` values over eight rows.
    ['unlabelled scan', 'MATCH (a) RETURN size(collect(a.k)) AS m', 7],
    // A string column, so the win is not numeric-only.
    ['over strings', 'MATCH (a:P) RETURN size(collect(a.s)) AS m', 6],
  ])('%s', (_name, q, expected) => {
    const got: unknown[] = query(g, q);

    expect(got).toEqual([{ m: expected }]);
    // The general path, on the same fixture, must agree — so neither route can drift alone.
    expect(got).toEqual(viaGeneral(g, q));
  });

  test('a SECOND aggregate still falls to the general path, and agrees', () => {
    // The arity gate must keep refusing this: the fast route carries ONE accumulator, so a shape
    // needing two must not be claimed. It is also what makes the oracle above independent.
    const q = 'MATCH (a:P) RETURN size(collect(a.k)) + count(*) AS m';

    const got: unknown[] = query(g, q);

    expect(got).toEqual([{ m: 13 }]); // 6 collected + 7 rows
  });

  test('a wrapped aggregate over an EMPTY scan agrees with the general path', () => {
    const empty = new Graph();

    // `collect` over no rows is the empty list, so `size` is 0 — not null, and not an error.
    const got: unknown[] = query(empty, 'MATCH (a:P) RETURN size(collect(a.k)) AS m');

    expect(got).toEqual([{ m: 0 }]);
  });
});
// ITEM 1198: the FOLD path (`min`/`max`/`count` via `foldFor`) gets the same nested-aggregate
// route item 1197 gave the collecting one, priced first at 8.12-9.46x rather than assumed to be
// worth the same — item 1189 is the precedent for why ("same lever" measured ~1.3x where its
// sibling paid 8332x; here it measured the same, which is the point of checking).
describe('a WRAPPED fold aggregate agrees with the general path', () => {
  const g = build();

  test.each([
    ['arithmetic after min', 'MATCH (a:P) RETURN abs(min(a.k) - 10) AS m', 10],
    ['arithmetic after max', 'MATCH (a:P) RETURN max(a.k) + 1 AS m', 6],
    ['coalesce over max', 'MATCH (a:P) RETURN coalesce(max(a.k), 0) AS m', 5],
    // `count` folds too, and counts only the PRESENT values — six, not the seven rows.
    ['arithmetic after count', 'MATCH (a:P) RETURN count(a.k) * 2 AS m', 12],
    // A STRING extremum, so the route is not numeric-only.
    ['upper over a string max', 'MATCH (a:P) RETURN upper(max(a.s)) AS m', 'S5'],
    // Nested two deep.
    ['doubly wrapped', 'MATCH (a:P) RETURN abs(min(a.k) - 10) + 1 AS m', 11],
  ])('%s', (_name, q, expected) => {
    const got: unknown[] = query(g, q);

    expect(got).toEqual([{ m: expected }]);
    expect(got).toEqual(viaGeneral(g, q));
  });

  // ⚠️ THE EMPTY-SCAN CASE IS THE ONE THE WRAPPING CHANGES. A bare `min` over no rows owes ONE row
  // holding null; wrapped, the null must flow THROUGH the outer expression rather than short out,
  // so `coalesce` gets to replace it and arithmetic propagates it. A route that returned the raw
  // folded null would pass the non-empty rows above and fail only here.
  test('an empty scan flows its null THROUGH the wrapping expression', () => {
    const empty = new Graph();

    expect(query(empty, 'MATCH (a:P) RETURN coalesce(max(a.k), 42) AS m')).toEqual([{ m: 42 }]);
    expect(query(empty, 'MATCH (a:P) RETURN min(a.k) + 1 AS m')).toEqual([{ m: null }]);
  });
});
