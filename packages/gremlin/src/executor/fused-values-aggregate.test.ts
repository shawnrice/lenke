/**
 * `values(k)` fused with its terminal aggregate (item 1586) — **1.88-1.91x**, measured as an
 * asserted A/B at 40 reps over 50,000 vertices:
 *
 * ```text
 *   max   2.100 -> 1.118 ms   1.88x
 *   sum   2.042 -> 1.071      1.91x
 *   fold  2.165 -> 2.140      the CONTROL: not fused, flat
 * ```
 *
 * ⚠️ TWO KINDS OF TEST ARE NEEDED HERE, and only one of them is about answers.
 *
 * The fused generator REPLACES a pair whose semantics are spread across `projectValues`,
 * `aggregateComparable` and `aggregateNumber`, so each of those behaviours has to be re-asserted
 * against the unfused spelling — a missing key, a null value, an empty stream, the total order over
 * strings, NaN, and `sum`'s refusal to coerce. A mutant in the generator changes an ANSWER, so
 * these tests have teeth on their own.
 *
 * The GATE is different: declining is answer-equivalent, so a mutant that stops the fusion firing
 * is invisible to every answer test. That is why `fusableValuesAggregate` is a pure exported
 * function tested directly — `perf-gate-needs-its-own-test`, and items 1582/1583 are what happens
 * without it.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { gte } from '../predicates.js';
import { V, count, fold, has, max, mean, min, order, sum, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { fusableValuesAggregate } from './aggregation.js';
import { toArray } from './index.js';

const graphOf = (ks: readonly unknown[]): Graph => {
  const g = new Graph();

  for (const [i, k] of ks.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: k === undefined ? { other: i } : { k, other: i },
    });
  }

  return g;
};

const one = (g: Graph, plan: ReturnType<typeof traversal>): unknown => toArray(plan, g)[0];

describe('the fused aggregate agrees with the unfused spelling', () => {
  // Each fixture is run through all four kinds, and each kind is compared against the same
  // computation reached a DIFFERENT way — `fold()` then a plain JS reduce — so the oracle is not
  // the code under test.
  const FIXTURES: Array<readonly [string, readonly unknown[]]> = [
    ['plain numbers', [3, 1, 4, 1, 5]],
    ['one element', [7]],
    ['negatives and zero', [-2, 0, 5, -9]],
    ['a null among numbers', [3, null, 1, null, 4]],
    ['a MISSING key among numbers', [3, undefined, 1, undefined, 4]],
    ['all nulls', [null, null]],
    ['all keys missing', [undefined, undefined]],
    ['no vertices at all', []],
  ];

  for (const [name, ks] of FIXTURES) {
    test(`${name}: max and min match a fold-and-reduce oracle`, () => {
      const g = graphOf(ks);
      const vals = (toArray(traversal(V(), values('k'), fold()), g)[0] as unknown[]) ?? [];
      const nums = vals.filter((v) => v !== null) as number[];

      expect(one(g, traversal(V(), values('k'), max()))).toEqual(
        nums.length === 0 ? null : Math.max(...nums),
      );
      expect(one(g, traversal(V(), values('k'), min()))).toEqual(
        nums.length === 0 ? null : Math.min(...nums),
      );
    });

    test(`${name}: sum and mean match a fold-and-reduce oracle`, () => {
      const g = graphOf(ks);
      const vals = (toArray(traversal(V(), values('k'), fold()), g)[0] as unknown[]) ?? [];
      const nums = vals.filter((v) => v !== null) as number[];
      const total = nums.reduce((a, b) => a + b, 0);

      expect(one(g, traversal(V(), values('k'), sum()))).toEqual(nums.length === 0 ? null : total);
      expect(one(g, traversal(V(), values('k'), mean()))).toEqual(
        nums.length === 0 ? null : total / nums.length,
      );
    });
  }

  test('an EMPTY result is one null row, not zero rows', () => {
    // `aggregateComparable` and `aggregateNumber` both yield a single null traverser when nothing
    // non-null arrived, and the fused form has to do the same or a caller reading `[0]` gets
    // `undefined` instead of `null`.
    const g = graphOf([null, undefined]);

    for (const plan of [
      traversal(V(), values('k'), max()),
      traversal(V(), values('k'), min()),
      traversal(V(), values('k'), sum()),
      traversal(V(), values('k'), mean()),
    ]) {
      expect(toArray(plan, g)).toEqual([null]);
    }
  });
});

describe('the ORDER is the engine total order, not a numeric compare', () => {
  test('strings compare lexicographically', () => {
    const g = graphOf(['pear', 'apple', 'fig']);

    expect(one(g, traversal(V(), values('k'), min()))).toBe('apple');
    expect(one(g, traversal(V(), values('k'), max()))).toBe('pear');
  });

  test('booleans compare', () => {
    const g = graphOf([true, false, true]);

    expect(one(g, traversal(V(), values('k'), min()))).toBe(false);
    expect(one(g, traversal(V(), values('k'), max()))).toBe(true);
  });

  test('NaN is GREATEST, so max keeps it and min never picks it', () => {
    // The rule `compareTotal` documents and the Rust `gcmp_total` mirrors. A fused form that
    // compared with `<`/`>` directly would get BOTH of these wrong, since every NaN comparison is
    // false — which is exactly why the fast path idea was rejected rather than bolted on.
    const g = graphOf([3, Number.NaN, 1]);

    expect(one(g, traversal(V(), values('k'), max()))).toBeNaN();
    expect(one(g, traversal(V(), values('k'), min()))).toBe(1);
  });

  test('sum and mean THROW on a non-number rather than coercing', () => {
    // TinkerPop raises; `asNumber` is what the unfused path used and the fused one calls the same
    // helper, so this pins that the fusion did not quietly start coercing.
    const g = graphOf([1, 'two', 3]);

    expect(() => toArray(traversal(V(), values('k'), sum()), g)).toThrow();
    expect(() => toArray(traversal(V(), values('k'), mean()), g)).toThrow();
    // …while max/min handle the mixed stream through the total order.
    expect(() => toArray(traversal(V(), values('k'), max()), g)).not.toThrow();
  });
});

describe('the GATE — which is answer-equivalent, so it needs its own test', () => {
  const vals1 = { kind: 'values', keys: ['k'] } as const;

  test('it fires for each global terminal aggregate', () => {
    for (const kind of ['min', 'max', 'sum', 'mean'] as const) {
      expect(fusableValuesAggregate(vals1, { kind })).toEqual({ key: 'k', kind });
    }
  });

  test('it declines a MULTI-KEY values — one row PER KEY is a real non-equivalence', () => {
    expect(
      fusableValuesAggregate({ kind: 'values', keys: ['k', 'j'] }, { kind: 'max' }),
    ).toBeUndefined();
  });

  test('it declines a terminal it does not implement', () => {
    for (const kind of ['count', 'fold', 'order', 'dedupe'] as const) {
      expect(fusableValuesAggregate(vals1, { kind })).toBeUndefined();
    }
  });

  test('it declines when there is NO next step', () => {
    expect(fusableValuesAggregate(vals1, undefined)).toBeUndefined();
  });

  test('it declines a non-values first step', () => {
    expect(
      fusableValuesAggregate({ kind: 'hasKey', keys: ['k'] }, { kind: 'max' }),
    ).toBeUndefined();
  });

  test('it declines a non-GLOBAL scope', () => {
    // `local` aggregation is per-traverser and has its own helpers; a single accumulator would be
    // the wrong computation entirely.
    expect(fusableValuesAggregate(vals1, { kind: 'max', scope: 'local' } as never)).toBeUndefined();
    // …and an explicit `global` is accepted, so the guard is not just rejecting any scope field.
    expect(fusableValuesAggregate(vals1, { kind: 'max', scope: 'global' } as never)).toEqual({
      key: 'k',
      kind: 'max',
    });
  });
});

describe('the shapes around the fusion still answer correctly', () => {
  test('a filter before the values still applies', () => {
    const g = graphOf([3, 1, 4, 1, 5]);

    // `other` is the index, so `other >= 3` keeps the last two vertices: k = 1 and 5.
    expect(one(g, traversal(V(), has('other', gte(3)), values('k'), max()))).toBe(5);
    expect(one(g, traversal(V(), has('other', gte(3)), values('k'), min()))).toBe(1);
  });

  test('a terminal that is NOT fused is unaffected', () => {
    const g = graphOf([3, 1, 4]);

    expect(one(g, traversal(V(), values('k'), count()))).toBe(3);
    expect(toArray(traversal(V(), values('k'), fold()), g)[0]).toEqual([3, 1, 4]);
  });

  test('a step AFTER the aggregate still runs', () => {
    const g = graphOf([3, 1, 4]);

    // The fusion consumes the pair and leaves the rest of the loop to handle what follows.
    expect(toArray(traversal(V(), values('k'), max(), order()), g)).toEqual([4]);
  });
});
