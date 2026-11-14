import { describe, expect, test } from 'bun:test';

/**
 * `V()[.hasLabel(L)].values(k).dedupe()` — the fused scan projection with its dedupe folded in,
 * item 1869.
 *
 * `nodeValuesShortcut` requires NOTHING after `values`, so a trailing `dedupe` fell to the traverser
 * pipeline — which builds a traverser per value to keep 997 of 200,000. Priced at item 1868:
 * **11.96 ms against a 5.81 ms fused floor that emits 200x more rows than the deduped shape keeps.**
 *
 * ⚠️ **THE GAP WAS DIAGNOSED IN THE ENGINE'S OWN SOURCE BEFORE IT WAS MEASURED.** `dedupe`'s note
 * records `values(k).dedup()` at 3.4-3.6x the GQL `RETURN DISTINCT` spelling for num and str columns
 * and says the residual "is the TRAVERSAL STREAM'S own cost and not a keying defect". That sentence
 * is the nomination; this removes the stream and leaves the keying alone.
 *
 * ⚠️⚠️ **ORDER IS THE LOAD-BEARING ASSERTION, not the set.** Gremlin results are compared ORDERED by
 * the differential fuzzer, and `dedupe()` keeps FIRST-OCCURRENCE order — so every test below
 * compares SEQUENCES. A fused walk that collected a `Set` and emitted its contents would pass a
 * set-equality test and be insertion-ordered only by accident of the implementation; this one
 * filters in place while scanning, which is why the order holds by construction rather than by luck.
 *
 * ⚠️ **AND THE DEDUP CLASSES ARE THE ENGINE'S OWN.** `valueDedupeFilter` was EXTRACTED from
 * `dispatch.ts` at item 1869, not copied, so the five key spaces — plain `Set`, composite string key
 * with a `WeakSet` short-circuit, `LocalDate` on `days`, the other temporal kinds, and
 * `NO_VALUE` — are shared by construction. The cases below still exercise each space through this
 * rung, because "shared by construction" is a claim about an import and the rung could still fail
 * to reach the predicate at all.
 */
import { Graph, LocalDate } from '@lenke/core';

import { V, dedupe, hasLabel, run, toArray, traversal, values } from '../index.js';

/**
 * ⚠️ DUPLICATES ARE INTERLEAVED, NOT ADJACENT, so first-occurrence order is observable: a walk that
 * emitted the LAST occurrence of each value, or sorted them, would differ here and agree on a
 * fixture where each value's copies were consecutive.
 */
const build = (vals: readonly unknown[], labels: readonly string[][] = []): Graph => {
  const g = new Graph();

  for (const [i, v] of vals.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: labels[i] ?? ['T'],
      properties: v === undefined ? {} : { k: v },
    });
  }

  return g;
};

/**
 * The same query down the route that CANNOT take the rung, so the two cannot share a mistake.
 *
 * ⚠️⚠️ THE FIRST ORACLE HERE WAS WRONG, AND RUNNING IT IS WHAT SAID SO. It used
 * `values(k).dedupe().by(k)` on the reasoning that a `by` modulator is refused by the rung and
 * dedupes on the same value anyway. It does not: by that point the stream holds VALUES, not
 * vertices, so `by('k')` reads property `k` OF A NUMBER, yields `NO_VALUE`, and `dedupe` FILTERS
 * those — the oracle answered `[5]` where the right answer is
 * `[LocalDate(5), 5, LocalDate(6)]`. The rung was correct and my check was not, which is the same
 * failure item 1857 recorded twice in one item.
 *
 * ⚠️ THE REPLACEMENT IS A SEEDED SOURCE, which `matchShape` refuses outright (item 1858's device).
 * Naming every id IN ORDER keeps the question identical rather than merely similar: the pipeline
 * then visits the same vertices in the same sequence and runs the same `dedupe` step.
 */
const viaPipeline = (g: Graph, n: number, key = 'k'): unknown[] =>
  toArray(traversal(V(...Array.from({ length: n }, (_, i) => `v${i}`)), values(key), dedupe()), g);

describe('the fused scan dedupe', () => {
  test('emits first-occurrence order, with duplicates interleaved', () => {
    const g = build([3, 1, 3, 2, 1, 3, 4]);

    expect(toArray(traversal(V(), values('k'), dedupe()), g)).toEqual([3, 1, 2, 4]);
  });

  test('a hasLabel filter narrows the scan', () => {
    const g = build([3, 1, 3, 2, 1], [['T'], ['U'], ['T'], ['U'], ['T', 'U']]);

    expect(toArray(traversal(V(), hasLabel('T'), values('k'), dedupe()), g)).toEqual([3, 1]);
    expect(toArray(traversal(V(), hasLabel('U'), values('k'), dedupe()), g)).toEqual([1, 2]);
    // ANY of the named labels, not all — `hasLabel`'s own rule.
    expect(toArray(traversal(V(), hasLabel('T', 'U'), values('k'), dedupe()), g)).toEqual([
      3, 1, 2,
    ]);
  });

  /**
   * ⚠️ A STORED `null` IS A VALUE AND AN ABSENT KEY IS NOT. `values(k)` emits nothing for a vertex
   * lacking `k`, and `null` is a value that dedupes with other nulls — a walk conflating them would
   * pass any fixture where every vertex carries the key.
   */
  test('a stored null dedupes; an absent key is never emitted', () => {
    const g = build([1, null, undefined, null, 1, undefined, 2]);

    expect(toArray(traversal(V(), values('k'), dedupe()), g)).toEqual([1, null, 2]);
  });

  /** `0`, `-0`, `''` and `false` are distinct values that a truthiness test would collapse. */
  test('falsy values are kept apart', () => {
    const g = build([0, '', false, 0, '', false, -0]);
    const got = toArray(traversal(V(), values('k'), dedupe()), g);

    // SameValueZero: `-0` and `0` are the SAME key, which is what a plain `Set` does and what the
    // pipeline does — so three values, not four.
    expect(got).toEqual([0, '', false]);
  });

  /**
   * ⚠️ THE TEMPORAL KEY SPACE, reached through this rung. `LocalDate` keys on `days` in its own
   * container (item 857), and a raw `5` must NOT collide with `LocalDate(5)` — item 850's reason
   * for a separate container, asserted here rather than assumed from the shared import.
   */
  test('dates key by value, and do not collide with a raw number', () => {
    const g = build([new LocalDate(5), new LocalDate(5), 5, new LocalDate(6), 5, new LocalDate(6)]);
    const got = toArray(traversal(V(), values('k'), dedupe()), g);

    expect(got).toHaveLength(3);
    expect(got[0]).toBeInstanceOf(LocalDate);
    expect((got[0] as LocalDate).days).toBe(5);
    expect(got[1]).toBe(5);
    expect((got[2] as LocalDate).days).toBe(6);
  });

  /** The COMPOSITE key space: structurally equal arrays dedupe although they are distinct refs. */
  test('structurally equal lists dedupe', () => {
    const g = build([
      [1, 2],
      [1, 2],
      [1, 3],
      [1, 2],
    ]);
    const got = toArray(traversal(V(), values('k'), dedupe()), g);

    expect(JSON.stringify(got)).toBe(
      JSON.stringify([
        [1, 2],
        [1, 3],
      ]),
    );
  });

  /**
   * ⚠️ AGAINST THE PIPELINE, which is what says the rung did not invent its own classes. Every
   * fixture above goes down `dedupe().by(k)` too — refused by the rung, same question — and the
   * SEQUENCES must match.
   */
  test('agrees with the route that cannot take it, on every fixture', () => {
    for (const vals of [
      [3, 1, 3, 2, 1, 3, 4],
      [1, null, null, 1, 2],
      [0, '', false, 0, '', false],
      ['a', 'b', 'a', 'c', 'b'],
      [new LocalDate(5), new LocalDate(5), 5, new LocalDate(6)],
      [1],
      // ⚠️ NOT `[]`: with zero ids `V(...[])` is `V()`, which TAKES the rung — so an empty fixture
      // would compare the rung against itself. A one-element fixture gives `V('v0')`, genuinely
      // seeded and genuinely refused.
    ]) {
      const g = build(vals);

      expect(JSON.stringify(toArray(traversal(V(), values('k'), dedupe()), g))).toBe(
        JSON.stringify(viaPipeline(g, vals.length)),
      );
    }
  });

  /**
   * `drain` and the iterator are two consumers of ONE loop body and must not drift.
   *
   * ⚠️ THE LAZY SIDE MUST COME FROM `run`, NOT `toArray` — item 1858's test made exactly that
   * mistake and compared `drain` against itself, because `toArray` takes the `drain` path when a
   * shortcut offers one.
   */
  test('drain agrees with lazy iteration', () => {
    const g = build([3, 1, 3, 2, 1]);
    const plan = traversal(V(), values('k'), dedupe());
    const drained = toArray(plan, g);
    const iterated: unknown[] = [];

    for (const v of run(plan, g)) {
      iterated.push(v);
    }

    expect(JSON.stringify(drained)).toBe(JSON.stringify(iterated));
    expect(iterated).toHaveLength(3);
  });
});

describe('the fused scan dedupe refuses what it must', () => {
  /**
   * ⚠️ A LABELLED dedupe keys on TAGGED values, and this asserts the exact answer because
   * `length > 0` let a mutant admitting the shape SURVIVE. No step here sets a tag, so every
   * traverser's `tags.get('a')` is `undefined` — ONE key, ONE row. A rung that ignored the labels
   * would answer three.
   */
  test('a labelled dedupe is refused, and keys on the (absent) tag', () => {
    const g = build([3, 1, 3, 2]);

    expect(toArray(traversal(V(), values('k'), dedupe('a')), g)).toHaveLength(1);
  });

  /**
   * ⚠️ A `by` MODULATOR DEDUPES ON SOMETHING ELSE, and the fixture has to make that observable —
   * on a plain numeric column `by('k')` happens to yield the value itself, so the answers coincide
   * and a mutant admitting the shape SURVIVED. Over temporals it does not: `by('k')` on a
   * `LocalDate` yields NO_VALUE, which `dedupe` FILTERS, so the pipeline keeps only the raw number.
   */
  test('a by-modulated dedupe is refused, and the by is applied', () => {
    const numeric = build([3, 1, 3, 2]);

    expect(toArray(traversal(V(), values('k'), dedupe().by('k')), numeric)).toEqual([3, 1, 2]);

    const mixed = build([new LocalDate(5), new LocalDate(5), 5, new LocalDate(6)]);

    // The three dates are dropped by the `by`; only the raw 5 survives. A rung that ignored the
    // modulator would answer all three distinct values.
    expect(toArray(traversal(V(), values('k'), dedupe().by('k')), mixed)).toEqual([5]);
  });

  /**
   * ⚠️ `NO_VALUE` MUST FILTER, which is TinkerPop's rule for a dedup-by that yields nothing — and
   * a mutant flipping it to `return true` SURVIVED until this case existed. It reaches the
   * EXTRACTED predicate through the PIPELINE (the `by` is refused by the rung), so it is what
   * covers that branch of the code item 1869 moved out of `dispatch.ts`.
   */
  test('a dedupe-by on an absent key filters every traverser', () => {
    const g = build([3, 1, 3, 2]);

    /**
     * ⚠️ THE STREAM MUST HOLD ELEMENTS, NOT VALUES, and getting that wrong is how this case first
     * asserted `[]` and read `[3, 1, 2]`. `evalBy` on a PRIMITIVE yields the primitive itself
     * whatever key is named, so `values(k).dedupe().by('nope')` never produces `NO_VALUE` at all.
     * Over VERTICES an absent property does produce it, and `dedupe` then filters every traverser.
     */
    expect(toArray(traversal(V(), dedupe().by('nope')), g)).toEqual([]);
    // The control: a key the vertices DO carry dedupes normally rather than filtering.
    expect(toArray(traversal(V(), dedupe().by('k'), values('k')), g)).toEqual([3, 1, 2]);
  });

  /** Two keys is a different question (`values` fans out per key), so the shape declines. */
  test('a multi-key values is refused, and still answers', () => {
    const g = new Graph();

    g.addVertex({ id: 'v0', labels: ['T'], properties: { k: 1, j: 2 } });
    g.addVertex({ id: 'v1', labels: ['T'], properties: { k: 1, j: 3 } });

    const got = toArray(traversal(V(), values('k', 'j'), dedupe()), g);

    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain(3);
  });

  /** A SEEDED source enumerates a given set, which this rung's whole-graph scan does not. */
  test('a seeded V(id) source is refused, and still answers', () => {
    const g = build([3, 1, 3, 2]);

    expect(toArray(traversal(V('v2', 'v0'), values('k'), dedupe()), g)).toEqual([3]);
  });
});
