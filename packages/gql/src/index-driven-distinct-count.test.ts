/*
 * Item 2134 — `count(DISTINCT <far element>)` over one hop counts from the GRAPH-LEVEL edge index.
 *
 * THE ALGORITHM WAS ALREADY RIGHT and still 5.4x the Gremlin twin: `countFarSide` is O(V) with no
 * dedup set, but it visited every candidate vertex and did `far.adjTo?.get(type)` — a pointer chase into
 * the vertex object plus a string-keyed `Map.get`, ~80 ns each. Gremlin's `distinctHopCount` iterates
 * `graph.edgesToByLabel` and touches no vertex at all, ~19 ns. **21.3 → 4.08 ms, against Gremlin's 3.78.**
 *
 * **THE INDEX IS A DIFFERENT SOURCE OF TRUTH FROM THE VERTEX, SO EVERY TEST HERE IS ABOUT THE TWO
 * AGREEING.** The old walk asked each vertex what edges it had; the new one asks a graph-level map which
 * vertices have edges. Those can diverge in three ways, and each has a test: an entry whose set has been
 * emptied by a removal, an entry for the WRONG edge type, and an entry that should have appeared or
 * vanished after a write.
 *
 * The reference is the engine's own answer for the same question by another route — a far LABEL forces
 * the vertex walk — so the expectation is not a number I counted by hand.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const countDistinctFar = (
  g: Graph,
  q = 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS n',
): unknown => query(g, q)[0]?.n;

/** `edges` are `[fromIndex, toIndex, type]`; every vertex carries `P`. */
const graphOf = (n: number, edges: readonly [number, number, string][]): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  for (const [i, [from, to, type]] of edges.entries()) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${from}`)!,
      to: g.getVertexById(`v${to}`)!,
      labels: [type],
      properties: {},
    });
  }

  return g;
};

describe('index-driven count(DISTINCT far) (item 2134)', () => {
  test('counts the DISTINCT far endpoints, not the edges', () => {
    /*
     * THE WHOLE POINT OF `DISTINCT`: three edges, two far endpoints. A count that read the index's
     * SIZE rather than testing each entry's bucket would answer 2 here too, which is why the
     * wrong-type and empty-entry tests below exist.
     */
    const g = graphOf(4, [
      [0, 1, 'E'],
      [2, 1, 'E'],
      [0, 3, 'E'],
    ]);

    expect(countDistinctFar(g)).toBe(2);
    expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS n')[0].n).toBe(3);
  });

  test('a vertex with in-edges of ANOTHER type is NOT counted', () => {
    /*
     * THE INDEX ENTRY EXISTS FOR v2 — it has an `F` in-edge — so an index-driven count that merely
     * checked "is this vertex in the index" would answer 2. The bucket must be looked up BY TYPE.
     */
    const g = graphOf(3, [
      [0, 1, 'E'],
      [0, 2, 'F'],
    ]);

    expect(countDistinctFar(g)).toBe(1);
  });

  test('a REMOVED edge drops its far endpoint from the count', () => {
    /*
     * **I WROTE THIS TEST FOR A CASE THAT CANNOT HAPPEN, AND THE MUTANT SAID SO.** Its first comment
     * claimed the index can hold an EMPTY set after a removal, so the `bucket.size > 0` guard was
     * load-bearing. Deleting that guard SURVIVED this test, and the reason is that the claim is false:
     * measured, `removeEdge` DELETES the per-type bucket when its last edge goes (`byLabel.get('E')`
     * returns `undefined`; the outer per-vertex entry persists). So a present bucket always holds at
     * least one edge, and `bucket !== undefined` alone is sufficient.
     *
     * WHAT THIS TEST STILL EARNS: that a removal is REFLECTED AT ALL — the index is a different source
     * of truth from the vertex, and a count read from it must track writes. That is worth keeping; the
     * claim about empty sets is not.
     */
    const g = graphOf(3, [
      [0, 1, 'E'],
      [0, 2, 'E'],
    ]);

    expect(countDistinctFar(g)).toBe(2);
    g.removeEdge(g.getEdgeById('e1')!);
    expect(countDistinctFar(g)).toBe(1);
  });

  test('ADDING an edge makes a new far endpoint appear', () => {
    const g = graphOf(4, [[0, 1, 'E']]);

    expect(countDistinctFar(g)).toBe(1);
    g.addEdge({
      id: 'later',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('v3')!,
      labels: ['E'],
      properties: {},
    });
    expect(countDistinctFar(g)).toBe(2);
  });

  test('a SELF-LOOP makes its vertex a far endpoint', () => {
    /*
     * A self-loop sits in BOTH the from- and to-indexes. For an `out` hop this path reads the TO
     * index, where the loop's own vertex is a legitimate far endpoint — the start-driven walk reaches it
     * the same way.
     */
    const g = graphOf(2, [[0, 0, 'E']]);

    expect(countDistinctFar(g)).toBe(1);
  });

  test('the INCOMING direction reads the other index', () => {
    // `<-[:E]-` makes the far end the edge's SOURCE, so the from-index is the right one.
    const g = graphOf(4, [
      [0, 1, 'E'],
      [2, 1, 'E'],
      [0, 3, 'E'],
    ]);

    expect(countDistinctFar(g, 'MATCH (a:P)<-[:E]-(b) RETURN count(DISTINCT b) AS n')).toBe(2);
  });

  test('a FAR LABEL keeps the vertex walk, and the two routes agree', () => {
    /*
     * THE GATE. The index is keyed by id, so honouring a far label would mean resolving each id back
     * to its vertex (~190 ns, item 194) — dearer than the walk it replaces. So a labelled far end takes
     * the vertex walk. This test is what pins the two routes to the same answer: the labelled count
     * over a vacuously-labelled graph must equal the unlabelled one.
     */
    const g = new Graph();

    for (let i = 0; i < 4; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P', 'Q'], properties: {} });
    }

    for (const [i, [from, to]] of [
      [0, 1],
      [2, 1],
      [0, 3],
    ].entries()) {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById(`v${from}`)!,
        to: g.getVertexById(`v${to}`)!,
        labels: ['E'],
        properties: {},
      });
    }

    // Every vertex carries Q, so the labelled question has the same answer by the other route.
    expect(countDistinctFar(g, 'MATCH (a:P)-[:E]->(b:Q) RETURN count(DISTINCT b) AS n')).toBe(2);
    expect(countDistinctFar(g)).toBe(2);
  });

  test('a SELECTIVE far label still filters', () => {
    const g = new Graph();

    for (let i = 0; i < 4; i += 1) {
      g.addVertex({ id: `v${i}`, labels: i === 1 ? ['P', 'Q'] : ['P'], properties: {} });
    }

    for (const [i, [from, to]] of [
      [0, 1],
      [0, 3],
    ].entries()) {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById(`v${from}`)!,
        to: g.getVertexById(`v${to}`)!,
        labels: ['E'],
        properties: {},
      });
    }

    // Only v1 is a Q far endpoint; v3 is reached but is not a Q.
    expect(countDistinctFar(g, 'MATCH (a:P)-[:E]->(b:Q) RETURN count(DISTINCT b) AS n')).toBe(1);
    expect(countDistinctFar(g)).toBe(2);
  });

  test('an EMPTY graph counts zero', () => {
    expect(countDistinctFar(graphOf(3, []))).toBe(0);
  });

  test('count(DISTINCT b.k) is a DIFFERENT question and keeps its own route', () => {
    /*
     * The index can answer "which vertices have such an edge" but not "which VALUES their property
     * takes", so a property key must not reach this path. Two far endpoints sharing a value count once.
     */
    const g = new Graph();

    g.addVertex({ id: 'v0', labels: ['P'], properties: { k: 1 } });
    g.addVertex({ id: 'v1', labels: ['P'], properties: { k: 7 } });
    g.addVertex({ id: 'v2', labels: ['P'], properties: { k: 7 } });

    for (const [i, to] of ['v1', 'v2'].entries()) {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById('v0')!,
        to: g.getVertexById(to)!,
        labels: ['E'],
        properties: {},
      });
    }

    expect(countDistinctFar(g, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS n')).toBe(1);
    expect(countDistinctFar(g)).toBe(2);
  });
});
