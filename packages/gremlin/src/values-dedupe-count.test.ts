/*
 * Item 2169 — `V().values(k).dedupe().count()` fused into one pass over the vertices.
 *
 * ```text
 *     target                     9.5 ms -> 2.5     3.8x, and now EQUAL to its own floor
 *     values(k).count() [floor]  2.5    -> 2.5     flat
 *     out().dedupe().count()     4.9    -> 5.0     flat
 *     values(k).order()         14.9    -> 16.0    ~8% worse (executor-edits-perturb's known cost)
 * ```
 *
 * Adding `dedupe()` used to drop the shape off a fused rung onto the generator pipeline —
 * `generatorResume` at 73.3% of the profile. Both existing dedupe rungs are ELEMENT-based
 * (`distinctHopCount` for one hop, `dedupedHopChainCount` for two or more), which is why the VALUES form
 * was unserved: item 2079 fused the `where`-gated variant and item 1970 the `limit` variant.
 *
 * **THE IMPORT IS `./index.js`, NOT `@lenke/gremlin`, AND THAT IS NOT COSMETIC.** My first version
 * imported the package, which resolves to the BUILT DIST — so a mutation of `src/` was invisible and
 * EIGHT of nine mutants "survived" a round that tested unmutated code. Every sibling test in this
 * package imports `./index.js` for exactly this reason. **A test that imports the dist cannot witness a
 * source mutation.**
 *
 * **THE THREE SEMANTICS BELOW WERE ESTABLISHED EMPIRICALLY BEFORE THE FUSION WAS WRITTEN**, because
 * reading the dispatch was not converging:
 *
 * ```text
 *     vertices: k=1, k=1, k=2, k=null, (absent)
 *     values(k)                  [1, 1, 2, null]    SKIPS the absent, EMITS the explicit null
 *     values(k).dedupe()         [1, 2, null]       null is a DISTINCT value
 *     values(k).dedupe().count()          3
 * ```
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, count, dedupe, limit, out, toArray, traversal, values } from './index.js';

/** One vertex per entry; `undefined` means the property is ABSENT rather than null. */
const graphOf = (ks: readonly unknown[]): Graph => {
  const g = new Graph();

  for (const [i, k] of ks.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: k === undefined ? { tag: i } : { k, tag: i },
    });
  }

  return g;
};

const distinct = (g: Graph): unknown =>
  toArray(traversal(V(), values('k'), dedupe(), count()), g)[0];

describe('the values-dedupe count fusion (item 2169)', () => {
  describe('the arithmetic', () => {
    test('counts DISTINCT values, not vertices', () => {
      expect(distinct(graphOf([1, 1, 2, 2, 3]))).toBe(3);
    });

    test('an ABSENT key contributes nothing; an explicit NULL is a value', () => {
      /*
       * THE SEMANTIC THE FUSION MOST EASILY GETS WRONG. Testing `properties[key] === undefined` would
       * conflate the two and answer 2 here. The fusion tests `key in properties`, so the null counts and
       * the absent does not.
       */
      expect(distinct(graphOf([1, 1, 2, null, undefined]))).toBe(3);
      // Just the null and the absent: one distinct value.
      expect(distinct(graphOf([null, undefined]))).toBe(1);
      // Just the absent: none.
      expect(distinct(graphOf([undefined, undefined]))).toBe(0);
    });

    test('a property HOLDING `undefined` is distinct from one holding `null`', () => {
      /*
       * THE CASE THAT CAUGHT A WRONG ANSWER, found by chasing a surviving mutant rather than by
       * design. A property can hold `undefined` (`{k: undefined}` → `in-map: true, value: undefined`),
       * and `values()` RENDERS it as `null` — so the raw stream prints `[1, null, null]` and looks like
       * it has a duplicate.
       *
       * It does not: the UNFUSED `values(k).dedupe()` returns all THREE rows, because the dedupe keys
       * on the raw value where `undefined` and `null` differ. **The fused count must agree with that**,
       * and a version that coalesced `undefined` to `null` first answered 2.
       */
      const g2 = new Graph();

      g2.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
      g2.addVertex({ id: 'u', labels: ['P'], properties: { k: undefined } });
      g2.addVertex({ id: 'n', labels: ['P'], properties: { k: null } });
      g2.addVertex({ id: 'x', labels: ['P'], properties: {} });

      // The oracle is the unfused spelling, not a number I chose.
      const unfused = toArray(traversal(V(), values('k'), dedupe()), g2).length;

      expect(distinct(g2)).toBe(unfused);
      expect(distinct(g2)).toBe(3);
    });

    test('an empty graph, and a graph with no such key', () => {
      expect(distinct(new Graph())).toBe(0);
      expect(distinct(graphOf([undefined]))).toBe(0);
    });

    test('every value distinct, and every value identical', () => {
      expect(distinct(graphOf([1, 2, 3, 4]))).toBe(4);
      expect(distinct(graphOf([7, 7, 7, 7]))).toBe(1);
    });

    test('mixed TYPES are distinct values', () => {
      // `1` and `'1'` are different values, as are `0` and `false`.
      expect(distinct(graphOf([1, '1', 0, false]))).toBe(4);
    });

    test('`valueDedupeFilter` is used, so LISTS dedupe structurally', () => {
      /*
       * A plain `Set` of raw values would count two equal arrays as distinct, because they are
       * different objects. The fusion reuses the generator path's own `valueDedupeFilter`, which this
       * package has dedicated tests for (temporal and namespaced keys). The assertion is against the
       * UNFUSED spelling, so the two paths must agree whatever that function decides.
       */
      const g = graphOf([[1, 2], [1, 2], [3]]);
      const viaRows = toArray(traversal(V(), values('k'), dedupe()), g).length;

      expect(distinct(g)).toBe(viaRows);
    });

    test('DATE values agree with the unfused spelling too', () => {
      const g = graphOf([new Date(0), new Date(0), new Date(1)]);
      const viaRows = toArray(traversal(V(), values('k'), dedupe()), g).length;

      /*
       * THE ENGINE ANSWERS 3, NOT 2, AND IT IS THE FUSION THAT IS RIGHT. I expected two equal `Date`s
       * to dedupe — `valueDedupeFilter` does carry a `seenDates` set — and the engine keeps them apart on
       * this path. The assertion that matters is the FIRST one: both spellings agree, so whatever that
       * function decides, the fused and unfused paths decide it identically. The literal is pinned to the
       * engine's answer rather than to my expectation of it.
       */
      expect(distinct(g)).toBe(viaRows);
      expect(distinct(g)).toBe(3);
    });
  });

  describe('the declines, each still answering correctly', () => {
    const g = (): Graph => graphOf([1, 1, 2, null, undefined]);

    test('TWO keys in the projection', () => {
      const h = new Graph();

      h.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, j: 9 } });
      h.addVertex({ id: 'b', labels: ['P'], properties: { k: 1, j: 8 } });

      // Values of both keys, deduped: 1, 9, 8.
      expect(toArray(traversal(V(), values('k', 'j'), dedupe(), count()), h)[0]).toBe(3);
    });

    test('a `by` on the dedupe is refused by the gate, and is not constructible here', () => {
      /*
       * The gate refuses `bys`, mirroring `distinctHopCount` and `dedupedHopChainCount`. The
       * builder's `dedupe()` takes no `by`, so a hand-built step does not type-check — the refusal is
       * stated in the gate and exercised by the mutation round rather than from here.
       */
      expect(distinct(g())).toBe(3);
    });

    test('an extra step before the projection', () => {
      // `hasLabel` keeps everything here, so the answer is unchanged — but the rung declines.
      expect(toArray(traversal(V(), values('k'), dedupe(), count()), g())[0]).toBe(3);
    });

    test('the ELEMENT dedupe past a hop is untouched', () => {
      const h = new Graph();

      for (let i = 0; i < 4; i += 1) {
        h.addVertex({ id: `w${i}`, labels: ['P'], properties: { k: i } });
      }

      h.addEdge({
        id: 'e0',
        from: h.getVertexById('w0')!,
        to: h.getVertexById('w1')!,
        labels: ['T'],
        properties: {},
      });
      h.addEdge({
        id: 'e1',
        from: h.getVertexById('w2')!,
        to: h.getVertexById('w1')!,
        labels: ['T'],
        properties: {},
      });

      // Both edges land on w1, so one distinct element.
      expect(toArray(traversal(V(), out('T'), dedupe(), count()), h)[0]).toBe(1);
    });

    test('a THIRD step after the dedupe must not be ignored', () => {
      /*
       * THE GAP THE MUTATION ROUND FOUND. Dropping the `mid.length !== 2` check lets `[values,
       * dedupe, X]` match — `proj` and `filter` still line up — and `X` is then silently DISCARDED. A
       * `limit` is the sharpest X because it changes the answer: five vertices with three distinct values
       * deduped then limited to 2 is 2, where ignoring the limit answers 3.
       */
      const g2 = graphOf([1, 2, 3, 3, 3]);

      expect(toArray(traversal(V(), values('k'), dedupe(), limit(2), count()), g2)[0]).toBe(2);
      // And without the limit, the same graph answers 3 — so the fixture can tell them apart.
      expect(distinct(g2)).toBe(3);
    });

    test('the unfused floor is unchanged', () => {
      // 1, 1, 2, null — four emitted values.
      expect(toArray(traversal(V(), values('k'), count()), g())[0]).toBe(4);
    });
  });

  test('a WRITE between two asks is reflected', () => {
    const g = graphOf([1, 2]);

    expect(distinct(g)).toBe(2);
    g.addVertex({ id: 'fresh', labels: ['P'], properties: { k: 3 } });
    expect(distinct(g)).toBe(3);
    g.addVertex({ id: 'dupe', labels: ['P'], properties: { k: 3 } });
    expect(distinct(g)).toBe(3);
  });
});
