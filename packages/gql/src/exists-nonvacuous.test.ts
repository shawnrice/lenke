/*
 * Item 2191 — `EXISTS { (a)-[:T]->(b) }` under a NON-VACUOUS label: an intersection instead of a walk.
 *
 * ```text
 *     one shape per process, MIXED fixture, 20 reps median of the last 8, two rounds
 *     row                    BEFORE           NEW
 *     EXISTS            23.16 / 24.65   11.82 / 11.04    2.1x
 *     NOT EXISTS        21.49 / 19.41   13.23 / 12.11    1.6x
 *     plain count [ctl]      0.00            0.00        flat
 *     one-hop     [ctl] 8.05 /  7.73    7.93 /  7.71     flat
 * ```
 *
 * **THIS ARM WAS INVISIBLE UNTIL THE SCREEN GOT A REALISTIC SCHEMA.** On a homogeneous fixture the
 * label is vacuous, the index arm answers, and `EXISTS` read **1.54 ms (1.8x)** — comfortably ignorable.
 * Item 2190 made `MIXED` the default and it became the top nomination at **15.4x**. The fallback it
 * replaced was a plain `return walk(graph, params)`.
 *
 * A differential profile named the old path exactly: `get adjFrom` **+239 ms**, `existsReachable`
 * **+84**, `oneHopExists` **+36**, every one of them **0.0** in the vacuous arm.
 *
 * **WHY AN INTERSECTION IS ENOUGH:** `EXISTS { (a)-[:T]->(b) }` asks only whether `a` has a T-bucket —
 * no predicate, no traverser, no far vertex. So counting the labelled vertices that have one answers it.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** 6 `Person`, 2 `Other`; KNOWS edges v0→v1, v1→v2, o0→v3. */
const g = (): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 6; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['Person'], properties: {} });
  }

  for (let i = 0; i < 2; i += 1) {
    graph.addVertex({ id: `o${i}`, labels: ['Other'], properties: {} });
  }

  const edge = (id: string, from: string, to: string): void => {
    graph.addEdge({
      id,
      from: graph.getVertexById(from)!,
      to: graph.getVertexById(to)!,
      labels: ['KNOWS'],
      properties: {},
    });
  };

  edge('e0', 'v0', 'v1');
  edge('e1', 'v1', 'v2');
  edge('e2', 'o0', 'v3');

  return graph;
};

const count = (graph: Graph, q: string): unknown => {
  const out = query(graph, q) as unknown as { rows?: Record<string, unknown>[] };

  return (out.rows ?? (out as unknown as Record<string, unknown>[]))[0].c;
};

const EX = (label: string): string =>
  `MATCH (a:${label}) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b) } RETURN count(*) AS c`;
const NEX = (label: string): string =>
  `MATCH (a:${label}) WHERE NOT EXISTS { MATCH (a)-[:KNOWS]->(b) } RETURN count(*) AS c`;

describe('EXISTS under a non-vacuous label (item 2191)', () => {
  describe('the counts, derived from the fixture rather than chosen', () => {
    test('EXISTS over the MAJORITY label', () => {
      // v0 and v1 have an outgoing KNOWS; v2..v5 do not.
      expect(count(g(), EX('Person'))).toBe(2);
    });

    test('NOT EXISTS over the majority label', () => {
      expect(count(g(), NEX('Person'))).toBe(4);
    });

    test('EXISTS over the MINORITY label — the other drive direction', () => {
      /*
       * The arm iterates the SMALLER of the labelled set and the adjacency index. With two `Other`
       * vertices against a 3-entry index this takes the labelled branch; `Person` above takes it too.
       * The index-driven branch is covered by the large-label test below.
       */
      expect(count(g(), EX('Other'))).toBe(1);
    });

    test('NOT EXISTS over the minority label', () => {
      expect(count(g(), NEX('Other'))).toBe(1);
    });

    test('a label NOTHING carries answers zero, not the whole graph', () => {
      expect(count(g(), EX('Nope'))).toBe(0);
      expect(count(g(), NEX('Nope'))).toBe(0);
    });
  });

  test('removing a vertex’s LAST edge of that type stops counting it', () => {
    /*
     * ITEM 2162 SHIPPED A WRONG ANSWER ON EXACTLY THIS CONFUSION: an outer `edgesFromByLabel` entry
     * SURVIVES the removal of its last edge, so the entry's existence does not mean the vertex still has
     * an edge of that type. The arm must test `byType.has(type)`, which this pins.
     */
    const graph = g();

    expect(count(graph, EX('Person'))).toBe(2);
    graph.removeEdge(graph.getEdgeById('e0')!);
    expect(count(graph, EX('Person'))).toBe(1);
    expect(count(graph, NEX('Person'))).toBe(5);
  });

  test('the LAST-EDGE trap on the LABELLED-driven branch specifically', () => {
    /*
     * THE GAP THE MUTATION ROUND FOUND. The trap test above has 6 labelled vertices against a
     * 3-entry index, so it takes the INDEX-driven branch and never executes the labelled branch's
     * `index.get(v.id)?.has(type)`. A mutant replacing that with `index.has(v.id)` survived every
     * test — the exact item 2162 confusion, unguarded on one of the two branches.
     *
     * This fixture inverts the sizes: TWO labelled vertices against a large index, so
     * `labelled.size <= index.size` holds and the labelled branch runs.
     */
    const graph = new Graph();

    graph.addVertex({ id: 's0', labels: ['Lsml'], properties: {} });
    graph.addVertex({ id: 's1', labels: ['Lsml'], properties: {} });

    for (let i = 0; i < 40; i += 1) {
      graph.addVertex({ id: `f${i}`, labels: ['Lfil'], properties: {} });
    }

    const edge = (id: string, from: string, to: string): void => {
      graph.addEdge({
        id,
        from: graph.getVertexById(from)!,
        to: graph.getVertexById(to)!,
        labels: ['KNOWS'],
        properties: {},
      });
    };

    // Both `Small` vertices get one KNOWS edge, plus filler edges to make the index large.
    edge('se0', 's0', 'f0');
    edge('se1', 's1', 'f1');

    for (let i = 0; i < 30; i += 1) {
      edge(`fe${i}`, `f${i}`, `f${(i + 1) % 40}`);
    }

    expect(count(graph, EX('Lsml'))).toBe(2);

    // Remove s0's ONLY KNOWS edge: the outer entry survives, the per-type bucket does not.
    graph.removeEdge(graph.getEdgeById('se0')!);

    expect(count(graph, EX('Lsml'))).toBe(1);
    expect(count(graph, NEX('Lsml'))).toBe(1);
  });

  test('the index-driven branch: a label carried by nearly everything', () => {
    /*
     * When the labelled set is LARGER than the adjacency index the arm flips to iterating the index
     * and testing the label. This fixture makes that branch the one taken — 200 labelled vertices
     * against a 2-entry index — and the answer must be identical either way.
     */
    const graph = new Graph();

    for (let i = 0; i < 200; i += 1) {
      graph.addVertex({ id: `p${i}`, labels: ['Person'], properties: {} });
    }

    graph.addVertex({ id: 'x', labels: ['Other'], properties: {} });

    for (const [id, from, to] of [
      ['a0', 'p0', 'p1'],
      ['a1', 'p1', 'p2'],
    ] as const) {
      graph.addEdge({
        id,
        from: graph.getVertexById(from)!,
        to: graph.getVertexById(to)!,
        labels: ['KNOWS'],
        properties: {},
      });
    }

    expect(count(graph, EX('Person'))).toBe(2);
    expect(count(graph, NEX('Person'))).toBe(198);
  });

  test('a VACUOUS label still answers (the index arm, unchanged)', () => {
    const graph = new Graph();

    for (let i = 0; i < 4; i += 1) {
      graph.addVertex({ id: `v${i}`, labels: ['Person'], properties: {} });
    }

    graph.addEdge({
      id: 'e',
      from: graph.getVertexById('v0')!,
      to: graph.getVertexById('v1')!,
      labels: ['KNOWS'],
      properties: {},
    });

    expect(count(graph, EX('Person'))).toBe(1);
    expect(count(graph, NEX('Person'))).toBe(3);
  });

  test('the INCOMING direction is a different index', () => {
    // v1, v2 and v3 are KNOWS targets; v0, v4, v5 are not.
    expect(
      count(g(), 'MATCH (a:Person) WHERE EXISTS { MATCH (a)<-[:KNOWS]-(b) } RETURN count(*) AS c'),
    ).toBe(3);
  });

  test('an edge of a DIFFERENT type does not satisfy the test', () => {
    const graph = g();

    graph.addEdge({
      id: 'other',
      from: graph.getVertexById('v4')!,
      to: graph.getVertexById('v5')!,
      labels: ['LIKES'],
      properties: {},
    });

    // v4 gained a LIKES edge, not a KNOWS one, so the KNOWS counts are unchanged.
    expect(count(graph, EX('Person'))).toBe(2);
    expect(count(graph, NEX('Person'))).toBe(4);
  });
});
