import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, both, toArray, traversal, values } from './index.js';

/**
 * `both()` over a SELF-LOOP yields it TWICE — unguarded until item 1432's mutation run said so.
 *
 * Item 1432 gave `both(T)` a hand walk (181 → 61 ms, 64.6%). Five mutants; four behaved as
 * predicted, and one did not: **skipping self-loops in the in-pass SURVIVED the whole 1,214-test
 * suite.** Nothing covered a self-loop under `both`, so the behaviour was free to change silently in
 * either direction.
 *
 * ⚠️ TWICE IS THE PRE-EXISTING CONTRACT, read off the source rather than assumed. `iterBoth` is
 * `yield* iterByLabel(fromByLabel, labels)` followed by `yield* iterByLabel(toByLabel, labels)`,
 * with no self-loop filter — and a loop `a -> a` sits in BOTH `adjFrom` and `adjTo`. Its own comment
 * says "out-edges first, then in-edges, to match TinkerPop's `both`/`bothE` ordering", so the vertex
 * is adjacent to itself twice over.
 *
 * ⚠️ AND IT IS THE OPPOSITE OF THE GQL RULE, which is why this is worth pinning rather than
 * obvious. GQL's undirected hop emits a self-loop ONCE — item 1431's edge pass skips the second
 * direction for `from === to`, and `shortcuts.ts` says "a SELF-LOOP contributes one, because
 * `expand` yields it once". Two engines, two deliberate contracts, one easy mistake: carrying the
 * GQL rule across is exactly what mutant M2 did, and nothing stopped it.
 */

const loopGraph = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  g.addEdge({ id: 'aa', from: g.getVertexById('a')!, to: g.getVertexById('a')!, labels: ['E'] });
  g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });

  return g;
};

const ks = (g: Graph, plan: ReturnType<typeof traversal>): unknown[] => toArray(plan, g);

describe('both() over a self-loop (item 1432)', () => {
  test('⚠️ the loop is yielded TWICE, in out-then-in order', () => {
    // From `a`: out-bucket holds `aa` then `ab` (insertion order) → k=1, k=2. In-bucket holds `aa`
    // → k=1. From `b`: out-bucket empty; in-bucket holds `ab` → k=1.
    //
    // So the full stream is [1, 2, 1, 1]. ORDER IS ASSERTED, not sorted: this is the TinkerPop
    // contract the differential fuzzer compares ordered, and it is what makes the edge-index route
    // item 1431 used in GQL unavailable here.
    expect(ks(loopGraph(), traversal(V(), both('E'), values('k')))).toEqual([1, 2, 1, 1]);
  });

  test('the loop vertex alone yields itself twice', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 7 } });
    g.addEdge({ id: 'aa', from: g.getVertexById('a')!, to: g.getVertexById('a')!, labels: ['E'] });

    expect(ks(g, traversal(V(), both('E'), values('k')))).toEqual([7, 7]);
  });

  test('and the MULTI-type spelling agrees, which routes through the helpers instead', () => {
    // `both('E', 'F')` has two labels, so `bothOneType` declines and the general `adjacentEdges`
    // tail serves it. Same answer on a graph with no `F`, which is the cross-check that the hand
    // walk reproduces the helper chain rather than inventing its own order.
    const g = loopGraph();

    expect(ks(g, traversal(V(), both('E', 'F'), values('k')))).toEqual(
      ks(g, traversal(V(), both('E'), values('k'))),
    );
  });

  test('a loop and a parallel edge together keep every contribution', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
    g.addEdge({ id: 'aa', from: g.getVertexById('a')!, to: g.getVertexById('a')!, labels: ['E'] });
    g.addEdge({ id: 'e1', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
    g.addEdge({ id: 'e2', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });

    // a: out = aa, e1, e2 → 1, 2, 2; in = aa → 1. b: in = e1, e2 → 1, 1.
    expect(ks(g, traversal(V(), both('E'), values('k')))).toEqual([1, 2, 2, 1, 1, 1]);
  });
});
