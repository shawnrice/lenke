// Item 377. Item 297 made `count(*)` O(groups) and recorded what it left: `sum`/`min`/`max`/
// `avg`/`stddev` "foldable, but … they need partial state plumbed through `compileAggregate` —
// and the accumulator must fold the array path too, or it becomes a second definition of the
// semantics". This is that work for the three that are PURE left folds — `count(arg)`, `min`,
// `max` — and the accumulator does drive the array path, so there is one definition.
//
// Before it, a 5-hop `max` over 4.86M paths OOM-killed under a 4 GB cap while native answered
// the same query in 38 ms. That is the same class as item 373 with the engines swapped: not a
// wrong answer, one engine terminating and the other not.
//
// EVERY TEST HERE COMPARES THE FOLDED PATH AGAINST THE RETAINED ONE on the same question.
// `DISTINCT` is refused by `foldFor`, and `max(DISTINCT x) === max(x)` for all x, so the
// DISTINCT spelling is a reference implementation reachable from the query language itself —
// not an expectation typed into the test.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** Uneven groups, repeated values, and a null — so a fold that mis-skips shows up. */
const g = (): Graph => {
  const graph = new Graph();
  const rows: [string, number | null][] = [
    ['A', 5],
    ['A', 1],
    ['A', 5],
    ['A', null],
    ['B', -2],
    ['B', 7],
    ['C', 3],
    ['C', null],
  ];

  for (const [dept, k] of rows) {
    graph.addVertex({ labels: ['P'], properties: { dept, k } });
  }

  return graph;
};

const run = (q: string): unknown => query(g(), q);

describe('folded aggregate groups match the retained path', () => {
  // `min`/`max` with and without DISTINCT: same answer, different path.
  for (const fn of ['min', 'max'] as const) {
    test(`${fn} scalar folds to the DISTINCT answer`, () => {
      expect(run(`MATCH (p:P) RETURN ${fn}(p.k) AS c`)).toEqual(
        run(`MATCH (p:P) RETURN ${fn}(DISTINCT p.k) AS c`),
      );
    });

    test(`${fn} grouped folds to the DISTINCT answer`, () => {
      expect(run(`MATCH (p:P) RETURN p.dept AS d, ${fn}(p.k) AS c`)).toEqual(
        run(`MATCH (p:P) RETURN p.dept AS d, ${fn}(DISTINCT p.k) AS c`),
      );
    });
  }

  // `count(arg)` has no DISTINCT twin with the same answer (DISTINCT dedups), so its reference
  // is the filtered `count(*)`, which takes a different path because the filter is in the match.
  test('count(arg) counts the non-null values, like a filtered count(*)', () => {
    expect(run('MATCH (p:P) RETURN count(p.k) AS c')).toEqual(
      run('MATCH (p:P) WHERE p.k IS NOT NULL RETURN count(*) AS c'),
    );
  });

  test('count(arg) is NOT count(*) — the nulls are the difference', () => {
    expect(run('MATCH (p:P) RETURN count(p.k) AS c')).toEqual([{ c: 6 }]);
    expect(run('MATCH (p:P) RETURN count(*) AS c')).toEqual([{ c: 8 }]);
  });

  // SEVERAL accumulators live at once, which is where a shared or mis-indexed slot shows up.
  test('three folds in one projection stay independent', () => {
    expect(
      run('MATCH (p:P) RETURN p.dept AS d, min(p.k) AS lo, max(p.k) AS hi, count(p.k) AS n'),
    ).toEqual(
      run(
        'MATCH (p:P) RETURN p.dept AS d, min(DISTINCT p.k) AS lo, max(DISTINCT p.k) AS hi, ' +
          'count(p.k) AS n',
      ),
    );
  });

  // A group whose every value is null has no extremum: NULL, and the count is 0 — not a
  // dropped group, and not `undefined` leaking out of an untouched accumulator.
  test('an all-null group yields null extrema and a zero count', () => {
    const graph = new Graph();

    graph.addVertex({ labels: ['P'], properties: { dept: 'Z', k: null } });
    graph.addVertex({ labels: ['P'], properties: { dept: 'Z', k: null } });

    expect(
      query(graph, 'MATCH (p:P) RETURN min(p.k) AS lo, max(p.k) AS hi, count(p.k) AS n'),
    ).toEqual([{ lo: null, hi: null, n: 0 }]);
  });

  // MIXED types go through `compareValues`, the same comparison the retained path uses.
  test('a mixed-type column orders by the value contract, not by the fold', () => {
    const graph = new Graph();

    for (const k of ['b', 'a', 'c']) {
      graph.addVertex({ labels: ['P'], properties: { k } });
    }

    expect(query(graph, 'MATCH (p:P) RETURN min(p.k) AS lo, max(p.k) AS hi')).toEqual(
      query(graph, 'MATCH (p:P) RETURN min(DISTINCT p.k) AS lo, max(DISTINCT p.k) AS hi'),
    );
  });

  // `HAVING` is excluded from the folded path (it receives the group and may do anything with
  // it), so this must still answer correctly via the retained path.
  test('HAVING keeps the retained path and still answers', () => {
    // `HAVING` rides the SELECT spelling, not the RETURN one.
    expect(
      run(
        'SELECT p.dept AS d, max(p.k) AS hi FROM MATCH (p:P) GROUP BY p.dept HAVING count(*) > 2',
      ),
    ).toEqual([{ d: 'A', hi: 5 }]);
  });
});
