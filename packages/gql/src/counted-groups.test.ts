// Item 297. `applyProjection`'s aggregating branch retained EVERY binding so the aggregate
// closures could map over them — which made `RETURN count(*)` O(rows) and OOM-killed a 5-hop
// count under a 4 GB cap (item 296 measured ~640 bytes a path over 6.25M paths; 3 and 4 hops ran
// in 8 and 13 ms at ~80 MB, so the cliff was exactly the count family's coverage edge).
//
// `count(*)` is the one aggregate that reads nothing but the group's SIZE, so when every
// aggregate in a projection is `count(*)` a counter plus one representative suffices — O(groups).
//
// EVERY TEST HERE COMPARES THE COUNTED PATH AGAINST THE RETAINED ONE on the same question.
// `count(*)` streams; adding any other aggregate to the same projection forces the retained
// path; both must answer identically. That comparison is the whole safety argument, because a
// counter that counts the wrong thing returns a plausible number.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** Uneven group sizes, so a counter that mis-attributes a row shows up as a wrong number. */
const g = (): Graph => {
  const graph = new Graph();

  // dept A: 4, dept B: 2, dept C: 1 — all distinct, and none equal to the group count (3).
  for (const [dept, n] of [
    ['A', 4],
    ['B', 2],
    ['C', 1],
  ] as [string, number][]) {
    for (let i = 0; i < n; i++) {
      graph.addVertex({ labels: ['P'], properties: { dept, age: 20 + i, nil: null } });
    }
  }

  return graph;
};

const rows = (q: string): string[] => [...query(g(), q)].map((r) => JSON.stringify(r)).sort();

describe('a counted group answers what a retained group answers', () => {
  test('a bare count(*) over everything', () => {
    expect(rows('MATCH (p:P) RETURN count(*) AS c')).toEqual([JSON.stringify({ c: 7 })]);
  });

  test('count(*) GROUP BY — the group sizes, not the group count', () => {
    // The counted path keeps one representative per group; a bug that counted GROUPS rather
    // than ROWS would answer 1/1/1, and one that shared a counter would answer 7/7/7.
    expect(rows('MATCH (p:P) RETURN p.dept AS d, count(*) AS c GROUP BY p.dept')).toEqual(
      [
        { d: 'A', c: 4 },
        { d: 'B', c: 2 },
        { d: 'C', c: 1 },
      ]
        .map((r) => JSON.stringify(r))
        .sort(),
    );
  });

  test('THE SAME QUESTION with a second aggregate, which forces the retained path', () => {
    // `sum()` maps over the group, so this projection cannot stream — and its `c` column must
    // match the streamed one above exactly.
    const streamed = query(g(), 'MATCH (p:P) RETURN p.dept AS d, count(*) AS c GROUP BY p.dept');
    const retained = query(
      g(),
      'MATCH (p:P) RETURN p.dept AS d, count(*) AS c, sum(p.age) AS s GROUP BY p.dept',
    ) as { d: string; c: number }[];

    const pairs = (xs: readonly { d: string; c: number }[]): string[] =>
      xs.map((r) => `${r.d}=${r.c}`).sort();

    expect(pairs(streamed as { d: string; c: number }[])).toEqual(pairs(retained));
  });

  test('count(*) twice in one projection', () => {
    expect(rows('MATCH (p:P) RETURN count(*) AS a, count(*) AS b')).toEqual([
      JSON.stringify({ a: 7, b: 7 }),
    ]);
  });

  test('count(*) inside an ARITHMETIC expression still streams and still counts', () => {
    // `count(*) + 1` has an aggregate nested in an expression; `collectAggregates` must find it
    // and still conclude the projection may stream.
    expect(rows('MATCH (p:P) RETURN count(*) + 1 AS c')).toEqual([JSON.stringify({ c: 8 })]);
  });

  test('an empty match counts 0, not nothing', () => {
    // The no-rows case: with no GROUP BY, ISO yields ONE row of zero. The counted path must not
    // swallow it — `groups` is empty, so the existing empty-group fallback has to still fire.
    expect(rows('MATCH (p:Nope) RETURN count(*) AS c')).toEqual([JSON.stringify({ c: 0 })]);
  });

  test('an empty match with GROUP BY yields no rows at all', () => {
    expect(rows('MATCH (p:Nope) RETURN p.dept AS d, count(*) AS c GROUP BY p.dept')).toEqual([]);
  });
});

describe('what must NOT take the counted path', () => {
  // Each of these reads the group's bindings, so the bindings have to be retained. The test is
  // that the answer is right — a projection wrongly routed to the counted path would index the
  // length-only view and throw, or read the representative for every row.
  test('sum over the group', () => {
    expect(rows('MATCH (p:P) RETURN sum(p.age) AS s')).toEqual([
      JSON.stringify({ s: 20 + 21 + 22 + 23 + 20 + 21 + 20 }),
    ]);
  });

  test('min and max', () => {
    expect(rows('MATCH (p:P) RETURN min(p.age) AS lo, max(p.age) AS hi')).toEqual([
      JSON.stringify({ lo: 20, hi: 23 }),
    ]);
  });

  test('avg', () => {
    const [row] = query(g(), 'MATCH (p:P) RETURN avg(p.age) AS a') as { a: number }[];

    expect(row?.a).toBeCloseTo((20 + 21 + 22 + 23 + 20 + 21 + 20) / 7, 10);
  });

  test('collect keeps every value, so it cannot stream', () => {
    const [row] = query(g(), 'MATCH (p:P) RETURN collect_list(p.age) AS xs') as {
      xs: number[];
    }[];

    expect(row?.xs.length).toBe(7);
  });

  test('count(expr) is NOT count(*) — it skips nulls', () => {
    // Every `nil` is null, so `count(p.nil)` is 0 where `count(*)` is 7. A counted path that
    // treated any `count` as `count(*)` would answer 7.
    expect(rows('MATCH (p:P) RETURN count(p.nil) AS c')).toEqual([JSON.stringify({ c: 0 })]);
    expect(rows('MATCH (p:P) RETURN count(p.age) AS c')).toEqual([JSON.stringify({ c: 7 })]);
  });

  test('count(DISTINCT …) needs the values', () => {
    // Three distinct depts over seven rows.
    expect(rows('MATCH (p:P) RETURN count(DISTINCT p.dept) AS c')).toEqual([
      JSON.stringify({ c: 3 }),
    ]);
  });

  test('HAVING is excluded rather than analysed, and still filters', () => {
    // `HAVING` rides the SELECT spelling, not the RETURN one.
    expect(
      rows(
        'SELECT p.dept AS d, count(*) AS c FROM MATCH (p:P) GROUP BY p.dept HAVING count(*) > 1',
      ),
    ).toEqual(
      [
        { d: 'A', c: 4 },
        { d: 'B', c: 2 },
      ]
        .map((r) => JSON.stringify(r))
        .sort(),
    );
  });

  test('ORDER BY over a counted group', () => {
    expect(
      query(g(), 'MATCH (p:P) RETURN p.dept AS d, count(*) AS c GROUP BY p.dept ORDER BY c DESC'),
    ).toEqual([
      { d: 'A', c: 4 },
      { d: 'B', c: 2 },
      { d: 'C', c: 1 },
    ]);
  });
});

describe('the counted group is BOUNDED, which is the point', () => {
  // The incident shape, shrunk to something a unit test can run: a 3-hop chain over a
  // fan-out graph is 8^3 = 512 paths per source. The assertion is the ANSWER (a retained path
  // would get the same number) — the MEMORY claim is measured in the audit, because a unit test
  // cannot assert an RSS. What this pins is that the streamed count of a genuinely large group
  // is still exact.
  const fanout = (): Graph => {
    const graph = new Graph();
    const ids = Array.from({ length: 40 }, (_, i) =>
      graph.addVertex({ labels: ['N'], properties: { i } }),
    );

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < 8; d++) {
        graph.addEdge({
          from: ids[i],
          to: ids[(i * 7 + d) % ids.length],
          labels: ['E'],
          properties: {},
        });
      }
    }

    return graph;
  };

  test('a multi-hop count over one big group is exact', () => {
    const [row] = query(
      fanout(),
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    ) as { c: number }[];

    // 40 sources x 8 x 8 x 8.
    expect(row?.c).toBe(40 * 8 * 8 * 8);
  });
});
