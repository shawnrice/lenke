import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `detectHopAggregate` (audit item 418): `MATCH (a:L)-[:T]->(b) RETURN max(b.k)` folds ONE
// foldable aggregate over exactly the rows the fused hop projection already walks, instead of
// sending the hop to the general grouping path. Measured 698.8ms -> 134.5ms (5.2x) at 200,000
// vertices / 800,000 edges.
//
// The ORACLE for every admitted shape is the same question written as TWO aggregates
// (`max(b.k) AS m, max(b.k) AS m2`), which `foldedAggs.length !== 1` refuses — so the general
// path answers it on the same fixture. The usual `WHERE <x>.name = <x>.name` trick used in
// `hop-projection.test.ts` is NOT available here: a clause `WHERE` over the endpoints is
// CARRIED by this path rather than refused, which is one of the shapes under test.
const build = (): Graph => {
  const g = new Graph();
  const vs: Array<ReturnType<Graph['addVertex']>> = [];

  for (let i = 0; i < 6; i++) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, s: `s${i}` } }));
  }

  // No `k` and no `s`: a far endpoint whose value is ABSENT, which an aggregate must skip the
  // same way the general path's `nonNull` filter does rather than fold a null into the extremum.
  const vn = g.addVertex({ id: 'vn', labels: ['P'], properties: {} });

  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 4],
    [3, 4],
  ] as Array<[number, number]>) {
    g.addEdge({ from: vs[a], to: vs[b], labels: ['E'], properties: {} });
  }

  g.addEdge({ from: vs[4], to: vn, labels: ['E'], properties: {} });

  return g;
};

/** The same question routed through the general grouping path, by duplicating the aggregate. */
const viaGeneral = (g: Graph, q: string): unknown[] => {
  const i = q.indexOf(' AS ');
  const head = q.slice(0, i);
  const agg = /RETURN (.+) AS /.exec(q)?.[1];

  if (agg === undefined) {
    throw new Error('oracle needs `RETURN <agg> AS <name>`');
  }

  const rows = query(g, `${head} AS m, ${agg} AS m2`) as Array<Record<string, unknown>>;

  return rows.map(({ m }) => ({ m }));
};

const bothWays = (g: Graph, q: string): readonly [unknown[], unknown[]] => {
  const rows = query(g, q) as Array<Record<string, unknown>>;

  return [rows.map(({ m }) => ({ m })), viaGeneral(g, q)] as const;
};

describe('hop aggregate', () => {
  const g = build();

  // The admitted shapes, each pinned to a VALUE as well as compared against the general path:
  // agreement alone would be satisfied by two paths that are wrong the same way, and the near
  // and far cases differ only in which endpoint is read, which is exactly the slot-permutation
  // mistake agreement cannot see.
  test.each([
    ['max far', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m', 4],
    ['min far', 'MATCH (a:P)-[:E]->(b) RETURN min(b.k) AS m', 1],
    ['count far', 'MATCH (a:P)-[:E]->(b) RETURN count(b.k) AS m', 5],
    ['max near', 'MATCH (a:P)-[:E]->(b) RETURN max(a.k) AS m', 4],
    ['min near', 'MATCH (a:P)-[:E]->(b) RETURN min(a.k) AS m', 0],
    // Strings fold through the same `compareValues` total order the general path uses.
    ['max string', 'MATCH (a:P)-[:E]->(b) RETURN max(b.s) AS m', 's4'],
    ['min string', 'MATCH (a:P)-[:E]->(b) RETURN min(b.s) AS m', 's1'],
    // A carried clause `WHERE` routes through the filtered walk, not the lean one.
    ['filtered', 'MATCH (a:P)-[:E]->(b) WHERE b.k > 2 RETURN max(b.k) AS m', 4],
    ['filtered count', 'MATCH (a:P)-[:E]->(b) WHERE b.k > 2 RETURN count(b.k) AS m', 3],
    // The far node's own inline constraint.
    ['inline', 'MATCH (a:P)-[:E]->(b {k: 4}) RETURN count(b.k) AS m', 2],
    // Reverse direction: `b` is the FROM endpoint.
    ['incoming', 'MATCH (a:P)<-[:E]-(b) RETURN max(b.k) AS m', 4],
    ['incoming min', 'MATCH (a:P)<-[:E]-(b) RETURN min(b.k) AS m', 0],
    // A far LABEL, which the walk filters per edge.
    ['far label', 'MATCH (a:P)-[:E]->(b:P) RETURN count(b.k) AS m', 5],
  ])('%s', (_name, q, want) => {
    const [fast, general] = bothWays(g, q);

    expect(fast).toEqual([{ m: want }]);
    expect(fast).toEqual(general);
  });

  // An ungrouped aggregate over an EMPTY match owes ONE row holding null — the fast path gets
  // that from `fold.finish` over an untouched accumulator, which is the same `finish` the
  // general path calls. A path that returned NO rows here would be wrong in a way no non-empty
  // fixture can see.
  test('empty match still yields one row of null', () => {
    const [fast, general] = bothWays(g, 'MATCH (a:Z)-[:E]->(b) RETURN max(b.k) AS m');

    expect(fast).toEqual([{ m: null }]);
    expect(fast).toEqual(general);
  });

  // `count(b.k)` is 5 over 6 edges BECAUSE one far endpoint has no `k`. This is the rule that
  // lives in three places now (the array path's `nonNull`, the streaming step, and this fast
  // path), so it gets a test of its own rather than riding on the table above.
  test('an absent value is skipped, not folded', () => {
    expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toEqual([{ c: 6 }]);
    expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(b.k) AS m')).toEqual([{ m: 5 }]);
  });

  // The REFUSED shapes. Each still has to answer correctly — the point is that this path must
  // not take them, and a wrong answer here would mean it did.
  test.each([
    // DISTINCT needs every value; `foldFor` refuses it.
    ['distinct agg', 'MATCH (a:P)-[:E]->(b) RETURN max(DISTINCT b.k) AS m', [{ m: 4 }]],
    // `count(*)` has its own O(groups) path.
    ['count star', 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS m', [{ m: 6 }]],
    // `sum`/`avg` are not folds here: `temporalSum` and the numeric faults need the group.
    ['sum', 'MATCH (a:P)-[:E]->(b) RETURN sum(b.k) AS m', [{ m: 14 }]],
    ['avg', 'MATCH (a:P)-[:E]->(b) RETURN avg(b.k) AS m', [{ m: 2.8 }]],
    // Two aggregates — the oracle above, asserted to be the general path rather than assumed.
    ['two aggs', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m, min(b.k) AS n', [{ m: 4, n: 1 }]],
    // The aggregate nested in an outer expression needs the folded value substituted back.
    ['agg plus one', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) + 1 AS m', [{ m: 5 }]],
    // Nested inside a FUNCTION call, which is the one wrapping that looks like a bare aggregate
    // to everything but the identity check: `abs(...)` is `kind: 'func'` with one argument, so
    // dropping that check accepts this and answers `min(b.k)` (1) instead of `abs(1 - 10)` (9).
    // The `+ 1` case above cannot catch it — a `+` node is not a `func` and is refused anyway.
    ['agg inside abs', 'MATCH (a:P)-[:E]->(b) RETURN abs(min(b.k) - 10) AS m', [{ m: 9 }]],
    // Paging and ordering want the groups this path never builds.
    ['order by', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m ORDER BY m', [{ m: 4 }]],
    ['limit', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m LIMIT 1', [{ m: 4 }]],
    // Two segments: not a one-hop at all.
    ['two hops', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN max(c.k) AS m', [{ m: 4 }]],
  ])('refuses %s', (_name, q, want) => {
    expect(query(g, q)).toEqual(want);
  });

  // GROUP BY on its own, because its answer is a SHAPE and not one row: an implicit grouping
  // by `a.k` is the silent one-group bug's neighbourhood, and the fast path must decline it.
  test('refuses an implicit grouping', () => {
    const rows = query(g, 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, max(b.k) AS m') as Array<
      Record<string, unknown>
    >;

    expect([...rows].sort((p, q2) => Number(p.g) - Number(q2.g))).toEqual([
      { g: 0, m: 2 },
      { g: 1, m: 3 },
      { g: 2, m: 4 },
      { g: 3, m: 4 },
      { g: 4, m: null },
    ]);
  });
});
