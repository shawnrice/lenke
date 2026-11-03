/**
 * Item 1349: `within` / `without` membership, after the per-element closure was removed.
 *
 * ⚠️ WHY THIS FILE EXISTS. The change replaced `pred.values.some((x) => valueEq(value, x))` with a
 * named function taking `value` as a PARAMETER, which is a 3.44-3.90x win and is supposed to be
 * SEMANTICALLY INERT. "Supposed to be" is the part that needs a test: the existing suite covers the
 * ordinary cases (22 tests fail if the helper throws), but the values where two notions of equality
 * part company were not pinned anywhere, and item 1348 declined to build this fold precisely
 * because it believed they diverged.
 *
 * THE BELIEF WAS WRONG, and this file records why in executable form. `valueEq` is `a === b` (with
 * a temporal total-order case), and BOTH `eq` and `within` call it — `Array.prototype.includes`
 * and its SameValueZero comparison, which is what item 1348 reasoned from, never appear. So:
 *
 *   - `NaN === NaN` is FALSE, so neither `eq(NaN)` nor `within(NaN)` matches a stored NaN.
 *   - `0 === -0` is TRUE, so both match across the two zeroes.
 *
 * Each case below asserts the `within` spelling and the bare-value spelling AGREE, which is the
 * property the optimization rests on, rather than asserting a particular verdict and leaving the
 * two free to drift apart together.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { count, has, hasLabel, toArray, traversal, V, within, without } from './index.js';

const g = new Graph();

g.addVertex({ id: 'plain', labels: ['T'], properties: { k: 5 } });
g.addVertex({ id: 'other', labels: ['T'], properties: { k: 9 } });
g.addVertex({ id: 'zero', labels: ['T'], properties: { k: 0 } });
g.addVertex({ id: 'negzero', labels: ['T'], properties: { k: -0 } });
g.addVertex({ id: 'nan', labels: ['T'], properties: { k: Number.NaN } });
g.addVertex({ id: 'str', labels: ['T'], properties: { k: '5' } });
g.addVertex({ id: 'nulled', labels: ['T'], properties: { k: null } });
g.addVertex({ id: 'absent', labels: ['T'], properties: {} });

const ids = (t: ReturnType<typeof traversal>): string[] =>
  (toArray(t, g) as { id: string }[]).map((v) => v.id).sort();

const nOf = (t: ReturnType<typeof traversal>): number => Number(toArray(t, g)[0]);

describe('a one-element `within` agrees with the bare value', () => {
  // The agreement IS the claim. Asserting a verdict instead would let both spellings drift
  // together and still pass.
  for (const v of [5, 9, 0, -0, Number.NaN, '5', 1234]) {
    test(`within(${String(v)}) selects what has(k, ${String(v)}) selects`, () => {
      expect(ids(traversal(V(), hasLabel('T'), has('k', within(v))))).toEqual(
        ids(traversal(V(), hasLabel('T'), has('k', v))),
      );
    });
  }
});

describe('the values where two notions of equality part company', () => {
  test('a stored NaN is matched by NEITHER spelling, because valueEq is `===`', () => {
    // If this ever flips, something switched to SameValueZero and `within` and `eq` will have
    // diverged — the exact divergence item 1348 feared and this records as absent.
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(Number.NaN))))).toEqual([]);
    expect(ids(traversal(V(), hasLabel('T'), has('k', Number.NaN)))).toEqual([]);
  });

  test('the two zeroes are interchangeable in BOTH spellings', () => {
    // `0 === -0`, so a query for either must find both vertices.
    const viaWithin = ids(traversal(V(), hasLabel('T'), has('k', within(0))));
    const viaBare = ids(traversal(V(), hasLabel('T'), has('k', 0)));

    expect(viaWithin).toEqual(viaBare);
    expect(viaWithin).toEqual(['negzero', 'zero']);
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(-0))))).toEqual(['negzero', 'zero']);
  });

  test('a number and its string spelling are DISTINCT, both ways', () => {
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(5))))).toEqual(['plain']);
    expect(ids(traversal(V(), hasLabel('T'), has('k', within('5'))))).toEqual(['str']);
  });

  test('a STORED null is a value both spellings match', () => {
    // Presence here means "the key is in the bag", so a stored null is PRESENT and matchable —
    // the distinction the Rust engine's `has_value_at`/`present_at` pair exists to keep apart
    // (item 1136), and `has('k')` below confirms `nulled` is among the carriers.
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(null))))).toEqual(['nulled']);
    expect(ids(traversal(V(), hasLabel('T'), has('k', null)))).toEqual(['nulled']);
    expect(ids(traversal(V(), hasLabel('T'), has('k')))).toContain('nulled');
  });
});

describe('the list itself', () => {
  test('a match at the FIRST and at the LAST position are both found', () => {
    // The helper short-circuits, so a value only reachable at the end is the case a broken
    // loop bound would drop.
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(5, 100, 200))))).toEqual(['plain']);
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(100, 200, 5))))).toEqual(['plain']);
  });

  test('order does not change the result', () => {
    expect(ids(traversal(V(), hasLabel('T'), has('k', within(5, 9))))).toEqual(
      ids(traversal(V(), hasLabel('T'), has('k', within(9, 5)))),
    );
  });

  test('a repeated value is not counted twice', () => {
    expect(nOf(traversal(V(), hasLabel('T'), has('k', within(5, 5, 5)), count()))).toBe(1);
  });

  test('an EMPTY within matches nothing and an empty without matches everything', () => {
    // The vacuous cases, which are where an inverted loop result shows up most plainly.
    expect(nOf(traversal(V(), hasLabel('T'), has('k', within()), count()))).toBe(0);
    expect(nOf(traversal(V(), hasLabel('T'), has('k', without()), count()))).toBe(
      nOf(traversal(V(), hasLabel('T'), count())),
    );
  });
});

describe('`without` is the complement of `within` on every vertex', () => {
  // `without` shares the helper, so it needs its own assertion: the shared code is negated at the
  // call site, and a helper returning the wrong polarity would break both in the same direction.
  for (const vals of [[5], [5, 9], [0], [Number.NaN], [], [1234]]) {
    test(`without(${vals.map(String).join(',')}) is everything within(...) is not`, () => {
      const inSet = new Set(ids(traversal(V(), hasLabel('T'), has('k', within(...vals)))));
      const outSet = ids(traversal(V(), hasLabel('T'), has('k', without(...vals))));

      // ⚠️ THE COMPLEMENT IS OVER EVERY VERTEX, INCLUDING THE ONE WITH NO `k` AT ALL — measured,
      // after this assertion first took it over the carriers and failed. An absent key reads
      // `undefined`, so `within(..)` finds nothing to match and `without(..)` is vacuously TRUE:
      // `without(5)` selects 7 of the 8 vertices, `absent` among them, while `has('k')` reports
      // only 7 carriers. So `within` and `without` are NOT symmetric about presence.
      //
      // That asymmetry is PRE-EXISTING and untouched by item 1349 — both spellings reach the same
      // `matches` in both arms — and whether it should hold is a Gremlin CONFORMANCE question
      // (TinkerPop's `has(k, P)` is documented as requiring the key), recorded for its own item
      // rather than changed under a performance one.
      const all = ids(traversal(V(), hasLabel('T')));

      expect(outSet).toEqual(all.filter((id) => !inSet.has(id)));
    });
  }
});
