import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, out, run, toArray, traversal, values } from './index.js';

/**
 * The multi-type walk's earlier-buckets dedupe: coverage, and the record of a DECLINED skip
 * (item 1413).
 *
 * `V().out('E','F')` walks one bucket per named label, so an edge carrying BOTH `E` and `F` sits in
 * two of them and must be emitted once. These tests pin that, and they are kept because the walk had
 * almost no coverage of it before — the fixtures differ in exactly one bit (whether one edge carries
 * both labels), so a duplicated or lost row is visible as a changed MULTISET rather than a count.
 *
 * ⚠️ THE OPTIMIZATION THEY WERE WRITTEN FOR WAS DECLINED, and the numbers are why. A post-drain
 * profile put 60.1% of this row in the walk, so the plan was to skip the scan when
 * `graph.multiTypeEdgeCount === 0` — no edge with two labels means no edge in two buckets, the same
 * one-sided test GQL uses for `sumIsExact`. Measured on a DISJOINT fixture (`MULTILABEL=-1`, added
 * to the Gremlin bench in this item):
 *
 *   hopyieldmulti      ML=-1   58.72 -> 58.99   -0.5%   35/81   the target: NO WIN
 *   hopyieldmulti      ML=3    60.77 -> 65.34   -7.5%    6/81   the dedupe still runs: REGRESSES
 *   hopbare   [CTRL]   ML=0    16.33 -> 16.89   -3.5%   29/81   a walk the change cannot reach
 *   hopyieldsingle     ML=0    28.31 -> 29.94   -5.8%   12/81   likewise
 *
 * Three things that measurement settles. The 60.1% was a share of the WHOLE walk — adjacency
 * iteration, the emit, the `pick` — not of the scan, which is a small part of it: a share is a
 * nomination and an ablation is the price. The guard costs a real 7.5% where it cannot help. And
 * **two single-type controls regressed**, on a branch the edit does not touch, which is the
 * file-perturbation effect already recorded for `exec::pull` (1.08-1.24x on unrelated clusters) and
 * for a walk inlined in a returned closure (4x on unrelated queries). Editing this file is not free.
 *
 * ⚠️ AND THE FIRST RUN OF THAT A/B WAS MEASURING NOTHING. At `MULTILABEL=0` every edge is `['E']`,
 * so the `F` bucket is empty on every vertex and the scan never executes in EITHER arm. It reported
 * 5.5% against a control moving 4.8%. The same missing fixture shape the GQL bench had until item
 * 1405, found twice — the second time after it had already cost a reading.
 *
 * So: do not re-attempt the skip without an isolated per-row instrument. The decision is also
 * per CALL rather than per compile, which the last describe block pins — kept because it is a real
 * property of `hopValuesShortcut` being consulted on every `run`, not an artifact of the declined
 * change.
 */

/**
 * `a -> b` on `E`, `b -> c` on `F`, `c -> d` on `E`, and `a -> e` on `E` plus — when `shared` — ALSO
 * `F`, so exactly one edge is in two buckets. Every vertex has a distinct `k`, so a duplicated row
 * is visible as a repeated value rather than hidden among equal ones.
 */
const build = (shared: boolean): Graph => {
  const g = new Graph();

  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
    ['e', 5],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { k } });
  }

  const e = (id: string, from: string, to: string, labels: string[]): void => {
    g.addEdge({ id, from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels });
  };

  e('ab', 'a', 'b', ['E']);
  e('bc', 'b', 'c', ['F']);
  e('cd', 'c', 'd', ['E']);
  e('ae', 'a', 'e', shared ? ['E', 'F'] : ['E']);

  return g;
};

/** The row multiset, sorted — a duplicate shows up as a repeat, a loss as an absence. */
const bag = (g: Graph, src: () => ReturnType<typeof traversal>): number[] =>
  (toArray(src(), g) as number[]).slice().sort((x, y) => x - y);

const EF = (): ReturnType<typeof traversal> => traversal(V(), out('E', 'F'), values('k'));
const FE = (): ReturnType<typeof traversal> => traversal(V(), out('F', 'E'), values('k'));

describe('no edge in two buckets: the dedupe finds nothing and the answer is right (item 1413)', () => {
  test('the four far ends appear exactly once each', () => {
    // `a->b`(2), `b->c`(3), `c->d`(4), `a->e`(5). No shared edge, so no duplicate is possible.
    expect(bag(build(false), EF)).toEqual([2, 3, 4, 5]);
  });

  test('and `multiTypeEdgeCount` distinguishes the two fixtures, which is what made them a pair', () => {
    // ⚠️ WITHOUT THIS the suite could be testing the SLOW path on both fixtures and reporting
    // success for a skip that never happened — the same vacuity trap item 540's label drop sets.
    expect(build(false).multiTypeEdgeCount).toBe(0);
    expect(build(true).multiTypeEdgeCount).toBe(1);
  });

  test('the label-arg order is a permutation of the same rows', () => {
    expect(bag(build(false), FE)).toEqual([2, 3, 4, 5]);
  });

  test('toArray and [...run] still agree, so the eager twin got the same treatment', () => {
    const g = build(false);

    expect(toArray(EF(), g)).toEqual([...run(EF(), g)]);
    expect(toArray(FE(), g)).toEqual([...run(FE(), g)]);
  });
});

describe('an edge IN two buckets: the dedupe must still fire (item 1413)', () => {
  test('⚠️ the shared edge is emitted ONCE, not twice', () => {
    // `ae` carries both `E` and `F`, so it is in both buckets. With the dedupe wrongly skipped the
    // answer is [2, 3, 4, 5, 5] — the `5` doubled. This is the wrong-answer guard.
    expect(bag(build(true), EF)).toEqual([2, 3, 4, 5]);
  });

  test('and once in the reversed spelling too', () => {
    expect(bag(build(true), FE)).toEqual([2, 3, 4, 5]);
  });

  test('both label orders agree with their own lazy twin', () => {
    const g = build(true);

    expect(toArray(EF(), g)).toEqual([...run(EF(), g)]);
    expect(toArray(FE(), g)).toEqual([...run(FE(), g)]);
  });

  test('the two fixtures differ in EDGE COUNT but not in row count', () => {
    // Same four edges either way; `shared` only adds a label to one of them. So a difference in
    // the row bag can only come from the dedupe, which is what makes the pair a controlled
    // comparison rather than two unrelated graphs.
    expect(bag(build(true), EF)).toEqual(bag(build(false), EF));
  });
});

describe('a multi-label edge ELSEWHERE does not disturb these labels (item 1413)', () => {
  test('an unrelated multi-label edge keeps the scan on, and the answer is right either way', () => {
    // `X`+`Y` on an edge that neither `E` nor `F` names. The dedupe is unconditional today, so the
    // answer cannot depend on this — the test exists for whoever re-attempts the declined skip,
    // because `multiTypeEdgeCount` is GLOBAL and would read non-zero here, making the skip
    // conservative rather than wrong. That is the only acceptable direction, and narrowing the
    // counter to the named labels would have to be a deliberate change against this case.
    const g = build(false);

    g.addEdge({
      id: 'xy',
      from: g.getVertexById('d')!,
      to: g.getVertexById('e')!,
      labels: ['X', 'Y'],
    });

    expect(g.multiTypeEdgeCount).toBe(1);
    expect(bag(g, EF)).toEqual([2, 3, 4, 5]);
  });
});

describe('the decision is PER CALL, not per compile (item 1413)', () => {
  test('⚠️ adding a shared edge between two runs flips it', () => {
    // THE PER-COMPILE GUARD. One graph, one plan shape, mutated in between. A hoist that decided
    // once would answer the second run with the first run's decision and emit `5` twice.
    const g = build(false);

    expect(bag(g, EF)).toEqual([2, 3, 4, 5]);

    // Promote the existing `a->e` to carry `F` as well, so it now sits in both buckets.
    g.addLabelToEdge('F', g.getEdgeById('ae')!);

    expect(g.multiTypeEdgeCount).toBe(1);
    expect(bag(g, EF)).toEqual([2, 3, 4, 5]);
  });

  test('and removing it flips back', () => {
    const g = build(true);

    expect(bag(g, EF)).toEqual([2, 3, 4, 5]);

    g.removeLabelFromEdge('F', g.getEdgeById('ae')!);

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(bag(g, EF)).toEqual([2, 3, 4, 5]);
  });
});
