/**
 * `or(has(k, a), has(k, b), …)` folds to `has(k, within(a, b, …))` (item 1312).
 *
 * This is one of the FOUR canonical index-seeding bugs CLAUDE.md names by example — "`k = $a OR
 * k = $b` vs `k IN [$a, $b]`" — and ISO-GQL has folded it since item 1269 while the Gremlin
 * surface never did. The value cases below are chosen for the things that usually break a value
 * list rather than for coverage: `null`, `NaN`, `0` against `false`, and a mixed string/number
 * list.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { eq, gt, within } from '../predicates.js';
import { V, and, count, has, hasLabel, or } from '../steps.js';
import { traversal } from '../traversal.js';
import { effectivePlan, flattenFilterWrappers, toArray } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const vals: readonly unknown[] = [1, 2, 3, 'x', 'y', null, 0, true, Number.NaN];

  vals.forEach((v, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: v } });
  });
  // An element with NO `k` at all, which neither spelling may keep.
  g.addVertex({ id: 'vmissing', labels: ['P'], properties: {} });

  return g;
};

const kinds = (steps: readonly { kind: string }[]): string[] => steps.map((s) => s.kind);
const ids = (rows: readonly unknown[]): unknown[] =>
  rows.map((r) => (typeof r === 'object' && r !== null ? (r as { id: unknown }).id : r));

describe('the or-chain folds to a membership', () => {
  test('two equalities on one key become one has(within)', () => {
    const flat = flattenFilterWrappers(traversal(V(), or(has('k', 1), has('k', 2)), count()));

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
    expect((flat.steps[1] as unknown as { pred: { op: string; values: unknown[] } }).pred).toEqual({
      op: 'within',
      values: [1, 2],
    });
  });

  test('three branches fold, preserving the written order of the values', () => {
    const flat = flattenFilterWrappers(
      traversal(V(), or(has('k', 3), has('k', 1), has('k', 2)), count()),
    );

    expect((flat.steps[1] as unknown as { pred: { values: unknown[] } }).pred.values).toEqual([
      3, 1, 2,
    ]);
  });

  test('an explicit eq() folds the same way as a bare value', () => {
    const flat = flattenFilterWrappers(
      traversal(V(), or(has('k', eq(1)), has('k', eq(2))), count()),
    );

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
  });

  test('an or nested inside an and folds, then splices', () => {
    // The `and` arm splices its branches, and a folded membership is a plain `has` by then — which
    // is why this lives in the same pass rather than its own.
    const flat = flattenFilterWrappers(
      traversal(V(), and(or(has('k', 1), has('k', 2)), hasLabel('P')), count()),
    );

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'hasLabel', 'count']);
  });

  test('it is WIRED into effectivePlan', () => {
    const flat = effectivePlan(
      traversal(V(), or(has('k', 1), has('k', 2)), count()),
      build(),
      false,
    );

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
  });
});

describe('the declines, each a real non-equivalence', () => {
  const NO_FOLD: ReadonlyArray<readonly [string, ReturnType<typeof traversal>]> = [
    ['different keys', traversal(V(), or(has('k', 1), has('other', 2)), count())],
    ['a non-eq predicate', traversal(V(), or(has('k', 1), has('k', gt(2))), count())],
    ['an existing within', traversal(V(), or(has('k', 1), has('k', within(2, 3))), count())],
    ['a presence branch', traversal(V(), or(has('k', 1), has('k')), count())],
    ['a label branch', traversal(V(), or(has('k', 1), hasLabel('P')), count())],
    [
      'a two-step branch',
      traversal(V(), or(traversal(has('k', 1), hasLabel('P')), has('k', 2)), count()),
    ],
    ['a single branch', traversal(V(), or(has('k', 1)), count())],
  ];

  for (const [name, plan] of NO_FOLD) {
    test(`${name} does not fold`, () => {
      expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(kinds(plan.steps));
    });
  }
});

describe('the two spellings answer identically', () => {
  const PAIRS: ReadonlyArray<readonly [string, readonly unknown[]]> = [
    ['numbers', [1, 2]],
    ['strings', ['x', 'y']],
    ['mixed string and number', [1, 'x']],
    ['including null', [null, 1]],
    // `0` against `true` is the pair that catches a fold doing loose comparison.
    ['0 and true', [0, true]],
    ['including NaN', [Number.NaN, 1]],
    ['a value nothing carries', [999, 1]],
  ];

  for (const [name, vals] of PAIRS) {
    test(`${name} agrees`, () => {
      const g = build();
      const chain = vals.map((v) => has('k', v));
      const folded = traversal(V(), or(...chain));
      const explicit = traversal(V(), has('k', within(...vals)));

      expect(ids(toArray(folded, g))).toEqual(ids(toArray(explicit, g)));
    });
  }

  test('an element with NO value for the key is kept by neither', () => {
    const g = build();

    expect(ids(toArray(traversal(V(), or(has('k', 1), has('k', 2))), g))).not.toContain('vmissing');
    expect(ids(toArray(traversal(V(), has('k', within(1, 2))), g))).not.toContain('vmissing');
  });
});
