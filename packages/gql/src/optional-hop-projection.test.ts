// `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(x) RETURN …` — one row per match, or ONE null-filled
// row for an anchor with none. Item 510 gave the COUNT its rung; the projection had none
// either, so it fell to the general row pipeline at 848ns a row against the non-optional
// two-clause spelling's 169 (item 511).
//
// The oracle is a DECLINING TWIN: `SKIP 0` keeps every row and makes the rung refuse (it does
// not page), so the same question is answered by the general path. Rows are compared as a
// MULTISET — order without `ORDER BY` is unspecified, and the two routes walk differently.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'bb', from: b, to: b, labels: ['S'], properties: {} });

  return g;
};

const g = build();
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();

describe('the OPTIONAL-hop projection (item 511)', () => {
  // The same question with `SKIP 0`, which the rung refuses and the general path answers.
  const both = (body: string, items: string, want: string[]) => {
    const fast = `MATCH (a:P) OPTIONAL MATCH ${body} RETURN ${items}`;

    expect(bag(fast)).toEqual(want.slice().sort());
    expect(bag(`${fast} SKIP 0`)).toEqual(want.slice().sort());
  };

  test('an anchor with no match keeps its row, with the landing NULL', () => {
    both('(a)-[:T]->(x)', 'a.k AS a, x.k AS x', [
      JSON.stringify({ a: 1, x: 2 }),
      JSON.stringify({ a: 1, x: 3 }),
      JSON.stringify({ a: 2, x: null }),
      JSON.stringify({ a: 9, x: null }),
    ]);
  });

  test('the TYPE, the DIRECTION and a landing LABEL each select', () => {
    both('(a)-[:S]->(x)', 'a.k AS a, x.k AS x', [
      JSON.stringify({ a: 1, x: null }),
      JSON.stringify({ a: 2, x: 2 }),
      JSON.stringify({ a: 9, x: null }),
    ]);
    both('(a)<-[:T]-(x)', 'a.k AS a, x.k AS x', [
      JSON.stringify({ a: 1, x: null }),
      JSON.stringify({ a: 2, x: 1 }),
      JSON.stringify({ a: 9, x: null }),
    ]);
    both('(a)-[:T]->(x:Q)', 'a.k AS a, x.k AS x', [
      JSON.stringify({ a: 1, x: 3 }),
      JSON.stringify({ a: 2, x: null }),
      JSON.stringify({ a: 9, x: null }),
    ]);
    both('(a)-[:NOPE]->(x)', 'a.k AS a, x.k AS x', [
      JSON.stringify({ a: 1, x: null }),
      JSON.stringify({ a: 2, x: null }),
      JSON.stringify({ a: 9, x: null }),
    ]);
  });

  test('a projection reading only ONE side still gets the right row COUNT', () => {
    both('(a)-[:T]->(x)', 'a.k AS a', [
      JSON.stringify({ a: 1 }),
      JSON.stringify({ a: 1 }),
      JSON.stringify({ a: 2 }),
      JSON.stringify({ a: 9 }),
    ]);
    both('(a)-[:T]->(x)', 'x.k AS x', [
      JSON.stringify({ x: 2 }),
      JSON.stringify({ x: 3 }),
      JSON.stringify({ x: null }),
      JSON.stringify({ x: null }),
    ]);
  });

  test('an unlabelled anchor walks every vertex', () => {
    expect(bag('MATCH (a) OPTIONAL MATCH (a)-[:T]->(x) RETURN a.k AS a, x.k AS x')).toEqual(
      bag('MATCH (a) OPTIONAL MATCH (a)-[:T]->(x) RETURN a.k AS a, x.k AS x SKIP 0'),
    );
    expect(bag('MATCH (a) OPTIONAL MATCH (a)-[:T]->(x) RETURN a.k AS a, x.k AS x').length).toBe(5);
  });

  test('an anchor whose every neighbour FAILS the landing label still null-fills', () => {
    // Its own graph: `b` has a T edge, but to a `:P`, so under `(x:Q)` it matches nothing and
    // must keep its null row. The main fixture cannot show this — every anchor there with a T
    // edge also has a passing one — so the mutant that sets `matched` BEFORE the label test
    // survived until this case existed.
    const h = new Graph();
    const p = h.addVertex({ id: 'p', labels: ['P'], properties: { k: 1 } });
    const q = h.addVertex({ id: 'q', labels: ['P'], properties: { k: 2 } });

    h.addEdge({ id: 'pq', from: p, to: q, labels: ['T'], properties: {} });

    const rows = query(h, 'MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x:Q) RETURN a.k AS a, x.k AS x');

    expect(rows.map((r) => JSON.stringify(r)).sort()).toEqual(
      [JSON.stringify({ a: 1, x: null }), JSON.stringify({ a: 2, x: null })].sort(),
    );
  });

  // What the rung must NOT take — each answered by the general path.
  test('the shapes it declines still answer correctly', () => {
    const decl = (q: string, n: number) => expect(query(g, q).length).toBe(n);

    decl('MATCH (a:P) OPTIONAL MATCH (a)-[:S]-(x) RETURN a.k AS a, x.k AS x', 3);
    decl('MATCH (a:P) OPTIONAL MATCH (a)-[r:T]->(x) RETURN r.id AS r', 4);
    decl('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x {k: 2}) RETURN x.k AS x', 3);
    decl('MATCH (a:P {k: 1}) OPTIONAL MATCH (a)-[:T]->(x) RETURN x.k AS x', 2);
    decl('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN a.k AS a, x.k AS x LIMIT 2', 2);
    // An aggregate is a fold, not a row per match.
    expect(
      query<{ c: number }>(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(x) AS c')[0]
        ?.c,
    ).toBe(2);
    // A repeated variable at both ends is the self-join gate (item 506).
    decl('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(a) RETURN a.k AS a', 3);
  });
});
