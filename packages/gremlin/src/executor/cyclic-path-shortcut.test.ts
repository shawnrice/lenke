import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';

import {
  V,
  count,
  cyclicPath,
  in_,
  limit,
  out,
  outE,
  inV,
  toArray,
  traversal,
  values,
} from '../index.js';
import { cyclicPathShortcut } from './cyclic-path-shortcut.js';

/**
 * The `V().out(T).cyclicPath()` rung — which item 1986 shipped with NO direct test, and item 2407
 * found that out while replacing its walk.
 *
 * 🔑 **EVERY ASSERTION HERE DRIVES `cyclicPathShortcut` DIRECTLY**, not a traversal, because the
 * general path answers this shape identically and a test that went through `toArray` would pass just
 * as well with the rung deleted. Item 1986's own entry records route-counting for that reason ("this
 * session has twice had a test pass against the wrong arm"); one end-to-end case at the bottom
 * confirms the wiring, and that one is the ONLY place a green result is ambiguous.
 *
 * ⚠️ **ROW ORDER IS DELIBERATELY NOT ASSERTED.** Item 2400's owner ruling makes walk order
 * implementation-dependent, and item 2407 took the edge-set drive BECAUSE of it — the rows now come
 * in edge-insertion order rather than vertex order. So every answer here is compared as a MULTISET.
 * A test that pinned the sequence would be pinning the implementation, which is item 2404's
 * distinction, and it would have to be rewritten by the next change rather than catching one.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const vx = (id: string): Vertex => g.getVertexById(id) as Vertex;

  // A plain hop: present so a route that ignored the self-loop test would over-return.
  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
  /*
   * ⚠️ TWO PARALLEL SELF-LOOPS AT ONE VERTEX, which is the ONE discrimination this fixture exists
   * for: the answer is one row per self-loop EDGE, not per vertex, and item 1986 verified that
   * against the engine before writing the rung. A fixture with at most one self-loop per vertex
   * cannot tell the two readings apart, so without this pair a per-vertex regression passes.
   */
  g.addEdge({ id: 'e2', from: vx('a'), to: vx('a'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: vx('a'), to: vx('a'), labels: ['E'], properties: {} });
  // A lone self-loop elsewhere, so the answer is not a single vertex's story.
  g.addEdge({ id: 'e4', from: vx('c'), to: vx('c'), labels: ['E'], properties: {} });
  // ⚠️ A self-loop of ANOTHER type: `out('E')` must not return it, or the type filter is vacuous.
  g.addEdge({ id: 'e5', from: vx('d'), to: vx('d'), labels: ['F'], properties: {} });

  return g;
};

/** The answer by brute force over every edge — an oracle that shares no code with the rung. */
const selfLoopsOfType = (g: Graph, type: string): string[] =>
  [...g.edges]
    .filter((e: Edge) => [...e.labels].includes(type) && e.from === e.to)
    .map((e: Edge) => String(e.from.id))
    .sort();

const ids = (rows: readonly unknown[] | undefined): string[] =>
  [...(rows ?? [])].map((v) => String((v as Vertex)?.id ?? v)).sort();

const sorted = (xs: readonly unknown[] | undefined): unknown[] =>
  [...(xs ?? [])].map(String).sort();

describe('the one-hop cyclicPath rung', () => {
  it('returns one row per self-loop EDGE, parallel loops included', () => {
    const g = fixture();
    const rows = cyclicPathShortcut(traversal(V(), out('E'), cyclicPath()), g);

    // `a` twice for its two parallel loops, `c` once. Not `['a','c']`, which is the per-vertex bug.
    expect(ids(rows)).toStrictEqual(['a', 'a', 'c']);
    expect(ids(rows)).toStrictEqual(selfLoopsOfType(g, 'E'));
  });

  it('agrees between out and in, because a self-loop sits in both directions', () => {
    const g = fixture();

    expect(ids(cyclicPathShortcut(traversal(V(), in_('E'), cyclicPath()), g))).toStrictEqual([
      'a',
      'a',
      'c',
    ]);
  });

  it('filters by edge type rather than returning every self-loop', () => {
    const g = fixture();

    // `d`'s loop is type F. If this ever returns it, the type filter stopped working and the
    // assertions above would still pass.
    expect(ids(cyclicPathShortcut(traversal(V(), out('F'), cyclicPath()), g))).toStrictEqual(['d']);
    expect(ids(cyclicPathShortcut(traversal(V(), out('E'), cyclicPath()), g))).not.toContain('d');
  });

  it('projects a trailing single-key values', () => {
    const g = fixture();
    const rows = cyclicPathShortcut(traversal(V(), out('E'), cyclicPath(), values('n')), g);

    expect(sorted(rows)).toStrictEqual(['a', 'a', 'c']);
  });

  /**
   * ⚠️ THE WALK'S NEW LOAD-BEARING DEPENDENCY. Item 2407 drives `graph.edgesByLabel` instead of each
   * vertex's bucket, so a label bucket that kept a removed edge would make this rung return a row the
   * per-vertex walk could not — a WRONG ANSWER, not a reorder. `edge-endpoint-ids.test.ts` pins the
   * de-indexing in core; this pins that the rung actually benefits from it.
   */
  it('drops a self-loop that has been removed', () => {
    const g = fixture();
    const loop = g.getEdgeById('e4') as Edge;

    g.removeEdge(loop);

    expect(ids(cyclicPathShortcut(traversal(V(), out('E'), cyclicPath()), g))).toStrictEqual([
      'a',
      'a',
    ]);
  });

  it('declines the shapes it does not serve', () => {
    const g = fixture();
    const declines = (plan: ReturnType<typeof traversal>): void => {
      expect(cyclicPathShortcut(plan, g)).toBeUndefined();
    };

    /*
     * ⚠️ `both` IS THE ONE THAT MATTERS: a `both` hop reaches a self-loop from each of its two
     * boxes, so the multiplicity is not one row per edge and this route's answer would be WRONG
     * rather than merely ordered differently.
     */
    declines(traversal(V(), count()));
    declines(traversal(V(), out('E', 'F'), cyclicPath()));
    declines(traversal(V(), out(), cyclicPath()));
    declines(traversal(V(), outE('E'), inV(), cyclicPath()));
    declines(traversal(V(), out('E'), cyclicPath(), values('n', 'k')));
    declines(traversal(V(), out('E'), cyclicPath(), count()));
    declines(traversal(V(), out('E'), cyclicPath(), limit(2)));
  });

  /**
   * The ONLY end-to-end case: it confirms the rung is wired into `index.ts` and agrees with the
   * traversal surface. It cannot tell which route answered, which is why every assertion above
   * calls the rung directly.
   */
  it('is wired, and the traversal agrees as a multiset', () => {
    const g = fixture();

    expect(ids(toArray(traversal(V(), out('E'), cyclicPath()), g))).toStrictEqual(['a', 'a', 'c']);
    expect(sorted(toArray(traversal(V(), out('E'), cyclicPath(), values('n')), g))).toStrictEqual([
      'a',
      'a',
      'c',
    ]);
  });
});
