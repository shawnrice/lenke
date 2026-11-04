import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from './executor.js';
import { V, both, bothE, count, inE, in_, out, outE, toList, traversal } from './index.js';

/**
 * An edge carries a SET of labels and the directional index buckets it under
 * every one of them, so a step that walks a bucket per named label sees a
 * two-label edge once per matching name. Native walks one adjacency list and
 * tests "does this edge carry any of these types", emitting it once — so a
 * duplicate here is a cross-engine divergence.
 */
/** The executor yields a stream; every assertion here is over the drained list. */
const arr = (r: Iterable<unknown>): unknown[] => [...r];

const twoLabelChain = (): Graph => {
  const graph = new Graph();

  for (const id of ['a', 'b']) {
    graph.addVertex({ id, labels: ['V'], properties: {} });
  }

  graph.addEdge({
    id: 'e0',
    from: graph.getVertexById('a')!,
    to: graph.getVertexById('b')!,
    labels: ['R', 'S'],
  });

  return graph;
};

describe('an edge matching several named labels traverses once', () => {
  test('naming both of an edge’s labels yields one edge', () => {
    const graph = twoLabelChain();

    expect(arr(run(traversal(V('a'), outE('R', 'S'), count()), graph))).toEqual([1]);
    expect(arr(run(traversal(V('a'), out('R', 'S'), count()), graph))).toEqual([1]);
  });

  test('in and both agree with out', () => {
    const graph = twoLabelChain();

    expect(arr(run(traversal(V('b'), inE('R', 'S'), count()), graph))).toEqual([1]);
    expect(arr(run(traversal(V('a'), bothE('R', 'S'), count()), graph))).toEqual([1]);
    expect(arr(run(traversal(V('b'), bothE('R', 'S'), count()), graph))).toEqual([1]);
  });

  test('naming both labels matches naming either one', () => {
    const graph = twoLabelChain();
    const one = arr(run(traversal(V('a'), outE('R'), toList()), graph));

    expect(arr(run(traversal(V('a'), outE('S'), toList()), graph))).toEqual(one);
    expect(arr(run(traversal(V('a'), outE('R', 'S'), toList()), graph))).toEqual(one);
    // ...and naming no label at all, since every edge here carries both.
    expect(arr(run(traversal(V('a'), outE(), toList()), graph))).toEqual(one);
  });

  test('a named label that no edge carries adds nothing', () => {
    const graph = twoLabelChain();

    expect(arr(run(traversal(V('a'), outE('R', 'ABSENT'), count()), graph))).toEqual([1]);
    expect(arr(run(traversal(V('a'), outE('ABSENT'), count()), graph))).toEqual([0]);
  });
});

/**
 * THE UNION COUNT (item 1379). `adjacentCount` answers `out/in/outE/inE(...).count()` from bucket
 * SIZES, and with several labels it used to DECLINE whenever any edge carried two types — because
 * summing buckets double-counts such an edge. Declining sent the query to the traverser pipeline,
 * which item 1378 measured at ~495 ns an edge: `outE('E','F').count()` **198.045 ms** against
 * `outE('E')`'s 0.008. It now counts the UNION instead, which is 110x on that row.
 *
 * THE FIXTURE IS BUILT SO THE SUM IS WRONG. `|E|` = 3 and `|F|` = 3, so a summing implementation
 * answers 6 where the union is 4 — the assertions below cannot pass by accident. `e4` is a SELF-LOOP
 * carrying both labels, which is what keeps the `both*` doubling honest (items 1087/1089: a loop is
 * one edge from its source and one from its target).
 */
const unionFixture = (): Graph => {
  const graph = new Graph();

  for (const id of ['a', 'b', 'c']) {
    graph.addVertex({ id, labels: ['P'], properties: {} });
  }

  const v = (id: string) => graph.getVertexById(id)!;

  graph.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['E', 'F'] });
  graph.addEdge({ id: 'e2', from: v('a'), to: v('c'), labels: ['E'] });
  graph.addEdge({ id: 'e3', from: v('b'), to: v('c'), labels: ['F'] });
  graph.addEdge({ id: 'e4', from: v('a'), to: v('a'), labels: ['E', 'F'] });

  return graph;
};

const n = (...steps: readonly unknown[]): unknown =>
  arr(run(traversal(...(steps as never[])), unionFixture()))[0];

describe('a multi-label count is the UNION of buckets, not their sum (item 1379)', () => {
  test('the single-label buckets are 3 and 3, so a SUM would answer 6', () => {
    expect(n(V(), outE('E'), count())).toBe(3);
    expect(n(V(), outE('F'), count())).toBe(3);
  });

  test('outE over both labels counts each edge once', () => {
    // 4, not 6: e1 and e4 sit in both buckets.
    expect(n(V(), outE('E', 'F'), count())).toBe(4);
    expect(n(V(), inE('E', 'F'), count())).toBe(4);
  });

  test('the VERTEX steps agree with the edge steps', () => {
    expect(n(V(), out('E', 'F'), count())).toBe(4);
    expect(n(V(), in_('E', 'F'), count())).toBe(4);
  });

  test('both/bothE are TWICE the union, self-loop included', () => {
    // Each edge is yielded once from its source and once from its target, the loop too.
    expect(n(V(), bothE('E', 'F'), count())).toBe(8);
    expect(n(V(), both('E', 'F'), count())).toBe(8);
  });

  test('a DUPLICATE label names one bucket twice and counts it once', () => {
    expect(n(V(), outE('E', 'E'), count())).toBe(3);
  });

  test('an ABSENT label contributes nothing', () => {
    expect(n(V(), outE('E', 'Z'), count())).toBe(3);
    expect(n(V(), outE('Z', 'W'), count())).toBe(0);
  });

  test('past the label CAP it declines and the pipeline still answers', () => {
    // Nine labels exceeds UNION_COUNT_MAX_LABELS, so this takes the old route. The ANSWER must
    // not depend on which route ran, which is the whole point of a perf decline.
    expect(n(V(), outE('E', 'F', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'), count())).toBe(4);
  });
});
