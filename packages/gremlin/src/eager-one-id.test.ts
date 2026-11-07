/**
 * THE ONE-ID EAGER ROUTE in `idSeededValuesShortcut` (item 1660), and the three properties that
 * decide whether it is allowed to exist.
 *
 * ⚠️ WHY A SECOND FILE BESIDE `id-seeded-values.test.ts`. That file pins the rung's ANSWERS and its
 * laziness contract, and it kept passing when this route was added — because **every one of its
 * contract cases is written on a MULTI-id plan** (`V('a', 'b')` for one-shot, `V('a', 5)` for the
 * lazy fault). The one-id shape, which is the point lookup and the commonest serving query there is,
 * was the one shape with no contract coverage at all. A green suite said nothing about it, which is
 * exactly the condition `testing-discipline` warns about.
 *
 * THE THREE PROPERTIES:
 *
 * 1. **The answers are unchanged** — checked against the engine's own general path, because a route
 *    choice is answer-equivalent by definition and a hand-written list would only pin my reading of
 *    it (`.identity()` lands in the residual, which the rung refuses).
 * 2. **The fault is still LAZY.** `typeof ids[0] === 'string'` is a laziness guard, not a type
 *    narrowing: a non-string id must fall through to the generator so `asStringId` raises on first
 *    `next()` rather than at `run()` time.
 * 3. **The result is RE-ITERABLE, deliberately**, and the multi-id walk is still one-shot. Item 1651
 *    made this rung one-shot on purpose; item 1660 reverses that for one id only, having measured
 *    that the shipped engine is already re-iterable on three of its five routes. This file is where
 *    that decision is written down, so the next reader finds the choice rather than inferring it.
 *
 * ⚠️ AND A FOURTH, which is the reason the route is sound at all: it is BOUNDED. One id and one key
 * is 0 or 1 values, so there is no walk made eager and no early exit destroyed. The large-result
 * shapes must stay lazy, and `the large shapes are untouched` below is what keeps a later widening
 * of this branch from silently becoming the memory regression it would otherwise be.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run, toArray } from './executor.js';
import { idSeededValuesShortcut } from './executor/node-values.js';
import { V, hasLabel, identity, limit, traversal, values } from './index.js';

const g = new Graph();

g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
g.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { k: 2 } });
// A stored PRESENT null, which `values(k)` must emit — `k in props` is the test, not truthiness.
g.addVertex({ id: 'c', labels: ['Q'], properties: { k: null } });
// `d` lacks `k` entirely, so it must yield nothing rather than `undefined`.
g.addVertex({ id: 'd', labels: ['P'], properties: { j: 9 } });
// ⚠️ A STORED `undefined`, which this engine DOES keep: `addVertex` leaves the key present, so
// `'k' in props` is true and the value is `undefined`. The general path's test is `key in props`, so
// it EMITS here — and a rung testing `props[key] !== undefined` instead would silently drop the row.
// A mutation pass caught exactly that (M3), and only after this vertex existed.
g.addVertex({ id: 'e', labels: ['P'], properties: { k: undefined } });

/**
 * ⚠️ `expect([undefined]).toEqual([])` PASSES in bun, so `toEqual` alone cannot tell an INVENTED
 * `undefined` row from no row at all — a mutant emitting `[props[key]]` unconditionally SURVIVED the
 * first version of this file for that reason. Every comparison here goes through a fingerprint that
 * carries the arity and each value's type, so `[]`, `[undefined]` and `[null]` are three distinct
 * strings.
 */
const fingerprint = (rows: readonly unknown[]): string =>
  `${rows.length}|${rows.map((r) => `${typeof r}:${String(r)}`).join(',')}`;

describe('⚠️ 1. the one-id route agrees with the general path', () => {
  for (const [label, rung, pipeline] of [
    ['a present key', traversal(V('a'), values('k')), traversal(V('a'), values('k'), identity())],
    ['a stored null', traversal(V('c'), values('k')), traversal(V('c'), values('k'), identity())],
    [
      'a stored UNDEFINED, which is present and must be emitted',
      traversal(V('e'), values('k')),
      traversal(V('e'), values('k'), identity()),
    ],
    [
      'a vertex LACKING the key',
      traversal(V('d'), values('k')),
      traversal(V('d'), values('k'), identity()),
    ],
    ['a missing id', traversal(V('zz'), values('k')), traversal(V('zz'), values('k'), identity())],
    [
      'a MATCHING label',
      traversal(V('b'), hasLabel('Q'), values('k')),
      traversal(V('b'), hasLabel('Q'), values('k'), identity()),
    ],
    [
      'a NON-matching label',
      traversal(V('a'), hasLabel('Q'), values('k')),
      traversal(V('a'), hasLabel('Q'), values('k'), identity()),
    ],
    [
      'a label on a vertex that lacks the key',
      traversal(V('d'), hasLabel('P'), values('k')),
      traversal(V('d'), hasLabel('P'), values('k'), identity()),
    ],
  ] as const) {
    test(`${label}: the rung and the pipeline agree`, () => {
      // The fingerprint is the real assertion; `toEqual` is kept for a readable diff on failure.
      expect(fingerprint(toArray(rung, g)), 'fingerprints agree').toBe(
        fingerprint(toArray(pipeline, g)),
      );
      expect(toArray(rung, g)).toEqual(toArray(pipeline, g));
    });
  }

  test('⚠️ and the route is BOUNDED: one id and one key is at most one row', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'zz']) {
      expect(toArray(traversal(V(id), values('k')), g).length, id).toBeLessThanOrEqual(1);
    }
  });

  /**
   * ⚠️ THE ARITY IS PINNED SEPARATELY from the value comparison, because that is the property
   * `toEqual` cannot see: a row invented out of a missing key, or a row dropped for a present one.
   */
  test('⚠️ exact arity per id, which toEqual cannot police', () => {
    const arity = (id: string): number => toArray(traversal(V(id), values('k')), g).length;

    expect(arity('a'), 'a has k').toBe(1);
    expect(arity('c'), 'c has a stored null').toBe(1);
    expect(arity('e'), 'e has a stored undefined, still PRESENT').toBe(1);
    expect(arity('d'), 'd LACKS k entirely').toBe(0);
    expect(arity('zz'), 'zz does not exist').toBe(0);
  });
});

describe('⚠️ 2. the fault is still LAZY, which the typeof guard is what preserves', () => {
  /**
   * A non-string id must take the GENERATOR, so the throw lands on the first `next()` exactly as the
   * general path's does. Were the eager branch to accept it, `run` itself would throw — invisible to
   * `toArray`, which drains, and a behaviour change for any caller that holds the iterable.
   */
  test('a single NON-STRING id does not throw from run(), only from the walk', () => {
    const it = run(traversal(V(5), values('k')), g);
    const iter = it[Symbol.iterator]();

    expect(() => iter.next(), 'the fault arrives on the first pull').toThrow();
  });

  test('and draining it still throws, on both routes', () => {
    expect(() => toArray(traversal(V(5), values('k')), g)).toThrow();
    expect(() => toArray(traversal(V(5), values('k'), identity()), g)).toThrow();
  });

  test('a non-string id is NOT answered by the eager branch', () => {
    const short = idSeededValuesShortcut(traversal(V(5), values('k')), g);

    expect(short, 'the rung still claims the plan').toBeDefined();
    // An array would mean the eager branch took a non-string id and resolved it up front.
    expect(Array.isArray(short), 'but NOT as an eager array').toBe(false);
  });
});

describe('⚠️ 3. re-iterability: one id is re-iterable, more than one is not', () => {
  test('ONE id yields the same values on a second pass', () => {
    const it = run(traversal(V('a'), values('k')), g);

    expect([...it], 'first pass').toEqual([1]);
    expect([...it], 'second pass — DELIBERATELY the same (item 1660)').toEqual([1]);
  });

  test('TWO ids remain ONE-SHOT, as item 1651 made them', () => {
    const it = run(traversal(V('a', 'b'), values('k')), g);

    expect([...it], 'first pass').toEqual([1, 2]);
    expect([...it], 'second pass — exhausted').toEqual([]);
  });

  test('and the general path remains one-shot for one id too', () => {
    const it = run(traversal(V('a'), values('k'), identity()), g);

    expect([...it], 'first pass').toEqual([1]);
    expect([...it], 'second pass — exhausted').toEqual([]);
  });
});

describe('⚠️ 4. the large shapes are UNTOUCHED, which is what bounds the licence', () => {
  /**
   * The rung fires only when it answers the WHOLE plan, so a trailing step lands in the residual and
   * the plan never reaches an eager route. This is the structural reason a 200,000-row scan cannot be
   * made eager by this change — and the test that will fail if the branch is ever widened past a
   * bounded result.
   */
  test('a trailing step declines the rung outright', () => {
    expect(idSeededValuesShortcut(traversal(V('a'), values('k'), limit(1)), g)).toBeUndefined();
    expect(idSeededValuesShortcut(traversal(V('a'), values('k'), identity()), g)).toBeUndefined();
  });

  test('an UNSEEDED scan is not this rung, and is not an array', () => {
    expect(idSeededValuesShortcut(traversal(V(), values('k')), g)).toBeUndefined();
    expect(Array.isArray(run(traversal(V(), values('k')), g)), 'still lazy').toBe(false);
  });

  test('a MULTI-id walk is not an array either', () => {
    expect(Array.isArray(run(traversal(V('a', 'b'), values('k')), g)), 'still lazy').toBe(false);
  });

  test('TWO keys decline the rung, so the fan-out is never made eager', () => {
    expect(idSeededValuesShortcut(traversal(V('a'), values('k', 'j')), g)).toBeUndefined();
  });
});
