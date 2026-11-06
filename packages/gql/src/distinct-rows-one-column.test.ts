import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1561: `distinctRows` keys a ONE-COLUMN row on the raw value instead of building a string
 * through `rowKeyOf`. 4.01x on `UNION`, 1.25x on `EXCEPT`.
 *
 * ⚠️ EVERY TEST HERE IS A SEMANTIC EQUIVALENCE, not a speed check, because the fast path replaces a
 * string key space with a value key space and the two can disagree in exactly three ways: on
 * numeric edge cases (`-0`, `NaN`), on types that stringify alike (`5` vs `'5'`), and on a string
 * that happens to look like another kind's key (`'@v1'` vs a vertex with id `v1`).
 *
 * The third is the one a shared `Set` would get wrong, which is why the implementation keeps
 * primitives and non-primitives in SEPARATE sets.
 */
const g = (): Graph => {
  const graph = new Graph();

  graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: 1, tag: '@v1', s: '5', n: 5 } });
  graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 2, tag: '@v2', s: '6', n: 6 } });

  return graph;
};

const col = (rows: readonly Record<string, unknown>[], name: string): unknown[] =>
  rows.map((r) => r[name]);

describe('one-column UNION keeps the string key space equivalence classes', () => {
  test('duplicates across the two sides collapse', () => {
    const rows = query(g(), 'MATCH (n:P) RETURN n.k AS k UNION MATCH (n:P) RETURN n.k AS k');

    expect([...(col(rows, 'k') as number[])].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test('POSITIONAL, not by name — differently-aliased sides are the same row', () => {
    // ⚠️ The implementation must read the column PER ROW, not once from `rows[0]`: ISO set
    // operations compare positionally and the right side aliases differently here. Taking the name
    // from the first row would look up `a` on a row that only has `b` and read `undefined`, which
    // would collapse the whole right side into one row.
    const rows = query(g(), 'MATCH (n:P) RETURN n.k AS a UNION MATCH (n:P) RETURN n.k AS b');

    expect(rows.length).toBe(2);
    expect([...(col(rows, 'a') as number[])].sort((x, y) => x - y)).toEqual([1, 2]);
  });

  test('a number and the STRING of that number stay apart', () => {
    // `valueKey` prefixes types (`n5` vs `s5`); raw values distinguish them too. A key space that
    // stringified without a prefix would merge these.
    const rows = query(g(), 'MATCH (n:P) RETURN n.n AS x UNION MATCH (n:P) RETURN n.s AS x');

    expect(rows.length).toBe(4);
    expect([...col(rows, 'x')].map(String).sort()).toEqual(['5', '5', '6', '6']);
  });

  test('⚠️ a STRING column that looks like an element key does NOT collide with an element', () => {
    // THE CASE FOR TWO SETS. An element keys as `@<id>`, so the string `'@v1'` and the vertex `v1`
    // would be the same key in one shared set, and one of these two rows would vanish. They are
    // different rows.
    const rows = query(g(), 'MATCH (n:P) RETURN n.tag AS x UNION MATCH (n:P) RETURN n AS x');

    expect(rows.length).toBe(4);
  });

  test('elements dedup across the two sides', () => {
    const rows = query(g(), 'MATCH (n:P) RETURN n AS x UNION MATCH (n:P) RETURN n AS x');

    expect(rows.length).toBe(2);
  });

  test('null and a missing property are ONE value, and distinct from other primitives', () => {
    const rows = query(
      g(),
      'MATCH (n:P) RETURN n.absent AS x UNION MATCH (n:P) RETURN n.alsoAbsent AS x',
    );

    expect(rows).toEqual([{ x: null }]);
  });

  test('-0 and 0 are ONE row, matching valueKey', () => {
    const rows = query(g(), 'MATCH (n:P) RETURN 0.0 AS x UNION MATCH (n:P) RETURN -0.0 AS x');

    expect(rows.length).toBe(1);
  });

  test('⚠️ two NaN rows are ONE row — and NaN DOES reach a row', () => {
    // ⚠️ I first "established" that NaN normalizes to null here and it was an INSTRUMENT ARTIFACT:
    // I printed the row with `JSON.stringify`, and `JSON.stringify(NaN)` is the string `null`. The
    // value is a real NaN. So this equivalence class is live and the fast path has to match it.
    //
    // It does: a `Set`'s SameValueZero has NaN equal to itself, exactly as `valueKey` maps every
    // NaN to `#NaN`. (`0.0/0.0` is no way to make one — that RAISES "division by zero" — so the
    // NaN has to come in as a stored property.)
    const graph = new Graph();

    graph.addVertex({ id: 'v1', labels: ['P'], properties: { bad: Number.NaN } });

    const rows = query(graph, 'MATCH (n:P) RETURN n.bad AS x UNION MATCH (n:P) RETURN n.bad AS x');

    expect(rows.length).toBe(1);
    expect(Number.isNaN(rows[0]?.x)).toBe(true);
    expect(() => query(graph, 'MATCH (n:P) RETURN 0.0/0.0 AS x')).toThrow('division by zero');
  });

  test('NaN and null are DIFFERENT rows', () => {
    // The pair that a sloppy normalization would merge, and the reason the test above matters.
    const graph = new Graph();

    graph.addVertex({ id: 'v1', labels: ['P'], properties: { bad: Number.NaN } });

    const rows = query(
      graph,
      'MATCH (n:P) RETURN n.bad AS x UNION MATCH (n:P) RETURN n.absent AS x',
    );

    expect(rows.length).toBe(2);
  });

  test('booleans stay apart from the numbers they coerce to', () => {
    const rows = query(g(), 'MATCH (n:P) RETURN true AS x UNION MATCH (n:P) RETURN 1 AS x');

    expect(rows.length).toBe(2);
  });

  test('a LIST column still dedups (non-primitive, so it keys through valueKey)', () => {
    const rows = query(g(), 'MATCH (n:P) RETURN [n.k] AS x UNION MATCH (n:P) RETURN [n.k] AS x');

    expect(rows.length).toBe(2);
  });
});

describe('the general path is untouched', () => {
  test('TWO columns still dedup positionally', () => {
    const rows = query(
      g(),
      'MATCH (n:P) RETURN n.k AS a, n.s AS b UNION MATCH (n:P) RETURN n.k AS a, n.s AS b',
    );

    expect(rows.length).toBe(2);
  });

  test('two columns where only the PAIR differs', () => {
    const rows = query(
      g(),
      'MATCH (n:P) RETURN n.k AS a, 1 AS b UNION MATCH (n:P) RETURN n.k AS a, 2 AS b',
    );

    expect(rows.length).toBe(4);
  });
});

describe('EXCEPT and INTERSECT dedup through the same path', () => {
  test('EXCEPT', () => {
    const rows = query(
      g(),
      'MATCH (n:P) RETURN n.k AS k EXCEPT MATCH (n:P) WHERE n.k = 1 RETURN n.k AS k',
    );

    expect(rows).toEqual([{ k: 2 }]);
  });

  test('INTERSECT', () => {
    const rows = query(
      g(),
      'MATCH (n:P) RETURN n.k AS k INTERSECT MATCH (n:P) WHERE n.k = 1 RETURN n.k AS k',
    );

    expect(rows).toEqual([{ k: 1 }]);
  });
});
