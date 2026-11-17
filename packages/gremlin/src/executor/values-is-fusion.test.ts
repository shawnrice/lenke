/*
 * Item 2081 — `V().values(k).is(pred)`, a value filter on the fused scan.
 *
 * ⚠️⚠️ **THE ORDER OF THE TWO TESTS IS THE CONTRACT.** `values(k)` drops a vertex lacking the key
 * BEFORE `is` sees anything — `dispatch.ts`'s `case 'is'` is `matches(step.pred, t.value)` over the
 * already-projected stream — so a walk that offered the predicate an ABSENT value would differ from
 * the generic path on exactly those vertices. `key in props` comes first here for that reason, and
 * the fixture carries such a vertex so the difference is observable.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  dedupe,
  gt,
  is,
  neq,
  order,
  regex,
  toArray,
  traversal,
  V,
  values,
  without,
} from '../index.js';
import { valuesIsShortcut } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 10, s: 'xa' } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { n: 20, s: 'zb' } });
  g.addVertex({ id: 'c', labels: ['T'], properties: { n: 5, s: 'xc' } });
  // ⚠️ NO `n`: `values('n')` drops it, so the predicate must never be offered its absent value.
  g.addVertex({ id: 'd', labels: ['T'], properties: { s: 'xd' } });

  return g;
};

describe('fused values + is (item 2081)', () => {
  const g = build();

  test('THE ROUTE: the rung claims the three-step shape', () => {
    expect(valuesIsShortcut(traversal(V(), values('n'), is(gt(9))), g)).toBeDefined();
  });

  test('the row SEQUENCE matches the predicate, in walk order', () => {
    expect(toArray(traversal(V(), values('n'), is(gt(9))), g)).toStrictEqual([10, 20]);
  });

  test('⚠️⚠️ a vertex with NO key is dropped by the projection, not tested by the predicate', () => {
    /*
     * 🔑 `d` HAS NO `n`. A predicate that keeps EVERYTHING still must not emit a row for it — so the
     * answer is three rows, not four.
     *
     * ⚠️⚠️ **`gt(-1)` CANNOT SEE THIS AND THIS TEST FIRST USED IT.** Two mutants deleting `key in
     * props` from the two walks BOTH SURVIVED: `matches(gt(-1), undefined)` is false, so an absent
     * value is dropped by the PREDICATE instead of by the projection and the answer is identical. The
     * comment here named that hazard and then picked the predicate that coincidentally agrees.
     *
     * 🔑 `neq(999)` IS THE ORACLE, because `undefined !== 999` is TRUE — so without the drop the walk
     * emits a FOURTH row holding `undefined`. ⚠️ And that row is LAST, which is exactly the case
     * [[toequal-blind-to-trailing-undefined]] records: `toEqual` passes `[10, 20, 5, undefined]`
     * against `[10, 20, 5]`. `toStrictEqual` is load-bearing on this line.
     */
    expect(toArray(traversal(V(), values('n'), is(neq(999))), g)).toStrictEqual([10, 20, 5]);
    expect(toArray(traversal(V(), values('n'), is(gt(-1))), g)).toStrictEqual([10, 20, 5]);
  });

  test('⚠️⚠️ the GENERAL walk has the same hole, and `regex` CANNOT see it', () => {
    /*
     * ⚠️⚠️ **TWO PREDICATES WERE WRONG BEFORE THIS TEST HAD TEETH.** The hole is the same `key in
     * props` drop, but the oracle has to satisfy BOTH conditions at once, and I measured each:
     *
     *     matches(p, undefined)      specializePredicate(p)
     *     gt(-1)       false         specialized   -> cannot see it, wrong walk
     *     regex('^.')  false         DECLINED      -> right walk, cannot see it
     *     neq(999)     TRUE          specialized   -> sees it, but on the FAST walk
     *     without(…)   TRUE          DECLINED      -> 🔑 the only one that does both
     *
     * So `without` is the general walk's oracle: it is declined, so the `matches` closure runs, and it
     * answers TRUE for an absent value, so without the drop a FOURTH row holding `undefined` appears.
     */
    expect(toArray(traversal(V(), values('n'), is(without(999, 998))), g)).toStrictEqual([
      10, 20, 5,
    ]);
    // ⚠️ `regex` still belongs here — it proves the general walk is REACHED, just not that it drops.
    expect(toArray(traversal(V(), values('s'), is(regex('^x'))), g)).toStrictEqual([
      'xa',
      'xc',
      'xd',
    ]);
  });

  test('the ITERATOR and `drain` agree exactly', () => {
    const claimed = valuesIsShortcut(traversal(V(), values('n'), is(gt(9))), g);

    expect(claimed).toBeDefined();
    expect([...claimed!]).toStrictEqual(claimed!.drain!());
  });

  test('a predicate `specializePredicate` DECLINES still routes here and answers correctly', () => {
    /*
     * ⚠️ THE GENERAL WALK IS NOT DEAD CODE. `specializePredicate` returns `undefined` for anything but
     * a number/string operand, so a `regex` lands on the `matches` walk — a separate closure, so a
     * mutant can target one without the other.
     */
    const plan = traversal(V(), values('s'), is(regex('^x')));

    expect(valuesIsShortcut(plan, g)).toBeDefined();
    expect(toArray(plan, g)).toStrictEqual(['xa', 'xc', 'xd']);
  });

  test('a TRAILING step declines — the rung serves only the bare three-step shape', () => {
    expect(valuesIsShortcut(traversal(V(), values('n'), is(gt(9)), order()), g)).toBeUndefined();
    expect(toArray(traversal(V(), values('n'), is(gt(9)), order()), g)).toStrictEqual([10, 20]);
  });

  test('a trailing `dedupe` declines here and is answered elsewhere', () => {
    expect(valuesIsShortcut(traversal(V(), values('n'), is(gt(-1)), dedupe()), g)).toBeUndefined();
    expect(toArray(traversal(V(), values('n'), is(gt(-1)), dedupe()), g)).toStrictEqual([
      10, 20, 5,
    ]);
  });

  test('a MULTI-KEY projection declines — values(a, b) fans out per key', () => {
    expect(valuesIsShortcut(traversal(V(), values('n', 's'), is(gt(9))), g)).toBeUndefined();
  });

  test('V(ids) declines — a given set is not the whole graph', () => {
    expect(valuesIsShortcut(traversal(V('a', 'b'), values('n'), is(gt(9))), g)).toBeUndefined();
    expect(toArray(traversal(V('a', 'b'), values('n'), is(gt(9))), g)).toStrictEqual([10, 20]);
  });

  test('a non-`is` third step declines', () => {
    expect(valuesIsShortcut(traversal(V(), values('n'), dedupe()), g)).toBeUndefined();
  });
});
