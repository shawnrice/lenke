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

  // The REFUSED shapes. Each must still answer correctly — a wrong answer means it was taken.
  test.each([
    // `sum`/`avg` are not in `foldFor`, and item 419 is why that matters: they are
    // order-DEPENDENT, so no fast path that may reorder rows can hold them.
    ['sum', 'MATCH (a:P) RETURN sum(a.k) AS m', [{ m: 15 }]],
    ['avg', 'MATCH (a:P) RETURN avg(a.k) AS m', [{ m: 2.5 }]],
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
