// `MATCH … WITH n.age AS a RETURN a` IS `MATCH … RETURN n.age AS a` — a trailing `WITH` that is
// only a RENAMING, inlined into the projection that follows it.
//
// Every node rung reads a TWO-clause shape, so a `WITH` in between dropped the query off the
// ladder exactly as a `LET` did (item 512): 124.0ms against 13.7 for the projection and 112.0
// against 0.0 for a `count(*)`, where native pays 17.7 and 0.6 (item 516).
//
// `WITH` REPLACES the row where `LET` adds a binding, so a `WITH` may carry several items — a
// projection evaluates all of them against the INPUT row, so none can read another's alias. This
// file pins that, and the row-boundary spellings that must decline.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, j: 10 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2, j: 20 } });

  g.addVertex({ id: 'c', labels: ['P'], properties: {} });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();
const c = (q: string): unknown => (query(g, q)[0] as Record<string, unknown>)?.c;

describe('a trailing WITH is inlined into the RETURN (item 516)', () => {
  test('the alias is the column, and the answer is the direct spelling', () => {
    expect(bag('MATCH (n:P) WITH n.k AS a RETURN a')).toEqual(bag('MATCH (n:P) RETURN n.k AS a'));
    expect(Object.keys(query(g, 'MATCH (n:P) WITH n.k AS a RETURN a')[0] ?? {})).toEqual(['a']);
    // A bare variable needs no alias.
    expect(bag('MATCH (n:P) WITH n RETURN n.k AS k')).toEqual(bag('MATCH (n:P) RETURN n.k AS k'));
    // And a rename of the node itself.
    expect(c('MATCH (n:P) WITH n AS m RETURN count(*) AS c')).toBe(3);
  });

  test('SEVERAL items, which a WITH may carry and a LET may not', () => {
    expect(bag('MATCH (n:P) WITH n.k AS a, n.j AS b RETURN a, b')).toEqual(
      bag('MATCH (n:P) RETURN n.k AS a, n.j AS b'),
    );
    // Only one of them read.
    expect(bag('MATCH (n:P) WITH n.k AS a, n.j AS b RETURN b')).toEqual(
      bag('MATCH (n:P) RETURN n.j AS b'),
    );
  });

  test('a count(*) after the WITH is the base count', () => {
    expect(c('MATCH (n:P) WITH n.k AS a RETURN count(*) AS c')).toBe(3);
    expect(c('MATCH (n:P)-[:T]->(x) WITH x.k AS a RETURN count(*) AS c')).toBe(1);
  });

  test('ORDER BY over the alias still sorts', () => {
    expect(query(g, 'MATCH (n:P) WITH n.k AS a RETURN a ORDER BY a')).toEqual(
      query(g, 'MATCH (n:P) RETURN n.k AS a ORDER BY a'),
    );
  });

  // The row-boundary spellings. Each is a different question from a renaming.
  test('a WITH that FILTERS, dedupes, groups, orders or pages declines', () => {
    expect(c('MATCH (n:P) WITH n.k AS a WHERE a = 1 RETURN count(*) AS c')).toBe(1);
    expect(c('MATCH (n:P) WITH DISTINCT n.k AS a RETURN count(*) AS c')).toBe(3);
    expect(c('MATCH (n:P) WITH n.k AS a ORDER BY a LIMIT 2 RETURN count(*) AS c')).toBe(2);
    expect(c('MATCH (n:P) WITH n.k AS a SKIP 1 RETURN count(*) AS c')).toBe(2);
  });

  test('a WITH that AGGREGATES declines — it is a fold, not a renaming', () => {
    expect(c('MATCH (n:P) WITH count(*) AS n RETURN n AS c')).toBe(3);
    expect(c('MATCH (n:P) WITH max(n.k) AS m RETURN m AS c')).toBe(2);
  });

  test('a NON-CHEAP or un-aliased item declines, and answers the same', () => {
    expect(bag('MATCH (n:P) WITH abs(n.k) AS a RETURN a')).toEqual(
      bag('MATCH (n:P) RETURN abs(n.k) AS a'),
    );
    // Un-aliased and not a bare variable: the column takes the expression's name, which this
    // rewrite would have to reproduce exactly, so it declines.
    expect(Object.keys(query(g, 'MATCH (n:P) WITH n.k RETURN *')[0] ?? {})).toEqual(['n.k']);
  });

  test('a FAULTING item still faults', () => {
    expect(() =>
      query(g, "MATCH (n:P) WITH CAST('abc' AS INTEGER) AS a RETURN count(*) AS c"),
    ).toThrow();
    expect(() => query(g, 'MATCH (n:P) WITH 1 / 0 AS a RETURN count(*) AS c')).toThrow();
  });
});
