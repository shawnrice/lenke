/**
 * `values(k).is(p).count()` folds to `has(k, p).count()` (item 1314).
 *
 * ⚠️ THE TWO SPELLINGS RETURN DIFFERENT THINGS — `values(k).is(p)` emits VALUES and `has(k, p)`
 * emits ELEMENTS — so they agree on HOW MANY and on nothing else. That is why the tail must be
 * exactly `count`, and why the decline cases below assert NUMBERS that differ rather than merely
 * asserting the plan was left alone: each one is a real non-equivalence, measured before the
 * rewrite was written.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { gte } from '../predicates.js';
import { V, count, dedupe, has, is, order, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { effectivePlan, fuseValuesIsCount, toArray } from './index.js';

/**
 * Built for the cases that decide single-valuedness: a plain value, an ARRAY value, a NULL value,
 * and an element with the key ABSENT. `values('k')` emits `[5, [1,2,3], null]` over these — one row
 * per element that HAS the key, an array counting as one value.
 */
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 5, j: 9 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: [1, 2, 3], j: 7 } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { j: 1 } });
  g.addVertex({ id: 'd', labels: ['P'], properties: { k: null, j: 3 } });

  return g;
};

const kinds = (steps: readonly { kind: string }[]): string[] => steps.map((s) => s.kind);
const n = (g: Graph, plan: ReturnType<typeof traversal>): number => Number(toArray(plan, g)[0]);

describe('the fold fires for values(k).is(p).count()', () => {
  test('the two steps become one has', () => {
    const flat = fuseValuesIsCount(traversal(V(), values('k'), is(gte(2)), count()));

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
    expect((flat.steps[1] as unknown as { key: string }).key).toBe('k');
  });

  test('it is WIRED into effectivePlan', () => {
    const flat = effectivePlan(traversal(V(), values('k'), is(gte(2)), count()), build(), false);

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
  });

  test('a plan with no such run is returned UNCHANGED, by identity', () => {
    const plan = traversal(V(), has('k', gte(2)), count());

    expect(fuseValuesIsCount(plan)).toBe(plan);
  });

  test('the count agrees across the value kinds', () => {
    const g = build();

    // Only `a` (5) passes: the array and the null do not, and `c` has no `k`.
    expect(n(g, traversal(V(), values('k'), is(gte(2)), count()))).toBe(1);
    expect(n(g, traversal(V(), has('k', gte(2)), count()))).toBe(1);
  });

  test('single-valuedness, which the whole fold rests on', () => {
    const g = build();

    // One row per element that HAS the key — 3 of 4 — and an ARRAY is one value, not three.
    expect(toArray(traversal(V(), values('k')), g)).toEqual([5, [1, 2, 3], null]);
    expect(n(g, traversal(V(), values('k'), count()))).toBe(3);
    expect(n(g, traversal(V(), has('k'), count()))).toBe(3);
  });
});

describe('item 1585: the `is` is OPTIONAL, so values(k).count() folds too', () => {
  // The gate required an `is`, so the PLAIN spelling kept materialising one value per element —
  // 1.89x against its `has` twin at 50,000 vertices, same answer. The equivalence argument in this
  // file's header never needed a predicate: with single-valued properties `values(k)` emits one
  // value per element that HAS `k`, which is what the presence filter selects.
  //
  // ⚠️ WITHOUT A PREDICATE THE STEP IS `hasKey`, NOT `has`. `has` carries a required `pred`, and
  // `G.has('k')` parses to `{ kind: 'hasKey', keys: ['k'] }` — checked against what the builder
  // actually produces, because emitting a `has` with no `pred` does not even typecheck.
  test('the two steps become one hasKey', () => {
    const flat = fuseValuesIsCount(traversal(V(), values('k'), count()));

    expect(kinds(flat.steps)).toEqual(['V', 'hasKey', 'count']);
    expect((flat.steps[1] as unknown as { keys: readonly string[] }).keys).toEqual(['k']);
  });

  test('it is WIRED into effectivePlan', () => {
    const flat = effectivePlan(traversal(V(), values('k'), count()), build(), false);

    expect(kinds(flat.steps)).toEqual(['V', 'hasKey', 'count']);
  });

  test('the count agrees, including the NULL value and the absent key', () => {
    const g = build();

    // Three elements HAVE `k` — one holding an array, one holding null — and `c` does not.
    expect(n(g, traversal(V(), values('k'), count()))).toBe(3);
    expect(n(g, traversal(V(), has('k'), count()))).toBe(3);
  });

  test('the predicate form still folds to `has`, not `hasKey`', () => {
    // The control that says the change widened the gate without moving the existing arm.
    const flat = fuseValuesIsCount(traversal(V(), values('k'), is(gte(2)), count()));

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
  });

  test('MULTI-KEY still declines without a predicate, and the numbers differ', () => {
    const g = build();
    const plan = traversal(V(), values('k', 'j'), count());

    expect(kinds(fuseValuesIsCount(plan).steps)).toEqual(['V', 'values', 'count']);
    // 3 values of `k` plus 4 of `j`; the presence filter on `k` alone would say 3.
    expect(n(g, plan)).toBe(7);
    expect(n(g, traversal(V(), has('k'), count()))).toBe(3);
  });

  test('a DEDUPE tail still declines without a predicate', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1 } });

    const plan = traversal(V(), values('k'), dedupe(), count());

    expect(kinds(fuseValuesIsCount(plan).steps)).toEqual(['V', 'values', 'dedupe', 'count']);
    // Distinct VALUES is 1 where distinct ELEMENTS is 2 — the non-equivalence the tail guard is for.
    expect(n(g, plan)).toBe(1);
    expect(n(g, traversal(V(), has('k'), dedupe(), count()))).toBe(2);
  });

  test('a count that is NOT last declines', () => {
    const plan = traversal(V(), values('k'), count(), order());

    expect(kinds(fuseValuesIsCount(plan).steps)).toEqual(['V', 'values', 'count', 'order']);
  });

  test('a plan with values but no count tail is returned UNCHANGED, by identity', () => {
    const plan = traversal(V(), values('k'), order());

    expect(fuseValuesIsCount(plan)).toBe(plan);
  });
});

describe('the declines, each asserted by the NUMBER that differs', () => {
  test('MULTI-KEY values emits one row per key, so the counts differ', () => {
    const g = build();
    const plan = traversal(V(), values('k', 'j'), is(gte(2)), count());

    expect(kinds(fuseValuesIsCount(plan).steps)).toEqual(['V', 'values', 'is', 'count']);
    // 5, 9, 7, 3 pass across the two keys; `has('k', …)` would say 1.
    expect(n(g, plan)).toBe(4);
    expect(n(g, traversal(V(), has('k', gte(2)), count()))).toBe(1);
  });

  test('a DEDUPE tail is observable: distinct VALUES is not distinct ELEMENTS', () => {
    const g = new Graph();

    // Two elements SHARING a value is what separates the two readings.
    g.addVertex({ id: 'x', labels: ['P'], properties: { k: 5 } });
    g.addVertex({ id: 'y', labels: ['P'], properties: { k: 5 } });

    const plan = traversal(V(), values('k'), is(gte(2)), dedupe(), count());

    expect(kinds(fuseValuesIsCount(plan).steps)).toEqual(['V', 'values', 'is', 'dedupe', 'count']);
    expect(n(g, plan)).toBe(1);
    expect(n(g, traversal(V(), has('k', gte(2)), dedupe(), count()))).toBe(2);
    // ⚠️ THE CONTRAST WITH ITEM 1311, where a `dedupe, count` tail IS admitted: there both
    // spellings emit the same ELEMENTS, so a coarser view stays equal. Here the rewrite changes
    // what flows, so dedupe sees it.
  });

  const NO_FOLD: ReadonlyArray<readonly [string, ReturnType<typeof traversal>]> = [
    ['count that is not LAST', traversal(V(), values('k'), is(gte(2)), count(), is(gte(0)))],
    ['no count at all', traversal(V(), values('k'), is(gte(2)))],
    ['an order between is and count', traversal(V(), values('k'), is(gte(2)), order(), count())],
    // ⚠️ `['values with no is', traversal(V(), values('k'), count())]` WAS IN THIS LIST and item
    // 1585 REMOVED IT, deliberately: that spelling now folds to `hasKey`, and the entry was
    // pinning the gate's narrowness as if it were a semantic. It is not — the header's
    // equivalence argument never needed the predicate, and the plain spelling cost 1.89x for it.
    // Its replacement is the positive assertion in the item-1585 describe above.
    ['is with no preceding values', traversal(V(), has('k'), is(gte(2)), count())],
  ];

  for (const [name, plan] of NO_FOLD) {
    test(`${name} does not fold`, () => {
      expect(kinds(fuseValuesIsCount(plan).steps)).toEqual(kinds(plan.steps));
    });
  }
});
