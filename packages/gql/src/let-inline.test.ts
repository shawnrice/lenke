// `MATCH … LET a = n.k RETURN a` IS `MATCH … RETURN n.k AS a`: the `LET` inlined into the
// projection that follows it. `LET` is how this engine names an expression, and a `LET` between
// the MATCH and the RETURN dropped the query off every node rung, each of which reads a
// two-clause shape — 126.4ms against 13.7 for the projection, and 108.3 against 0.0 for a
// `count(*)` that does not read the name at all (item 512).
//
// The rewrite is shallow by design: an item either IS the variable or does not mention it. This
// file pins the shapes it must leave alone, and the one thing it has to carry — the COLUMN NAME,
// which an un-aliased `RETURN a` takes from the expression rather than the binding.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  g.addVertex({ id: 'c', labels: ['P'], properties: {} });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();

describe('a trailing LET is inlined into the RETURN (item 512)', () => {
  test('the COLUMN NAME is the LET variable, not the expression', () => {
    // The one thing the rewrite has to carry. An un-aliased `RETURN a` names its column after
    // the expression it evaluates, so substituting without pinning the alias renamed `a` to
    // `n.k` — caught by the existing `DISTINCT over a LET-bound name` suite.
    expect(Object.keys(query(g, 'MATCH (n:P) LET a = n.k RETURN a')[0] ?? {})).toEqual(['a']);
    expect(bag('MATCH (n:P) LET a = n.k RETURN a')).toEqual(bag('MATCH (n:P) RETURN n.k AS a'));
    // An explicit alias wins over the LET name, as it does without the rewrite.
    expect(Object.keys(query(g, 'MATCH (n:P) LET a = n.k RETURN a AS z')[0] ?? {})).toEqual(['z']);
  });

  test('the name used TWICE, and a name the projection never reads', () => {
    expect(bag('MATCH (n:P) LET a = n.k RETURN a AS x, a AS y')).toEqual(
      bag('MATCH (n:P) RETURN n.k AS x, n.k AS y'),
    );
    // `count(*)` does not read `a`, so the LET is dropped entirely — and the count is the same.
    expect(query<{ c: number }>(g, 'MATCH (n:P) LET a = n.k RETURN count(*) AS c')[0]?.c).toBe(3);
  });

  test('ORDER BY over the LET name still sorts', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.k RETURN a ORDER BY a')).toEqual(
      query(g, 'MATCH (n:P) RETURN n.k AS a ORDER BY a'),
    );
    expect(query(g, 'MATCH (n:P) LET a = n.k RETURN a ORDER BY a DESC')).toEqual(
      query(g, 'MATCH (n:P) RETURN n.k AS a ORDER BY a DESC'),
    );
  });

  // The shapes the rewrite must NOT touch. Each is checked by its answer, which the general
  // path produces either way.
  test('a NON-CHEAP expression keeps its LET', () => {
    // A function call can fault, and dropping or duplicating it is not free — so it declines.
    expect(bag('MATCH (n:P) LET a = abs(n.k) RETURN a')).toEqual(
      bag('MATCH (n:P) RETURN abs(n.k) AS a'),
    );
    expect(query<{ c: number }>(g, 'MATCH (n:P) LET a = abs(n.k) RETURN count(*) AS c')[0]?.c).toBe(
      3,
    );
  });

  test('a FAULTING LET still faults — dropping it would answer instead', () => {
    // This is what "total" in the cheap-and-total set means, and the only thing that can tell
    // the guard apart: a `LET` the projection never reads is DROPPED, so if a faulting
    // expression were admitted the query would answer 3 where it must throw. `abs(n.k)` cannot
    // show this (it is total), which is why the first version of the guard's mutant survived.
    expect(() =>
      query(g, "MATCH (n:P) LET a = CAST('abc' AS INTEGER) RETURN count(*) AS c"),
    ).toThrow();
    expect(() => query(g, 'MATCH (n:P) LET a = 1 / 0 RETURN count(*) AS c')).toThrow();
    // And when it IS read, the fault is the same either way.
    expect(() => query(g, "MATCH (n:P) LET a = CAST('abc' AS INTEGER) RETURN a")).toThrow();
  });

  test('the name inside a LARGER expression declines, and answers the same', () => {
    expect(bag('MATCH (n:P) LET a = n.k RETURN a + 1 AS x')).toEqual(
      bag('MATCH (n:P) RETURN n.k + 1 AS x'),
    );
  });

  test('GROUP BY, HAVING and RETURN * decline', () => {
    // `GROUP BY` takes a BOUND NAME, so inlining its key would remove the thing it names.
    expect(bag('MATCH (n:P) LET a = n.k RETURN a AS k, count(*) AS c GROUP BY a')).toEqual(
      bag('MATCH (n:P) RETURN n.k AS k, count(*) AS c'),
    );
    // `RETURN *` includes the LET variable as a column.
    expect(Object.keys(query(g, 'MATCH (n:P) LET a = n.k RETURN *')[0] ?? {}).sort()).toEqual(
      ['a', 'n'].sort(),
    );
  });

  test('a missing property reads as NULL, inlined or not', () => {
    // `c` has no `k`. This is why the cheap-and-total set includes a property read: it cannot
    // fault, so dropping or duplicating it is safe.
    expect(bag('MATCH (n:P) LET a = n.k RETURN a')).toContain(JSON.stringify({ a: null }));
  });

  test('TWO LETs: the last is inlined and the answer is unchanged', () => {
    expect(bag('MATCH (n:P) LET a = n.k LET b = a RETURN b')).toEqual(
      bag('MATCH (n:P) RETURN n.k AS b'),
    );
  });
});
