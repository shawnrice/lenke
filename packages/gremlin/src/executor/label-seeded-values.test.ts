/*
 * Item 2037 — `V().hasLabel(L).values(k)` fused onto `seedFromIndex`'s stream.
 *
 * ⚠️⚠️ **EVERY TEST HERE NEEDS A NON-VACUOUS LABEL, AND THAT IS THE WHOLE POINT.** `dropVacuousLabels`
 * REMOVES a `hasLabel` step that every vertex satisfies, so on a single-label graph this plan becomes
 * `V().values(k)` and `nodeValuesShortcut` answers it — the code under test is never reached. One
 * ISOLATED off-label vertex (no edges, so no answer changes) is what makes the step survive. A
 * single-label fixture would pass every assertion below while exercising nothing, which is item
 * 2018's lesson: 13 passing tests exercised none of a new path.
 *
 * ⚠️ THE ROUTE IS OBSERVABLE THROUGH `drain`: this fusion consumed the whole plan, so it offers one,
 * while the generic pipeline returns a bare generator. That is the only way to see a route that is
 * ANSWER-EQUIVALENT by construction ([[perf-gate-needs-its-own-test]]).
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { count, hasLabel, limit, out, path, run, toArray, traversal, V, values } from '../index.js';
import { labelSeededValuesFusion } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ] as const) {
    g.addVertex({ id, labels: ['T'], properties: { k, other: `o${k}` } });
  }

  // No `k` at all — its row must be DROPPED, not emitted as `undefined`.
  g.addVertex({ id: 'd', labels: ['T'], properties: { other: 'od' } });

  // ⚠️ THE OFF-LABEL VERTEX that makes `T` non-vacuous, so the `hasLabel` step survives. Isolated and
  // off-label, so it contributes to no answer here.
  g.addVertex({ id: 'off', labels: ['Q'], properties: { k: 99 } });

  g.addEdge({ id: 'e1', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });

  return g;
};

const claimed = (t: ReturnType<typeof traversal>, g: Graph): boolean =>
  typeof (run(t, g) as { drain?: () => unknown[] }).drain === 'function';

describe('label-seeded values fusion (item 2037)', () => {
  const g = build();

  test('THE FIXTURE IS NON-VACUOUS, which every other test here depends on', () => {
    /*
     * Asserted rather than assumed: if `off` were ever dropped from `build`, `T` would cover every
     * vertex, `dropVacuousLabels` would delete the step, and the suite would go green while testing
     * a different route entirely.
     */
    expect(g.verticesByLabel.get('T')?.size).toBe(4);
    expect(g.vertexCount).toBe(5);
  });

  test('the values are correct, and a missing key is DROPPED not emitted', () => {
    /*
     * ⚠️ `toStrictEqual`, not `toEqual`: bun's `toEqual` treats a trailing `undefined` as equal to its
     * absence, so a mutant emitting `undefined` for `d` survives `toEqual`
     * ([[toequal-blind-to-trailing-undefined]]). `d` is LAST in insertion order, which is exactly the
     * position that blindness covers.
     */
    expect(toArray(traversal(V(), hasLabel('T'), values('k')), g)).toStrictEqual([1, 2, 3]);
  });

  test('THE ROUTE: the fusion claims the shape and offers a drain', () => {
    expect(claimed(traversal(V(), hasLabel('T'), values('k')), g)).toBe(true);
  });

  test('a SECOND key declines — `values(a, b)` fans out per key, not one read per element', () => {
    expect(claimed(traversal(V(), hasLabel('T'), values('k', 'other')), g)).toBe(false);
    expect(toArray(traversal(V(), hasLabel('T'), values('k', 'other')), g)).toStrictEqual([
      1,
      'o1',
      2,
      'o2',
      3,
      'o3',
      'od',
    ]);
  });

  test('`values()` with NO key declines — it emits every property value', () => {
    expect(claimed(traversal(V(), hasLabel('T'), values()), g)).toBe(false);
    expect(toArray(traversal(V(), hasLabel('T'), values()), g)).toStrictEqual([
      1,
      'o1',
      2,
      'o2',
      3,
      'o3',
      'od',
    ]);
  });

  test('a TRAILING step declines, because it would land after the fused values', () => {
    // `limit` compiles to `take` and lands in the seed's residual, making it two steps.
    expect(claimed(traversal(V(), hasLabel('T'), values('k'), limit(2)), g)).toBe(false);
    expect(toArray(traversal(V(), hasLabel('T'), values('k'), limit(2)), g)).toStrictEqual([1, 2]);

    expect(claimed(traversal(V(), hasLabel('T'), values('k'), count()), g)).toBe(false);
    expect(toArray(traversal(V(), hasLabel('T'), values('k'), count()), g)).toStrictEqual([3]);
  });

  test('a PATH-tracking plan declines — the walk emits bare values and builds no path', () => {
    expect(claimed(traversal(V(), hasLabel('T'), values('k'), path()), g)).toBe(false);
  });

  test('a LEADING hop answers correctly — and `drain` does NOT prove which rung did it', () => {
    /*
     * ⚠️⚠️ **MY FIRST VERSION OF THIS TEST ASSERTED `claimed(...) === false` AND FAILED, because the
     * PREMISE was wrong rather than the code.** `V().hasLabel(T).out(E).values(k)` is served by the
     * FUSED HOP WALK, which legitimately offers its own `drain` — so drain-presence discriminates
     * only where no other drain-offering rung applies. The gate's accept/decline behaviour is
     * asserted directly below instead, which is [[perf-gate-needs-its-own-test]]'s point: extract the
     * gate and unit-test it rather than inferring a route from a shared side effect.
     */
    expect(toArray(traversal(V(), hasLabel('T'), out('E'), values('k')), g)).toStrictEqual([2]);
  });

  test('the ITERATOR and `drain` agree, element for element and in order', () => {
    /*
     * ⚠️ TWO DERIVATIONS OF ONE WALK, which is item 169's lesson — and Gremlin results are compared
     * ORDERED by the differential fuzzer, so a divergence between them would be a cross-engine
     * failure rather than an unspecified-order liberty.
     */
    const lazy = [...run(traversal(V(), hasLabel('T'), values('k')), g)];
    const eager = (
      run(traversal(V(), hasLabel('T'), values('k')), g) as unknown as { drain: () => unknown[] }
    ).drain();

    expect(lazy).toStrictEqual([1, 2, 3]);
    expect(eager).toStrictEqual(lazy);
  });

  test('a label matching NOTHING answers empty, and still claims the route', () => {
    expect(toArray(traversal(V(), hasLabel('ZZZ'), values('k')), g)).toStrictEqual([]);
  });

  test('the OFF-LABEL vertex is never emitted, though it carries the key', () => {
    // `off` has `k: 99`. A fusion that ignored the label would emit it.
    expect(toArray(traversal(V(), hasLabel('T'), values('k')), g)).not.toContain(99);
    expect(toArray(traversal(V(), hasLabel('Q'), values('k')), g)).toStrictEqual([99]);
  });
});

describe('the gate itself, called directly (item 2037)', () => {
  const one = [{ value: { properties: { k: 7 } } }];
  const valuesStep = { kind: 'values', keys: ['k'] } as const;

  test('ACCEPTS exactly one `values` step with one key, and projects it', () => {
    const out = labelSeededValuesFusion(one, [valuesStep], false);

    expect(out).toBeDefined();
    expect([...(out as Iterable<unknown>)]).toStrictEqual([7]);
    expect((out as unknown as { drain: () => unknown[] }).drain()).toStrictEqual([7]);
  });

  test('DECLINES a path-tracking plan, a second step, no step, and a non-`values` step', () => {
    expect(labelSeededValuesFusion(one, [valuesStep], true)).toBeUndefined();
    expect(labelSeededValuesFusion(one, [valuesStep, valuesStep], false)).toBeUndefined();
    expect(labelSeededValuesFusion(one, [], false)).toBeUndefined();
    expect(labelSeededValuesFusion(one, [{ kind: 'count' }] as never, false)).toBeUndefined();
  });

  test('DECLINES zero keys and two keys', () => {
    expect(
      labelSeededValuesFusion(one, [{ kind: 'values', keys: [] } as const], false),
    ).toBeUndefined();
    expect(
      labelSeededValuesFusion(one, [{ kind: 'values', keys: ['k', 'j'] } as const], false),
    ).toBeUndefined();
  });

  test('a MISSING key is dropped by BOTH derivations, not emitted as `undefined`', () => {
    const mixed = [{ value: { properties: { k: 1 } } }, { value: { properties: {} } }];
    const lazy = labelSeededValuesFusion(mixed, [valuesStep], false);
    const eager = labelSeededValuesFusion(mixed, [valuesStep], false);

    expect([...(lazy as Iterable<unknown>)]).toStrictEqual([1]);
    expect((eager as unknown as { drain: () => unknown[] }).drain()).toStrictEqual([1]);
  });
});
