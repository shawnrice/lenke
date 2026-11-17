/*
 * Item 2089 — `V().hasLabel(L).id()` and `.label()` on the seeded stream.
 *
 * ⚠️⚠️ **THESE TESTS MUST RUN WITH A NON-VACUOUS LABEL OR THEY TEST NOTHING.** `dropVacuousLabels`
 * deletes a `hasLabel` that every vertex carries, leaving the two-step `V().id()` that item 2056
 * already fused — so a fixture whose every vertex shares the label routes around this arm entirely and
 * passes whatever it does. Item 2087 lost a mutant to exactly this, and every fixture below carries an
 * off-label vertex for that reason.
 *
 * 🔑 THE CONTRACT THAT SEPARATES THE ARMS: `values(k)` DROPS an element lacking the key, while `id()`
 * and `label()` emit a row for EVERY element — `label()` yielding `null` where there is no label. A
 * walk that shared one loop would have to drop or emit for all three.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { hasLabel, id, label, order, toArray, traversal, V, values } from '../index.js';
import { labelSeededValuesFusion } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 1 } });
  // ⚠️ MULTI-LABEL: `label()` must yield its FIRST label in insertion order, and `hasLabel('T')`
  // must still match it.
  g.addVertex({ id: 'b', labels: ['T', 'U'], properties: { n: 2 } });
  // ⚠️ NO `n`: it must still produce an id and a label row, while `values('n')` drops it.
  g.addVertex({ id: 'c', labels: ['T'], properties: { other: 9 } });
  // ⚠️ OFF-LABEL, and load-bearing twice: it makes `T` non-vacuous (so the `hasLabel` survives and
  // this arm is reached at all) AND it must be excluded from every answer below.
  g.addVertex({ id: 'off', labels: ['Q'], properties: { n: 99 } });

  return g;
};

describe('seeded id/label accessor fusion (item 2089)', () => {
  const g = build();

  test('⚠️ `hasLabel(T).id()` yields every labelled id and EXCLUDES the off-label vertex', () => {
    expect(toArray(traversal(V(), hasLabel('T'), id()), g)).toStrictEqual(['a', 'b', 'c']);
  });

  test('⚠️⚠️ `hasLabel(T).label()` yields the FIRST label, and a multi-label vertex keeps order', () => {
    // `b` was created as `['T', 'U']`, so its label is `T` — insertion order, not sorted.
    expect(toArray(traversal(V(), hasLabel('T'), label()), g)).toStrictEqual(['T', 'T', 'T']);
  });

  test('⚠️⚠️ AN UNLABELLED VERTEX YIELDS `null` AND STILL YIELDS A ROW', () => {
    /*
     * 🔑 THE ONE ASYMMETRY BETWEEN THE ARMS. `label()` on an element with no labels is `null` per
     * `dispatch.ts`'s `?? null`, and the row is NOT dropped — unlike `values(k)` on a missing key. A
     * fused walk reusing the `values` arm's `value !== undefined` guard would swallow it.
     *
     * ⚠️ `hasLabel` cannot select an unlabelled vertex, so this is asked WITHOUT the label step —
     * which is item 2080's bare-scan arm, asserted here because the two arms must agree.
     */
    const bare = new Graph();

    bare.addVertex({ id: 'x', labels: [], properties: {} });
    bare.addVertex({ id: 'y', labels: ['T'], properties: {} });

    expect(toArray(traversal(V(), label()), bare)).toStrictEqual([null, 'T']);
  });

  test('⚠️ `values(n)` still DROPS the keyless element — the arm this one had to split from', () => {
    // `c` has no `n`, so three labelled vertices give TWO value rows where `id()` gave three.
    expect(toArray(traversal(V(), hasLabel('T'), values('n')), g)).toStrictEqual([1, 2]);
  });

  test('the ITERATOR and `drain` agree for both accessors', () => {
    /*
     * ⚠️ TWO DERIVATIONS, ONE ANSWER — and the fusion is called DIRECTLY, because a `Plan` is not
     * iterable: `[...plan]` threw, so going through the public surface could only ever exercise
     * `toArray`'s `drain` preference and never the generator. Gremlin results are compared ORDERED by
     * the differential fuzzer, so a divergence between the two derivations would be a cross-engine
     * failure rather than an unspecified-order liberty.
     */
    const elements = [...g.vertices].filter((v) => v.labels.has('T'));
    const streamOf = (): { value: unknown }[] => elements.map((v) => ({ value: v }));

    for (const step of [{ kind: 'id' }, { kind: 'label' }] as never[]) {
      const fused = labelSeededValuesFusion(streamOf(), [step], false);

      expect(fused).toBeDefined();
      expect([...fused!.values]).toStrictEqual(fused!.values.drain!());
      expect(fused!.rest).toStrictEqual([]);
    }
  });

  test('⚠️ a TRAILING terminal still rides the walk — `order` after the accessor', () => {
    /*
     * 🔑 `rest` is handed to `fusedProjectedResidual`, which item 2041 established for the `values`
     * arm: a terminal this walk does not project still gets the walk. Asserted for the accessors too,
     * since they return the same `{ values, rest }` shape.
     */
    expect(toArray(traversal(V(), hasLabel('T'), id(), order()), g)).toStrictEqual(['a', 'b', 'c']);
  });

  test('⚠️ a DIFFERENT label selects a different set, so the seed is really applied', () => {
    expect(toArray(traversal(V(), hasLabel('Q'), id()), g)).toStrictEqual(['off']);
    expect(toArray(traversal(V(), hasLabel('U'), id()), g)).toStrictEqual(['b']);
  });

  test('a label NOTHING carries yields no rows', () => {
    expect(toArray(traversal(V(), hasLabel('NOBODY'), id()), g)).toStrictEqual([]);
  });

  test('⚠️ it agrees with the GENERIC path, which a vacuous label forces', () => {
    /*
     * ⚠️ THE ORACLE. With every vertex carrying `T`, `dropVacuousLabels` removes the `hasLabel` and the
     * plan takes item 2056/2080's BARE-scan arm instead — a second route to the same rows.
     */
    const allT = new Graph();

    for (const vid of ['p', 'q', 'r']) {
      allT.addVertex({ id: vid, labels: ['T'], properties: {} });
    }

    expect(toArray(traversal(V(), hasLabel('T'), id()), allT)).toStrictEqual(['p', 'q', 'r']);
    expect(toArray(traversal(V(), hasLabel('T'), label()), allT)).toStrictEqual(['T', 'T', 'T']);
  });
});
