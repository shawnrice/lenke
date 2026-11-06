import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  E,
  V,
  as_,
  both,
  count,
  has,
  identity,
  in_,
  match,
  not,
  out,
  pipe,
  select,
  toArray,
  traversal,
  values,
} from '../index.js';

/**
 * `match()`'s pattern expansion reads the adjacency bucket directly for a ONE single-type hop
 * instead of running the inner plan through `applyPlanToStream` (item 1627) — **1.08-1.11x** across
 * the three `match` shapes, which are the largest in the Gremlin probe.
 *
 * ⚠️ THE ORACLE IS A LONGER INNER PLAN. `soleHop` admits exactly one `out`/`in` with one label, so
 * appending `identity()` to the inner traversal makes the identical question take the general path —
 * and the two must agree ELEMENT FOR ELEMENT, because Gremlin stream order is a TinkerPop contract
 * the differential fuzzer compares ordered. That is checked here rather than argued: the fast arm
 * reads the same bucket in the same order and takes the same endpoint, but "the same by
 * construction" is what item 169 paid for believing.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  [P]  >b >c ~d
 *   b  [P]  >c
 *   c  [Q]  >c          a SELF-LOOP
 *   d  [P]  >a
 *   e  [Q]              no edges at all
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['P'],
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  { id: 'b', labels: ['P'], out: [['c', 'E']] },
  { id: 'c', labels: ['Q'], out: [['c', 'E']] },
  { id: 'd', labels: ['P'], out: [['a', 'E']] },
  { id: 'e', labels: ['Q'], out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    graph.addVertex({ id: r.id, labels: [...r.labels], properties: { id: r.id } });
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

const ids = (rows: readonly unknown[]): unknown[] =>
  rows.map((x) => (x !== null && typeof x === 'object' && 'id' in x ? x.id : x));

describe('the fast arm agrees with the general path, ORDERED', () => {
  /**
   * Each case runs twice: the inner plan as a bare hop (the fast arm) and with `identity()`
   * appended (the general path). ⚠️ `identity()` is the right disqualifier because it changes the
   * inner plan's LENGTH and nothing else — a second label or a `both` would change the question.
   */
  const bothWays = (inner: Parameters<typeof pipe>[number][], tail: unknown[]): void => {
    const fast = toArray(
      traversal(V(), match(pipe(as_('a'), ...inner, as_('b'))), ...(tail as never[])),
      g,
    );
    const general = toArray(
      traversal(V(), match(pipe(as_('a'), ...inner, identity(), as_('b'))), ...(tail as never[])),
      g,
    );

    expect(ids(fast)).toEqual(ids(general));
  };

  test('the BINDING branch — an unbound end, which is the common case', () => {
    bothWays([out('E')], [select('b')]);
    bothWays([in_('E')], [select('b')]);
    bothWays([out('F')], [select('b')]);
  });

  test('a SELF-LOOP binds its own vertex once', () => {
    const rows = toArray(
      traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), select('a'), select('a')),
      g,
    );

    // Every vertex with an `E` out-edge: a (twice, to b and c), b, c (the loop), d.
    expect(ids(rows).sort()).toEqual(['a', 'a', 'b', 'c', 'd']);
    bothWays([out('E')], [select('a')]);
  });

  test('the PURE FILTER branch — no end label at all', () => {
    const fast = toArray(traversal(V(), match(pipe(as_('a'), out('E'))), select('a')), g);
    const general = toArray(
      traversal(V(), match(pipe(as_('a'), out('E'), identity())), select('a')),
      g,
    );

    expect(ids(fast)).toEqual(ids(general));
    // `e` has no out-edge and is filtered; `a` appears ONCE (the pattern is a filter, not a fan-out).
    expect(ids(fast).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the BOUND-END branch — two patterns where the second end is already bound', () => {
    const fast = toArray(
      traversal(
        V(),
        match(pipe(as_('a'), out('E'), as_('b')), pipe(as_('b'), out('E'), as_('c'))),
        select('c'),
      ),
      g,
    );
    const general = toArray(
      traversal(
        V(),
        match(
          pipe(as_('a'), out('E'), identity(), as_('b')),
          pipe(as_('b'), out('E'), identity(), as_('c')),
        ),
        select('c'),
      ),
      g,
    );

    expect(ids(fast)).toEqual(ids(general));
    expect(ids(fast).length).toBeGreaterThan(0);
  });

  test('the NEGATED branch — `not(...)` over a bare hop', () => {
    const fast = toArray(traversal(V(), match(not(pipe(as_('a'), out('E')))), select('a')), g);
    const general = toArray(
      traversal(V(), match(not(pipe(as_('a'), out('E'), identity()))), select('a')),
      g,
    );

    expect(ids(fast)).toEqual(ids(general));
    // Only `e` has no `E` out-edge.
    expect(ids(fast)).toEqual(['e']);
  });

  test('a start with NO bucket for the type contributes nothing', () => {
    // No `G` edge exists at all, so every pattern over it is empty / every negation keeps all.
    expect(toArray(traversal(V(), match(pipe(as_('a'), out('G'), as_('b'))), count()), g)).toEqual([
      0,
    ]);
    expect(toArray(traversal(V(), match(not(pipe(as_('a'), out('G')))), count()), g)).toEqual([5]);
  });
});

describe('the fast arm DECLINES what it must, and the answer is unchanged', () => {
  const agree = (fastInner: unknown[], generalInner: unknown[]): void => {
    const run = (inner: unknown[]): unknown[] =>
      ids(
        toArray(
          traversal(V(), match(pipe(as_('a'), ...(inner as never[]), as_('b'))), select('b')),
          g,
        ),
      );

    expect(run(fastInner)).toEqual(run(generalInner));
  };

  test('`both` — it reaches a vertex from either side', () => {
    const rows = ids(
      toArray(traversal(V(), match(pipe(as_('a'), both('E'), as_('b'))), select('b')), g),
    );

    expect(rows.length).toBeGreaterThan(0);
    agree([both('E')], [both('E'), identity()]);
  });

  test('a MULTI-TYPE hop — `expand` dedupes across the per-type buckets', () => {
    agree([out('E', 'F')], [out('E', 'F'), identity()]);
    const rows = ids(
      toArray(traversal(V(), match(pipe(as_('a'), out('E', 'F'), as_('b'))), select('b')), g),
    );

    // `a` has `E` to b and c plus `F` to d, so three distinct ends from `a` alone.
    expect(rows.length).toBeGreaterThan(3);
  });

  test('an UNTYPED hop, and a LONGER inner plan', () => {
    agree([out()], [out(), identity()]);
    agree([out('E'), has('id', 'c')], [out('E'), has('id', 'c'), identity()]);
  });

  test('a NON-VERTEX start falls back rather than faulting', () => {
    /**
     * ⚠️ `isVertex(from)` IS A FALLBACK, NOT A GUARD. `bucketEnds` cannot read an adjacency off a
     * scalar, and the general path is LENIENT there — `traverseToVertex` yields nothing for a
     * non-vertex rather than throwing — so returning `undefined` keeps that behaviour exactly.
     * A `select` of a tag holding a scalar is the spelling that gets a scalar past the frontier
     * checker (item 1616 found the same route for `optional`).
     */
    const scalar = traversal(
      V(),
      values('id'),
      as_('s'),
      select('s'),
      as_('a'),
      match(pipe(as_('a'), out('E'), as_('b'))),
      count(),
    );

    expect(toArray(scalar, g)).toEqual([0]);
  });

  test('an EDGE start — the realistic non-vertex, and both arms answer nothing', () => {
    /**
     * An edge has `from`/`to` and no adjacency, so it is the value most likely to reach
     * `bucketEnds` without being a vertex. Both arms answer 0, which is what makes the `isVertex`
     * fallback redundant — asserted so that stays true if `traverseToVertex` ever stops being
     * lenient.
     */
    const fast = traversal(E(), as_('a'), match(pipe(as_('a'), out('E'), as_('b'))), count());
    const general = traversal(
      E(),
      as_('a'),
      match(pipe(as_('a'), out('E'), identity(), as_('b'))),
      count(),
    );

    expect(toArray(fast, g)).toEqual([0]);
    expect(toArray(general, g)).toEqual([0]);
  });
});
