import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 474: a GROUPED scan aggregate the `count(*)` tally cannot take. At 200,000 nodes:
// `n.age AS k, max(n.age)` 53.2 -> 8.0 ms, `n.age AS k, count(*), max(n.age)` 85.8 -> 7.9, with
// the tally's own shape (`n.age AS k, count(*)`) flat at 2.8.
//
// The oracle throughout is the DECLINING spelling of the same question — the same projection
// with an `ORDER BY`, a `HAVING` or a `DISTINCT`, each of which sends it to the general path —
// so what is compared is two routes, not my arithmetic. Row ORDER is first-seen group order,
// which both engines pin.
describe('a grouped aggregate beyond the count tally (item 474)', () => {
  const g = (): Graph => {
    const graph = new Graph();

    // Three groups by `dept`, with values that differ per group, one row with a NULL key and
    // one with a null value inside a real group.
    for (const [dept, k] of [
      ['a', 1],
      ['a', 7],
      ['b', 3],
      ['b', 3],
      ['c', 9],
    ] as const) {
      graph.addVertex({ labels: ['P'], properties: { dept, k } });
    }

    graph.addVertex({ labels: ['P'], properties: { dept: 'a' } }); // no `k`
    graph.addVertex({ labels: ['P'], properties: { k: 100 } }); // no `dept` — a NULL key

    return graph;
  };

  test('key with max, agreeing with the general path over the same rows', () => {
    const graph = g();
    const fast = query(graph, 'MATCH (n:P) RETURN n.dept AS d, max(n.k) AS m');
    // `ORDER BY` declines this rung, so the general path answers the same question.
    const slow = query<{ d: string; m: number }>(
      graph,
      'MATCH (n:P) RETURN n.dept AS d, max(n.k) AS m ORDER BY d',
    );

    expect(
      [...fast].sort((x, y) => String((x as { d: string }).d).localeCompare(String(y.d))),
    ).toEqual(slow);
    expect(fast).toEqual([
      { d: 'a', m: 7 },
      { d: 'b', m: 3 },
      { d: 'c', m: 9 },
      { d: null, m: 100 },
    ]);
  });

  test('count(*) counts the null-valued row, count(n.k) does not', () => {
    const graph = g();

    // Group 'a' holds three rows and two `k`s — the distinction a tally cannot make.
    expect(query(graph, 'MATCH (n:P) RETURN n.dept AS d, count(*) AS c, count(n.k) AS n')).toEqual([
      { d: 'a', c: 3, n: 2 },
      { d: 'b', c: 2, n: 2 },
      { d: 'c', c: 1, n: 1 },
      { d: null, c: 1, n: 1 },
    ]);
  });

  test('ROW ORDER is first-seen group order, and COLUMN ORDER follows the projection', () => {
    const graph = g();
    const rows = query(graph, 'MATCH (n:P) RETURN min(n.k) AS lo, n.dept AS d, max(n.k) AS hi');

    expect(Object.keys(rows[0])).toEqual(['lo', 'd', 'hi']);
    expect(rows.map((r) => (r as { d: string | null }).d)).toEqual(['a', 'b', 'c', null]);
  });

  test('a filtered scan: both spellings of the filter, both correct', () => {
    const graph = g();

    expect(
      query(graph, 'MATCH (n:P) WHERE n.k > 2 RETURN n.dept AS d, count(*) AS c, max(n.k) AS m'),
    ).toEqual([
      { d: 'a', c: 1, m: 7 },
      { d: 'b', c: 2, m: 3 },
      { d: 'c', c: 1, m: 9 },
      { d: null, c: 1, m: 100 },
    ]);
    expect(
      query(graph, "MATCH (n:P {dept: 'b'}) RETURN n.dept AS d, count(*) AS c, min(n.k) AS lo"),
    ).toEqual([{ d: 'b', c: 2, lo: 3 }]);
  });

  test('an explicit GROUP BY naming the key is accepted; naming something else declines', () => {
    const graph = g();

    // ISO's SELECT spelling writes the PROPERTY, and `sameGroupingExpr` is what accepts it.
    expect(query(graph, 'MATCH (n:P) RETURN n.dept AS d, max(n.k) AS m GROUP BY n.dept')).toEqual(
      query(graph, 'MATCH (n:P) RETURN n.dept AS d, max(n.k) AS m'),
    );
    // Grouping by a DIFFERENT property is a different question, and must still be right.
    // Six groups: 1, 7, 3, 9, 100 and the row with no `k` (a NULL key is a group).
    expect(query(graph, 'MATCH (n:P) RETURN n.k AS k, count(*) AS c GROUP BY n.k').length).toBe(6);
  });

  test('sum and avg are REFUSED and still answer', () => {
    const graph = g();

    // Not admitted (items 419/466/468): a grouped float sum depends on the order values reach
    // their group, and a filtered scan may seed from an index.
    expect(query(graph, 'MATCH (n:P) RETURN n.dept AS d, sum(n.k) AS s')).toEqual([
      { d: 'a', s: 8 },
      { d: 'b', s: 6 },
      { d: 'c', s: 9 },
      { d: null, s: 100 },
    ]);
  });

  test('DISTINCT inside an aggregate declines, and differs from the non-DISTINCT answer', () => {
    const graph = g();

    // Group 'b' holds 3 twice, so DISTINCT is not vacuous here.
    expect(query(graph, 'MATCH (n:P) RETURN n.dept AS d, count(DISTINCT n.k) AS c')).toEqual([
      { d: 'a', c: 2 },
      { d: 'b', c: 1 },
      { d: 'c', c: 1 },
      { d: null, c: 1 },
    ]);
  });

  test('a HAVING declines to the general path and filters groups', () => {
    const graph = g();

    // HAVING is SELECT-statement only, which is the spelling that carries it.
    expect(
      query(
        graph,
        'SELECT n.dept AS d, count(*) AS c FROM MATCH (n:P) GROUP BY n.dept HAVING count(*) > 1',
      ),
    ).toEqual([
      { d: 'a', c: 3 },
      { d: 'b', c: 2 },
    ]);
  });

  test('a STRUCTURAL key groups by value, not by identity', () => {
    const graph = new Graph();

    // Two rows share a list value and a third differs. A key path that collapsed every object
    // to one bucket SURVIVED until this case — the fixture had only primitive keys.
    graph.addVertex({ labels: ['P'], properties: { tags: ['x', 'y'], k: 1 } });
    graph.addVertex({ labels: ['P'], properties: { tags: ['x', 'y'], k: 5 } });
    graph.addVertex({ labels: ['P'], properties: { tags: ['z'], k: 9 } });

    expect(query(graph, 'MATCH (n:P) RETURN n.tags AS t, count(*) AS c, max(n.k) AS m')).toEqual([
      { t: ['x', 'y'], c: 2, m: 5 },
      { t: ['z'], c: 1, m: 9 },
    ]);
  });

  test('a GROUP BY of TWO keys is a different grouping and declines', () => {
    const graph = g();

    // Grouping by the pair gives a row per (dept, k) — more rows than by `dept` alone, which
    // is what the mutant that dropped the GROUP BY check would have answered.
    const pairs = query(
      graph,
      'SELECT n.dept AS d, count(*) AS c FROM MATCH (n:P) GROUP BY n.dept, n.k',
    );

    expect(pairs.length).toBe(6);
    expect(query(graph, 'MATCH (n:P) RETURN n.dept AS d, count(*) AS c').length).toBe(4);
  });

  test('an empty scan produces no groups', () => {
    const graph = new Graph();

    graph.addVertex({ labels: ['Other'], properties: { dept: 'x', k: 1 } });
    expect(query(graph, 'MATCH (n:P) RETURN n.dept AS d, max(n.k) AS m')).toEqual([]);
  });

  test('a non-property key declines', () => {
    const graph = g();

    // The key must be a property of the matched node; an expression is the general path's.
    expect(query(graph, 'MATCH (n:P) RETURN n.k + 1 AS k, count(*) AS c').length).toBe(6);
  });
});
