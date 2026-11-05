import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import {
  countIncidentEdges,
  countIncidentEdgesFlat,
  incidentEdges,
  writeIncidentEnds,
} from './adjacency.js';
import { labelPropagation } from './label-propagation.js';

/**
 * Item 1467 priced `labelPropagation`'s CSR build at 21.6% of the run and item 1468 replaced it with
 * a count-then-fill pass, gated on `graph.multiTypeEdgeCount === 0`. Two things have to hold and
 * neither is covered by the existing suite:
 *
 *  1. `countIncidentEdgesFlat` / `writeIncidentEnds` must agree with `countIncidentEdges` /
 *     `incidentEdges` on the IDENTICAL SEQUENCE — not just the same degree — wherever the gate
 *     holds. A permuted neighbour list changes a label tie-break, so a divergence is a wrong answer
 *     that agrees on row count.
 *  2. The two arms of the build must produce the same labels end to end.
 *
 * The multi-label fixtures come FIRST deliberately: they are the case the gate exists for, and the
 * case where the flat count is WRONG by construction (a two-label edge sits in two buckets). A suite
 * that only exercised single-label graphs would pass against a build that ignored the gate entirely.
 */

const vertexIndex = (g: Graph): Map<string, number> => {
  const index = new Map<string, number>();
  let i = 0;

  for (const v of g.vertices) {
    index.set(v.id, i);
    i += 1;
  }

  return index;
};

/** The neighbour sequence the ORIGINAL generator path produces, for one vertex and one direction. */
const viaGenerator = (g: Graph, id: string, end: 'to' | 'from', edgeLabel?: string): number[] => {
  const index = vertexIndex(g);
  const byLabel = end === 'to' ? g.edgesFromByLabel.get(id) : g.edgesToByLabel.get(id);
  const out: number[] = [];

  for (const edge of incidentEdges(byLabel, edgeLabel)) {
    out.push(index.get(edge[end].id)!);
  }

  return out;
};

/** The same sequence via the direct-write path. */
const viaFlat = (g: Graph, id: string, end: 'to' | 'from', edgeLabel?: string): number[] => {
  const index = vertexIndex(g);
  const byLabel = end === 'to' ? g.edgesFromByLabel.get(id) : g.edgesToByLabel.get(id);
  const size = countIncidentEdgesFlat(byLabel, edgeLabel);
  const buf = new Int32Array(size);
  const w = writeIncidentEnds(byLabel, end, edgeLabel, index, buf, 0);

  expect(w).toBe(size);

  return [...buf];
};

const map = (rows: { node: string; label: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.node, r.label]));

const addV = (g: Graph, ids: string[]): void => {
  for (const id of ids) {
    g.addVertex({ id, labels: ['N'] });
  }
};

const addE = (g: Graph, from: string, to: string, labels: string[]): void => {
  g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels });
};

describe('the multi-label case the gate exists for', () => {
  test('a two-label edge makes the FLAT count overcount, which is why the gate is required', () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E', 'F']);

    expect(g.multiTypeEdgeCount).toBe(1);

    const byLabel = g.edgesFromByLabel.get('a');

    // The deduping count is the truth: ONE edge. The flat count sees it in both buckets.
    expect(countIncidentEdges(byLabel, undefined)).toBe(1);
    expect(countIncidentEdgesFlat(byLabel, undefined)).toBe(2);
  });

  test('multiTypeEdgeCount tracks a label being added and removed again', () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E']);

    expect(g.multiTypeEdgeCount).toBe(0);

    const [edge] = [...g.edges];

    edge.addLabel('F');
    expect(g.multiTypeEdgeCount).toBe(1);

    edge.removeLabel('F');
    expect(g.multiTypeEdgeCount).toBe(0);
  });

  test('a graph with a multi-label edge still propagates correctly (the general arm)', async () => {
    const g = new Graph();

    addV(g, ['1', '2', '3']);
    addE(g, '1', '2', ['E', 'F']);
    addE(g, '2', '3', ['E']);
    addE(g, '1', '3', ['E']);

    expect(g.multiTypeEdgeCount).toBe(1);
    expect(map(await labelPropagation({}, g))).toEqual({ 1: '1', 2: '1', 3: '1' });
  });
});

describe('the two paths produce the identical sequence wherever the gate holds', () => {
  test('a single edge type', () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'c', ['E']);

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(viaFlat(g, 'a', 'to')).toEqual(viaGenerator(g, 'a', 'to'));
    expect(viaFlat(g, 'a', 'to')).toEqual([1, 2]);
  });

  test('SEVERAL edge types with no multi-label edge — the case that changed', () => {
    // byLabel.size > 1 here, so the OLD path allocated a dedupe Set while the new one sums bucket
    // sizes. Both must agree, and this is the only fixture that distinguishes them.
    const g = new Graph();

    addV(g, ['a', 'b', 'c', 'd']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'c', ['F']);
    addE(g, 'a', 'd', ['G']);

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(g.edgesFromByLabel.get('a')!.size).toBeGreaterThan(1);
    expect(countIncidentEdgesFlat(g.edgesFromByLabel.get('a'), undefined)).toBe(
      countIncidentEdges(g.edgesFromByLabel.get('a'), undefined),
    );
    expect(viaFlat(g, 'a', 'to')).toEqual(viaGenerator(g, 'a', 'to'));
  });

  test('parallel edges keep their multiplicity', () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'b', ['E']);

    expect(viaFlat(g, 'a', 'to')).toEqual([1, 1, 1]);
    expect(viaFlat(g, 'a', 'to')).toEqual(viaGenerator(g, 'a', 'to'));
  });

  test('a self-loop keeps its multiplicity in both directions', () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'a', ['E']);
    addE(g, 'a', 'b', ['E']);

    expect(viaFlat(g, 'a', 'to')).toEqual(viaGenerator(g, 'a', 'to'));
    expect(viaFlat(g, 'a', 'from')).toEqual(viaGenerator(g, 'a', 'from'));
  });

  test('an edgeLabel restriction selects one bucket, identically', () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'c', ['F']);

    expect(viaFlat(g, 'a', 'to', 'E')).toEqual(viaGenerator(g, 'a', 'to', 'E'));
    expect(viaFlat(g, 'a', 'to', 'E')).toEqual([1]);
    expect(viaFlat(g, 'a', 'to', 'F')).toEqual([2]);
  });

  test('an absent edgeLabel and an isolated vertex are both empty, not a throw', () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E']);

    expect(viaFlat(g, 'a', 'to', 'NOPE')).toEqual([]);
    expect(countIncidentEdgesFlat(g.edgesFromByLabel.get('b'), undefined)).toBe(0);
    expect(writeIncidentEnds(undefined, 'to', undefined, new Map(), new Int32Array(0), 0)).toBe(0);
  });

  test('writeIncidentEnds appends at the cursor rather than at zero', () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'c', 'a', ['E']);

    const index = vertexIndex(g);
    const buf = new Int32Array(2);
    let w = writeIncidentEnds(g.edgesFromByLabel.get('a'), 'to', undefined, index, buf, 0);

    w = writeIncidentEnds(g.edgesToByLabel.get('a'), 'from', undefined, index, buf, w);

    expect(w).toBe(2);
    // out-targets first, then in-sources — the order the CSR build relies on.
    expect([...buf]).toEqual([1, 2]);
  });
});

describe('both build arms agree end to end', () => {
  /**
   * The gate is a property of the GRAPH, so the same graph cannot be run through both arms. Instead
   * the component under test is identical in both graphs and the slow arm is forced by a two-label
   * edge between two EXTRA, otherwise-isolated vertices. The shared component's labels must match.
   */
  const component = (g: Graph): void => {
    addV(g, ['1', '2', '3', '4', '5', '6']);
    addE(g, '1', '2', ['E']);
    addE(g, '2', '3', ['E']);
    addE(g, '1', '3', ['E']);
    addE(g, '4', '5', ['F']);
    addE(g, '5', '6', ['F']);
    addE(g, '4', '6', ['F']);
    // a self-loop and a parallel edge, so the multiplicity paths are exercised in both arms
    addE(g, '1', '1', ['E']);
    addE(g, '2', '3', ['E']);
  };

  const fastArm = (): Graph => {
    const g = new Graph();

    component(g);
    expect(g.multiTypeEdgeCount).toBe(0);

    return g;
  };

  const slowArm = (): Graph => {
    const g = new Graph();

    component(g);
    addV(g, ['x', 'y']);
    addE(g, 'x', 'y', ['E', 'F']);
    expect(g.multiTypeEdgeCount).toBe(1);

    return g;
  };

  test('the shared component gets the same labels from either arm', async () => {
    const fast = map(await labelPropagation({}, fastArm()));
    const slow = map(await labelPropagation({}, slowArm()));

    for (const id of ['1', '2', '3', '4', '5', '6']) {
      expect(fast[id]).toBe(slow[id]);
    }
  });

  test('…under an edgeLabel restriction too', async () => {
    const fast = map(await labelPropagation({ edgeLabel: 'E' }, fastArm()));
    const slow = map(await labelPropagation({ edgeLabel: 'E' }, slowArm()));

    for (const id of ['1', '2', '3', '4', '5', '6']) {
      expect(fast[id]).toBe(slow[id]);
    }
  });

  test('…and with a seedProperty pinning a vertex', async () => {
    const seed = (g: Graph): Graph => {
      g.getVertexById('3')!.setProperty('anchor', 1);

      return g;
    };

    const fast = map(await labelPropagation({ seedProperty: 'anchor' }, seed(fastArm())));
    const slow = map(await labelPropagation({ seedProperty: 'anchor' }, seed(slowArm())));

    expect(fast['3']).toBe('3');

    for (const id of ['1', '2', '3', '4', '5', '6']) {
      expect(fast[id]).toBe(slow[id]);
    }
  });

  test('an empty graph and an all-isolated graph still return a row per vertex', async () => {
    expect(await labelPropagation({}, new Graph())).toEqual([]);

    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    expect(map(await labelPropagation({}, g))).toEqual({ a: 'a', b: 'b', c: 'c' });
  });
});
