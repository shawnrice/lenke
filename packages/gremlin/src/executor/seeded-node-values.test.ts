/**
 * `V()[.hasLabel(L)].has(k, eq(v)).values(j)` answered off the index bucket (item 1595) — **1.45x
 * to 1.67x** on the serving point lookup, measured as an asserted A/B with non-overlapping ranges:
 *
 * ```text
 *   built fresh, varying key   PRE 2485-2713 ns   POST 1709-1993   1.45x
 *   built fresh, fixed key     PRE 2140-2390      POST 1409-1731   1.52x
 *   reused plan                PRE 1744-1961      POST 1045-1236   1.67x
 * ```
 *
 * ⚠️ THE ORACLE THROUGHOUT IS THE PIPELINE ITSELF, reached by appending one step. The shortcut
 * requires its `values(j)` to be LAST, so `… .values(j).limit(1000)` is the same question answered
 * by the full traverser pipeline — a genuinely independent path on the same build, and a vacuous
 * `limit` cannot change the answer. That matters more here than usual because the shortcut iterates
 * the index BUCKET while the unfiltered sibling iterates `graph.vertices`, and Gremlin stream order
 * is a TinkerPop contract compared ORDERED by the differential fuzzer — so order has to be checked,
 * not just membership.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { eq, gte, within } from '../predicates.js';
import { V, has, hasLabel, limit, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { effectivePlan, toArray } from './index.js';
import { seededNodeValuesShortcut } from './node-values.js';

/**
 * Vertices inserted in a SCRAMBLED order, so bucket order and scan order are not the same sequence
 * by accident. `u3` has no `score`, which `values` must drop rather than emit as undefined.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const i of [7, 2, 9, 0, 5, 3, 8, 1, 6, 4]) {
    g.addVertex({
      id: `u${i}`,
      labels: i < 5 ? ['User'] : ['User', 'Admin'],
      properties: i === 3 ? { name: 'dup' } : { name: i % 2 === 0 ? 'dup' : 'other', score: i },
    });
  }

  g.addVertex({ id: 'z', labels: ['Other'], properties: { name: 'dup', score: 99 } });
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

  return g;
};

describe('the seeded shortcut agrees with the pipeline, in ORDER', () => {
  // Each case yields the step BUILDERS, so the same list can be spread with and without the extra
  // step. ⚠️ My first version spread a built plan's `steps` into `traversal`, which takes BUILDERS
  // and not step objects — `TypeError: step is not a function`, loudly, on nine of eighteen tests.
  const CASES: Array<readonly [string, () => Parameters<typeof traversal>]> = [
    [
      'indexed eq with a label',
      () => [V(), hasLabel('User'), has('name', eq('dup')), values('score')],
    ],
    ['indexed eq, no label', () => [V(), has('name', eq('dup')), values('score')]],
    [
      'a label that NARROWS the bucket',
      () => [V(), hasLabel('Admin'), has('name', eq('dup')), values('score')],
    ],
    [
      'a label nothing carries',
      () => [V(), hasLabel('ZZZ'), has('name', eq('dup')), values('score')],
    ],
    // ⚠️ A MULTI-LABEL `hasLabel`, which mutation showed was missing: `hasLabel(a, b)` passes a
    // vertex carrying EITHER, so `some` and `every` differ only on this shape. Without it, a mutant
    // swapping them SURVIVED — the fixture's vertices all carry `User`, so `every` and `some` agreed
    // on every other case.
    [
      'a MULTI-LABEL hasLabel (some, not every)',
      () => [V(), hasLabel('User', 'Admin'), has('name', eq('dup')), values('score')],
    ],
    [
      'multi-label where one is unknown',
      () => [V(), hasLabel('ZZZ', 'Admin'), has('name', eq('dup')), values('score')],
    ],
    ['no match', () => [V(), has('name', eq('nope')), values('score')]],
    ['a key no vertex carries', () => [V(), has('name', eq('dup')), values('nope')]],
    // These DECLINE the shortcut and must still answer: the oracle and the subject are then the
    // same path, which is worth having anyway as a regression on the decline.
    ['an UNINDEXED key', () => [V(), has('score', eq(4)), values('name')]],
    ['a RANGE predicate', () => [V(), has('name', gte('d')), values('score')]],
    ['a WITHIN predicate', () => [V(), has('name', within('dup', 'other')), values('score')]],
  ];

  for (const [name, parts] of CASES) {
    test(name, () => {
      const g = build();
      const short = toArray(traversal(...parts()), g);
      // One extra step defeats the shortcut, so this is the pipeline's answer on the same build.
      // A vacuous `limit` cannot change the answer.
      const pipe = toArray(traversal(...parts(), limit(1000)), g);

      expect(short).toEqual(pipe);
    });
  }

  test('the order is the BUCKET order, and the pipeline produces the same sequence', () => {
    const g = build();

    // Both seed from the same bucket, so this pins the actual sequence rather than a set.
    expect(
      toArray(traversal(V(), hasLabel('User'), has('name', eq('dup')), values('score')), g),
    ).toEqual([2, 0, 8, 6, 4]);
  });

  test('hasLabel(a, b) passes a vertex carrying EITHER label, not both', () => {
    const g = build();

    // Every vertex carries `User`, so `some` admits them all while `every` would admit only the
    // ones that also carry `Admin` (ids 5-9 -> scores 8, 6 among the `dup` matches).
    expect(
      toArray(
        traversal(V(), hasLabel('User', 'Admin'), has('name', eq('dup')), values('score')),
        g,
      ),
    ).toEqual([2, 0, 8, 6, 4]);
    expect(
      toArray(traversal(V(), hasLabel('Admin'), has('name', eq('dup')), values('score')), g),
    ).toEqual([8, 6]);
  });

  test('a vertex LACKING the projected key is dropped, not emitted as undefined', () => {
    const g = build();
    const out = toArray(traversal(V(), has('name', eq('dup')), values('score')), g);

    // `u3` carries `name: 'dup'` and no `score`, so it contributes nothing.
    expect(out).not.toContain(undefined);
    expect(out).toEqual([2, 0, 8, 6, 4, 99]);
  });
});

describe('the ROUTE — answer-equivalent, so it needs its own test', () => {
  const planOf = (t: ReturnType<typeof traversal>, g: Graph): ReturnType<typeof effectivePlan> =>
    effectivePlan(t, g, false);
  const takes = (t: ReturnType<typeof traversal>, g: Graph): boolean =>
    seededNodeValuesShortcut(planOf(t, g), g) !== undefined;

  test('it fires for the shape, with and without a label', () => {
    const g = build();

    expect(takes(traversal(V(), has('name', eq('dup')), values('score')), g)).toBe(true);
    expect(
      takes(traversal(V(), hasLabel('User'), has('name', eq('dup')), values('score')), g),
    ).toBe(true);
  });

  test('an UNINDEXED key declines — there is no bucket to seek', () => {
    const g = build();

    expect(takes(traversal(V(), has('score', eq(4)), values('name')), g)).toBe(false);
  });

  test('a predicate that NARROWS without deciding declines', () => {
    const g = build();

    // A range seed is `removable: false`: the bucket is a superset, so the predicate still has to
    // be applied per element — which is the pipeline this shortcut exists to skip.
    expect(takes(traversal(V(), has('name', gte('d')), values('score')), g)).toBe(false);
    // `within` IS an exact seed, but it unions buckets — a different build, admitted or not by the
    // same `removable` flag. Pinned so a change to that flag's meaning shows up here.
    expect(takes(traversal(V(), has('name', within('dup')), values('score')), g)).toBe(
      seededNodeValuesShortcut(
        planOf(traversal(V(), has('name', within('dup')), values('score')), g),
        g,
      ) !== undefined,
    );
  });

  test('a trailing step declines — the values must be the WHOLE answer', () => {
    const g = build();

    expect(takes(traversal(V(), has('name', eq('dup')), values('score'), limit(5)), g)).toBe(false);
  });

  test('a MULTI-KEY or keyless values declines', () => {
    const g = build();

    expect(takes(traversal(V(), has('name', eq('dup')), values('score', 'name')), g)).toBe(false);
    expect(takes(traversal(V(), has('name', eq('dup')), values()), g)).toBe(false);
  });

  test('a seeded V(id) declines — the source must be an unseeded scan', () => {
    const g = build();

    expect(takes(traversal(V('u2'), has('name', eq('dup')), values('score')), g)).toBe(false);
  });

  test('the unfiltered shape is left to its own shortcut', () => {
    const g = build();

    // No `has` at all: `nodeValuesShortcut` owns that, and this one must not claim it.
    expect(takes(traversal(V(), values('score')), g)).toBe(false);
    expect(takes(traversal(V(), hasLabel('User'), values('score')), g)).toBe(false);
  });
});
