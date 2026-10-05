import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The general grouped path built its row key as `JSON.stringify([valueKey(v)])` — a
// stringify, an intermediate array and a `.map` closure per ROW. For ONE grouping key the key
// IS the value key: `valueKey` is type-prefixed and injective, so `JSON.stringify([k])` is
// injective in exactly the same `k` that `k` itself is (audit item 186).
//
// What these tests have to pin is that the two spellings put the same values in the same
// groups, in the same first-seen order — because the key is internal and NOTHING about it is
// observable except which rows collapse together and in what order. So the risky cases are
// values whose raw `valueKey` text could be confused with another value's: a string that
// spells a tag (`'N'`, `'bT'`, `'n1'`), a string holding a JSON metacharacter, and the
// numeric identities `valueKey` deliberately unifies or keeps apart.
//
// Every shape here DECLINES the grouped-count tally — no aggregate, or a non-property key, or
// three items — so each one really does run the general path under test.

const g = (rows: Array<[string, unknown]>): Graph => {
  const graph = new Graph();

  for (const [id, k] of rows) {
    graph.addVertex({ id, labels: ['P'], properties: k === undefined ? {} : { k } });
  }

  return graph;
};

/** `RETURN a GROUP BY a` has no aggregate, so the tally declines and this is the general path. */
const groupsOf = (graph: Graph): unknown[] =>
  (query(graph, 'MATCH (n:P) LET a = n.k RETURN a GROUP BY a') as Array<{ a: unknown }>).map(
    (r) => r.a,
  );

const countsOf = (graph: Graph, q: string): Array<[unknown, number]> =>
  (query(graph, q) as Array<{ a: unknown; c: number }>).map((r) => [r.a, r.c]);

describe('a sole grouping key', () => {
  test('groups equal strings and keeps distinct ones apart', () => {
    const graph = g([
      ['v0', 'a'],
      ['v1', 'b'],
      ['v2', 'a'],
      ['v3', 'c'],
    ]);

    expect(groupsOf(graph)).toEqual(['a', 'b', 'c']);
  });

  test('emits groups in FIRST-SEEN order, not sorted', () => {
    const graph = g([
      ['v0', 'z'],
      ['v1', 'a'],
      ['v2', 'm'],
      ['v3', 'a'],
    ]);

    // 'a' takes the position of its first row, so this is not the sorted order.
    expect(groupsOf(graph)).toEqual(['z', 'a', 'm']);
  });

  test('a string that spells the null tag does not join the null group', () => {
    // `valueKey(null)` is 'N' and `valueKey('N')` is 'sN'. Without the type prefix these
    // would be one group; the test is here because the prefix is now load-bearing in a way
    // the stringify spelling made invisible.
    const graph = g([
      ['v0', null],
      ['v1', 'N'],
      ['v2', null],
    ]);

    expect(
      countsOf(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a'),
    ).toEqual([
      [null, 2],
      ['N', 1],
    ]);
  });

  test('a string that spells the boolean tag does not join the boolean group', () => {
    const graph = g([
      ['v0', true],
      ['v1', 'bT'],
      ['v2', false],
      ['v3', 'bF'],
    ]);

    expect(groupsOf(graph)).toEqual([true, 'bT', false, 'bF']);
  });

  test('a string that spells the number tag does not join the number group', () => {
    const graph = g([
      ['v0', 1],
      ['v1', 'n1'],
      ['v2', 1],
    ]);

    expect(
      countsOf(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a'),
    ).toEqual([
      [1, 2],
      ['n1', 1],
    ]);
  });

  test('a number and its decimal string stay apart', () => {
    const graph = g([
      ['v0', 1],
      ['v1', '1'],
    ]);

    expect(groupsOf(graph)).toEqual([1, '1']);
  });

  test('strings holding JSON metacharacters stay distinct', () => {
    // The stringify spelling escaped these; the raw key does not, so injectivity now rests on
    // the prefix plus the string itself rather than on the escaping.
    const graph = g([
      ['v0', 'a"b'],
      ['v1', 'a\\"b'],
      ['v2', 'a\\b'],
      ['v3', 'a"b'],
    ]);

    expect(
      countsOf(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a'),
    ).toEqual([
      ['a"b', 2],
      ['a\\"b', 1],
      ['a\\b', 1],
    ]);
  });

  test('the empty string is its own group, apart from null', () => {
    const graph = g([
      ['v0', ''],
      ['v1', null],
      ['v2', ''],
    ]);

    expect(
      countsOf(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a'),
    ).toEqual([
      ['', 2],
      [null, 1],
    ]);
  });

  test('-0 and 0 share one group, as valueKey rules', () => {
    const graph = g([
      ['v0', 0],
      ['v1', -0],
      ['v2', 0],
    ]);

    expect(
      countsOf(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a'),
    ).toEqual([[0, 3]]);
  });

  test('NaN groups with itself', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'v0', labels: ['P'], properties: { k: Number.NaN } });
    graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: Number.NaN } });
    graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 5 } });

    const rows = countsOf(
      graph,
      'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a',
    );

    // NaN/Infinity are coerced to null on the write path, so the first two land in ONE group
    // either way — what matters is that they do not split.
    expect(rows.length).toBe(2);
    expect(rows[0][1]).toBe(2);
    expect(rows[1]).toEqual([5, 1]);
  });

  test('an absent key groups with a stored null', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'v0', labels: ['P'], properties: { k: null } });
    graph.addVertex({ id: 'v1', labels: ['P'], properties: {} });
    graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 'a' } });

    expect(
      countsOf(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a'),
    ).toEqual([
      [null, 2],
      ['a', 1],
    ]);
  });

  test('a list key groups by contents, not identity', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'v0', labels: ['P'], properties: { k: [1, 2] } });
    graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: [1, 2] } });
    graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: [2, 1] } });

    const rows = countsOf(
      graph,
      'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c, 1 AS z GROUP BY a',
    );

    expect(rows.map((r) => r[1])).toEqual([2, 1]);
  });

  test('a constant key collapses every row into ONE group', () => {
    const graph = g([
      ['v0', 'a'],
      ['v1', 'b'],
      ['v2', 'c'],
    ]);

    expect(countsOf(graph, 'MATCH (n:P) LET a = 1 RETURN a, count(*) AS c GROUP BY a')).toEqual([
      [1, 3],
    ]);
  });

  test('the group keeps every binding, so a non-count aggregate still folds', () => {
    const graph = g([
      ['v0', 'a'],
      ['v1', 'a'],
      ['v2', 'b'],
    ]);
    graph.getVertexById('v0')!.setProperty('n', 1);
    graph.getVertexById('v1')!.setProperty('n', 4);
    graph.getVertexById('v2')!.setProperty('n', 9);

    expect(query(graph, 'MATCH (p:P) LET a = p.k RETURN a, sum(p.n) AS s GROUP BY a')).toEqual([
      { a: 'a', s: 5 },
      { a: 'b', s: 9 },
    ]);
  });

  test('HAVING still filters whole groups', () => {
    const graph = g([
      ['v0', 'a'],
      ['v1', 'a'],
      ['v2', 'b'],
    ]);

    // HAVING is SELECT-statement only, so this is the spelling that carries it. It also reads
    // the group AFTER grouping, which is what makes it worth pinning here.
    expect(
      query(
        graph,
        'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) > 1',
      ),
    ).toEqual([{ a: 'a', c: 2 }]);
  });

  test('ORDER BY still reorders the groups after grouping', () => {
    const graph = g([
      ['v0', 'z'],
      ['v1', 'a'],
      ['v2', 'z'],
    ]);

    expect(
      query(graph, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a ORDER BY a'),
    ).toEqual([
      { a: 'a', c: 1 },
      { a: 'z', c: 2 },
    ]);
  });

  test('TWO grouping keys keep the stringify spelling and the same answer', () => {
    const graph = new Graph();
    // The pair ('a','b') must not collide with ('a\x01b', '') or any other re-split of the
    // concatenation — which is exactly why several keys do NOT get a plain join.
    graph.addVertex({ id: 'v0', labels: ['P'], properties: { k: 'a', j: 'b' } });
    graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: 'a\u0001b', j: '' } });
    graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 'a', j: 'b' } });

    const rows = query(
      graph,
      'MATCH (n:P) LET a = n.k RETURN a, n.j AS b, count(*) AS c GROUP BY a, n.j',
    ) as Array<{ c: number }>;

    expect(rows.map((r) => r.c)).toEqual([2, 1]);
  });

  test('TWO keys that agree on the FIRST still group separately', () => {
    // The fixture above varies BOTH keys, so a sole-key path that wrongly accepted two keys
    // still answered it correctly — two mutants survived on exactly that blindness. Here the
    // first key is CONSTANT across every row, so using it alone collapses all three rows into
    // one group and the counts change.
    const graph = new Graph();
    graph.addVertex({ id: 'v0', labels: ['P'], properties: { k: 'same', j: 'x' } });
    graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: 'same', j: 'y' } });
    graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 'same', j: 'x' } });

    const rows = query(
      graph,
      'MATCH (n:P) LET a = n.k RETURN a, n.j AS b, count(*) AS c GROUP BY a, n.j',
    ) as Array<{ a: unknown; b: unknown; c: number }>;

    expect(rows).toEqual([
      { a: 'same', b: 'x', c: 2 },
      { a: 'same', b: 'y', c: 1 },
    ]);
  });

  test('TWO keys that agree on the SECOND still group separately', () => {
    // The mirror of the test above, so a path that used the LAST key alone is caught too.
    const graph = new Graph();
    graph.addVertex({ id: 'v0', labels: ['P'], properties: { k: 'x', j: 'same' } });
    graph.addVertex({ id: 'v1', labels: ['P'], properties: { k: 'y', j: 'same' } });
    graph.addVertex({ id: 'v2', labels: ['P'], properties: { k: 'x', j: 'same' } });

    const rows = query(
      graph,
      'MATCH (n:P) LET a = n.k RETURN a, n.j AS b, count(*) AS c GROUP BY a, n.j',
    ) as Array<{ a: unknown; b: unknown; c: number }>;

    expect(rows).toEqual([
      { a: 'x', b: 'same', c: 2 },
      { a: 'y', b: 'same', c: 1 },
    ]);
  });

  test('an element-valued key groups by element id', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'a', labels: ['P'], properties: {} });
    graph.addVertex({ id: 'b', labels: ['P'], properties: {} });

    // `n` itself as the grouping key: `valueKey` keys an element by its id.
    const rows = query(graph, 'MATCH (n:P) LET a = n RETURN a, count(*) AS c GROUP BY a') as Array<{
      c: number;
    }>;

    expect(rows.map((r) => r.c)).toEqual([1, 1]);
  });

  test('no rows and no grouping key still yields the one empty group', () => {
    const graph = new Graph();

    expect(query(graph, 'MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 0 }]);
  });
});
