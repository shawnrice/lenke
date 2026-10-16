import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 482: an UNDIRECTED hop count. Every edge is met from BOTH ends, so it contributes a row
// per endpoint that fits the pattern — except a SELF-LOOP, which `expand` yields once.
//
// Vacuous endpoints take an O(1) route (`2 * |E_t| - loops(t)`), everything else one pass over
// the type's edges. 1352 ms -> 0.0 at 200,000 nodes / 1,000,000 edges.
//
// EVERY case below is compared against `WHERE true`, which declines the shortcut (a filtered
// undirected count has no fast arm) and so answers through the general path. An O(1) formula is
// exactly the kind of code that is wrong in one case and plausible in all of them, so the
// oracle is the route it replaces rather than a number I worked out.
const both = (g: Graph, pattern: string): unknown => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} RETURN count(*) AS c`)[0].c;
  const slow = query<{ c: number }>(g, `MATCH ${pattern} WHERE true RETURN count(*) AS c`)[0].c;

  expect(fast).toBe(slow);

  return fast;
};

describe('an undirected hop count (item 482)', () => {
  test('vacuous endpoints: every edge counts twice, a self-loop once', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
    expect(both(g, '(:P)-[:T]-(x)')).toBe(2);

    g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });
    // 2 for the plain edge, 1 for the loop — NOT 4.
    expect(both(g, '(:P)-[:T]-(x)')).toBe(3);

    g.addEdge({ id: 'loop2', from: b, to: b, labels: ['T'], properties: {} });
    expect(both(g, '(:P)-[:T]-(x)')).toBe(4);
  });

  test('a removed loop stops being subtracted', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const loop = g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
    expect(both(g, '(:P)-[:T]-(x)')).toBe(3);

    g.removeEdge(loop);
    expect(both(g, '(:P)-[:T]-(x)')).toBe(2);
  });

  test('NON-vacuous labels take the tally, and each orientation is tested separately', () => {
    const g = new Graph();
    const p = g.addVertex({ id: 'p', labels: ['P'], properties: {} });
    const q = g.addVertex({ id: 'q', labels: ['Q'], properties: {} });
    const r = g.addVertex({ id: 'r', labels: ['R'], properties: {} });

    g.addEdge({ id: 'pq', from: p, to: q, labels: ['T'], properties: {} });
    g.addEdge({ id: 'rp', from: r, to: p, labels: ['T'], properties: {} });

    // From P: q (out) and r (in) — two rows.
    expect(both(g, '(:P)-[:T]-(x)')).toBe(2);
    // P to Q only matches the p->q edge, in that orientation.
    expect(both(g, '(:P)-[:T]-(x:Q)')).toBe(1);
    // Q to P matches the same edge from the other end.
    expect(both(g, '(:Q)-[:T]-(x:P)')).toBe(1);
    // R to Q matches nothing: they are not adjacent.
    expect(both(g, '(:R)-[:T]-(x:Q)')).toBe(0);
  });

  test('a self-loop under NON-vacuous labels still counts once', () => {
    const g = new Graph();
    const p = g.addVertex({ id: 'p', labels: ['P', 'Q'], properties: {} });

    g.addEdge({ id: 'loop', from: p, to: p, labels: ['T'], properties: {} });
    // Both ends are the same vertex and it carries both labels, so the pattern matches — once.
    expect(both(g, '(:P)-[:T]-(x:Q)')).toBe(1);
    expect(both(g, '(:P)-[:T]-(x)')).toBe(1);
  });

  test('the edge TYPE selects, and a multi-type edge is not double-counted', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'both', from: a, to: b, labels: ['T', 'S'], properties: {} });
    g.addEdge({ id: 'tonly', from: b, to: a, labels: ['T'], properties: {} });

    expect(both(g, '(:P)-[:T]-(x)')).toBe(4); // two edges, each from both ends
    expect(both(g, '(:P)-[:S]-(x)')).toBe(2);
    // ONE edge carries both types: the union must not count it twice.
    expect(both(g, '(:P)-[:T|S]-(x)')).toBe(4);
  });

  test('an UNTYPED undirected hop counts every edge from both ends', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'e2', from: a, to: b, labels: ['S'], properties: {} });
    g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });
    expect(both(g, '(:P)-[]-(x)')).toBe(5);
  });

  test('a SELECTIVE filter declines, and the filtered answer is not the unfiltered one', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 9 } });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });

    // `WHERE true` keeps every row, so it cannot tell an IGNORED predicate from an applied one
    // — the mutant that admitted a filtered undirected count into the O(1) arm survived every
    // case above for exactly that reason. These two filters change the answer.
    expect(query(g, 'MATCH (:P)-[:T]-(x) WHERE x.k > 1 RETURN count(*) AS c')).toEqual([{ c: 1 }]);
    expect(query(g, 'MATCH (:P)-[:T]-(x {k: 1}) RETURN count(*) AS c')).toEqual([{ c: 2 }]);
    // Unfiltered, for contrast: 2 for the plain edge and 1 for the loop.
    expect(query(g, 'MATCH (:P)-[:T]-(x) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  test('an empty graph and a type nobody has', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    expect(both(g, '(:P)-[:T]-(x)')).toBe(0);
    expect(both(g, '(:Nope)-[:T]-(x)')).toBe(0);
  });
});
