/**
 * Item 1066: a VACUOUS far label is dropped once per call, so the hop walk stops dereferencing the
 * far vertex to test a label that cannot fail.
 *
 * WHAT GIVES THESE TESTS TEETH. The hoist is answer-equivalent WHEN THE LABEL IS VACUOUS and a
 * wrong answer when it is not, so the fixtures come in pairs that differ only in whether every
 * vertex carries `P`. `vacuousLabel` compares the label bucket's size to the vertex count, so the
 * boundary is one vertex wide: these pin BOTH sides of it, and the `exactly one vertex short` case
 * is the one a mutant that always drops the label gets wrong.
 *
 * Every expected value was confirmed against the NATIVE engine first, on both fixtures (32 arms,
 * compared as multisets because row order for an unordered result is unspecified).
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * Eight vertices and eight edges. `allP` is the ONLY difference: when false, `v3` carries `Z`
 * instead of `P`, so `:P` covers 7 of 8 vertices and is no longer vacuous.
 */
const labelsOf = (i: number, allP: boolean): string[] => {
  if (i === 3 && !allP) {
    return ['Z'];
  }

  return i % 2 === 0 ? ['P', 'Q'] : ['P'];
};

const fixture = (allP: boolean): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 8 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: labelsOf(i, allP), properties: { k: i, s: `s${i}` } }),
  );
  const E = (id: string, from: number, to: number): void => {
    g.addEdge({ id, labels: ['E'], from: vs[from], to: vs[to], properties: { w: 1 } });
  };

  E('e0', 0, 1);
  E('e1', 0, 3);
  E('e2', 1, 3);
  E('e3', 2, 4);
  E('e4', 4, 3);
  E('e5', 5, 6);
  E('e6', 6, 7);
  E('e7', 3, 0);

  return g;
};

/** Rows as a multiset — row order for an unordered result is unspecified. */
const bag = (rows: readonly unknown[]): string[] => rows.map((r) => JSON.stringify(r)).sort();

describe('a VACUOUS far label changes no answer', () => {
  const g = (): Graph => fixture(true);

  it('an aggregate over the start', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN min(a.k) AS c')).toEqual([{ c: 0 }]);
  });

  it('a projection of the start matches the BARE-far spelling of the same question', () => {
    // The two spellings are one question when `:P` is vacuous, and they were 2.8x apart before
    // this item (18.06 ms against 6.43). Answer equality is the correctness half of that.
    const graph = g();

    expect(bag(query(graph, 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS c'))).toEqual(
      bag(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN a.k AS c')),
    );
  });

  it('every row is still emitted, one per edge', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c')).toEqual([{ c: 8 }]);
  });

  it('the far end is still bound for a projection that reads it', () => {
    expect(bag(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS x, b.k AS y'))).toEqual(
      bag([
        { x: 0, y: 1 },
        { x: 0, y: 3 },
        { x: 1, y: 3 },
        { x: 2, y: 4 },
        { x: 4, y: 3 },
        { x: 5, y: 6 },
        { x: 6, y: 7 },
        { x: 3, y: 0 },
      ]),
    );
  });

  it('a clause WHERE on the far end still filters', () => {
    expect(bag(query(g(), 'MATCH (a:P)-[:E]->(b:P) WHERE b.k > 1 RETURN a.k AS c'))).toEqual(
      bag([{ c: 0 }, { c: 1 }, { c: 2 }, { c: 4 }, { c: 5 }, { c: 6 }]),
    );
  });

  it('an ORDER BY with a window', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS c ORDER BY c LIMIT 3')).toEqual([
      { c: 0 },
      { c: 0 },
      { c: 1 },
    ]);
  });

  it('the undirected spelling', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]-(b:P) RETURN count(*) AS c')).toEqual([{ c: 16 }]);
  });
});

describe('a far label ONE VERTEX short of vacuous still filters', () => {
  // `vacuousLabel` is a size comparison, so this is the boundary: `:P` covers 7 of 8 vertices.
  // Every expectation here differs from its twin above, which is what makes the pair a test of
  // the guard rather than of the walk.
  const g = (): Graph => fixture(false);

  it('the start projection drops the edges into `v3`', () => {
    expect(bag(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS c'))).toEqual(
      bag([{ c: 0 }, { c: 2 }, { c: 5 }, { c: 6 }]),
    );
  });

  it('and the BARE-far spelling now answers something DIFFERENT', () => {
    // The two spellings are no longer one question: without the label, the three edges into `v3`
    // are included. A mutant that drops a non-vacuous label makes these agree, which is the
    // wrong answer this pair exists to catch.
    const graph = g();

    expect(bag(query(graph, 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS c'))).not.toEqual(
      bag(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN a.k AS c')),
    );
    expect(bag(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN a.k AS c'))).toEqual(
      bag([{ c: 0 }, { c: 0 }, { c: 1 }, { c: 2 }, { c: 4 }, { c: 5 }, { c: 6 }]),
    );
  });

  it('the count drops from 8 to 4', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  it('the aggregate over the start sees only the surviving edges', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN min(a.k) AS c')).toEqual([{ c: 0 }]);
  });

  it('both ends projected', () => {
    expect(bag(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS x, b.k AS y'))).toEqual(
      bag([
        { x: 0, y: 1 },
        { x: 2, y: 4 },
        { x: 5, y: 6 },
        { x: 6, y: 7 },
      ]),
    );
  });

  it('an ORDER BY with a window', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS c ORDER BY c LIMIT 3')).toEqual([
      { c: 0 },
      { c: 2 },
      { c: 5 },
    ]);
  });

  it('the undirected spelling', () => {
    expect(query(g(), 'MATCH (a:P)-[:E]-(b:P) RETURN count(*) AS c')).toEqual([{ c: 8 }]);
  });
});

describe('a SELECTIVE far label is never dropped, whatever the other labels do', () => {
  // `:Q` is on half the vertices in BOTH fixtures, so it is never vacuous and this family is the
  // control: the hoist must leave it alone.
  for (const allP of [true, false]) {
    it(`:Q filters with allP=${allP}`, () => {
      expect(bag(query(fixture(allP), 'MATCH (a:P)-[:E]->(b:Q) RETURN a.k AS c'))).toEqual(
        allP ? bag([{ c: 3 }, { c: 2 }, { c: 5 }]) : bag([{ c: 2 }, { c: 5 }]),
      );
    });
  }

  it('a label NO vertex carries matches nothing', () => {
    expect(query(fixture(true), 'MATCH (a:P)-[:E]->(b:Z) RETURN a.k AS c')).toEqual([]);
  });
});
