import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  both,
  count,
  identity,
  in_,
  optional,
  out,
  pipe,
  toArray,
  traversal,
  values,
} from '../index.js';
import { soleTypeBucket } from './movement.js';

/**
 * `optionalHopStep` reads the adjacency bucket directly for a DIRECTED SINGLE-TYPE hop instead of
 * going through `adjacentEdges` + `otherEndpoint` (item 1628) — **1.25x** on
 * `V().optional(out(T)).values(k)`, with the bare-hop floor flat.
 *
 * Item 1480 priced this shape at 19.3x its floor and identified the cause: `optionalSingleHop`
 * removed the sub-plan DISPATCH, and what was left was the generator chain at **~61%**
 * (`otherEndpoint` 20.97% + `iterLabeled` 19.47% + `get to` 7.57% + `traverseToVertex` 5.41% +
 * `iterByLabel` 4.21% + `outEdgesOf` 3.25%). This takes that chain for the one hop shape where there
 * is a single `Set` and nothing to dedupe.
 *
 * ⚠️ THE ORACLE IS A TWO-STEP SUB-PLAN. `optionalSingleHop` admits exactly one step, so appending
 * `identity()` sends the identical question to the general `optionalStep` — and `identity()` is the
 * right disqualifier because it changes the sub-plan's LENGTH and nothing else. Gremlin stream order
 * is a TinkerPop contract compared ORDERED by the differential fuzzer, so every comparison here is
 * element for element.
 *
 * ⚠️ AND THE `optional` FALLBACK IS THE RISK THE FAST ARM CARRIES. The step yields the incoming
 * traverser when the hop produces NOTHING, so a fast arm that reported an empty bucket as "no
 * iteration happened" versus "iterated zero edges" would drop or duplicate that row. Every case
 * below includes a vertex with no matching edge.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  k=1  >b >c ~d
 *   b  k=2  >c
 *   c  k=3  >c          a SELF-LOOP
 *   d  k=4  >a
 *   e  k=5              NO edges — the fallback case
 * ```
 */
const TABLE = [
  {
    id: 'a',
    k: 1,
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  { id: 'b', k: 2, out: [['c', 'E']] },
  { id: 'c', k: 3, out: [['c', 'E']] },
  { id: 'd', k: 4, out: [['a', 'E']] },
  { id: 'e', k: 5, out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    graph.addVertex({ id: r.id, labels: ['P'], properties: { id: r.id, k: r.k } });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      graph.addEdge({
        id: `e${n++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  return graph;
})();

/** The fast arm against the general `optionalStep`, element for element. */
const bothWays = (inner: Parameters<typeof pipe>[number]): void => {
  const fast = toArray(traversal(V(), optional(pipe(inner)), values('k')), g);
  const general = toArray(traversal(V(), optional(pipe(inner, identity())), values('k')), g);

  expect(fast).toEqual(general);
};

describe('the fast arm agrees with the general optional, ORDERED', () => {
  test('`out(E)` — the shape at 1.25x', () => {
    /**
     * Derived. Per vertex in insertion order: `a` has E-edges to b(2) and c(3); `b` to c(3); `c` the
     * self-loop to itself(3); `d` to a(1); `e` has NONE so the optional yields `e` ITSELF, whose `k`
     * is 5. So [2, 3, 3, 3, 1, 5].
     */
    expect(toArray(traversal(V(), optional(pipe(out('E'))), values('k')), g)).toEqual([
      2, 3, 3, 3, 1, 5,
    ]);
    bothWays(out('E'));
  });

  test('`in(E)`, which reads the other box', () => {
    bothWays(in_('E'));
  });

  test('a type only ONE vertex carries, so four rows are the FALLBACK', () => {
    // Only `a` has an `F` edge (to d, k=4); every other vertex yields itself.
    expect(toArray(traversal(V(), optional(pipe(out('F'))), values('k')), g)).toEqual([
      4, 2, 3, 4, 5,
    ]);
    bothWays(out('F'));
  });

  test('⚠️ a type NO vertex carries — every row is the fallback', () => {
    /**
     * The whole stream must come back unchanged. This is the case a fast arm gets wrong if an empty
     * bucket is reported as "declined" rather than "zero edges": the rows would be dropped, or
     * emitted twice if both arms ran.
     */
    expect(toArray(traversal(V(), optional(pipe(out('G'))), values('k')), g)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(toArray(traversal(V(), optional(pipe(out('G'))), count()), g)).toEqual([5]);
    bothWays(out('G'));
  });
});

describe('the fast arm declines what it must', () => {
  test('`both` — out-bucket then in-bucket per vertex, and a self-loop deduped', () => {
    expect(soleTypeBucket(g.getVertexById('a') as Vertex, 'both', ['E'])).toBeUndefined();
    bothWays(both('E'));
  });

  test('a MULTI-TYPE hop — the cross-bucket dedupe', () => {
    expect(soleTypeBucket(g.getVertexById('a') as Vertex, 'out', ['E', 'F'])).toBeUndefined();
    bothWays(out('E', 'F'));
  });

  test('an UNTYPED hop, which walks every bucket', () => {
    expect(soleTypeBucket(g.getVertexById('a') as Vertex, 'out', [])).toBeUndefined();
    bothWays(out());
  });

  test('⚠️ an EMPTY bucket returns a SHAPE, not `undefined`', () => {
    /**
     * `undefined` means "this hop needs `adjacentEdges`"; an empty bucket means "this vertex has no
     * such edge". Conflating them sends every zero-degree vertex down the general path for nothing —
     * and more importantly makes the two meanings indistinguishable at the call site.
     */
    expect(soleTypeBucket(g.getVertexById('e') as Vertex, 'out', ['E'])).toEqual({
      set: new Set(),
      forward: true,
    });
    expect(soleTypeBucket(g.getVertexById('a') as Vertex, 'out', ['E'])?.forward).toBe(true);
    expect(soleTypeBucket(g.getVertexById('a') as Vertex, 'in', ['E'])?.forward).toBe(false);
  });
});
