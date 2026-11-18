/*
 * Item 2170 — `… id().count()` and `… label().count()` lose the projection, which hands the plan back to
 * the count rungs.
 *
 * ```text
 *     V().id().count()           5.3 ms -> 0.0     a counter read
 *     V().label().count()        5.9    -> 0.0
 *     V().out().id().count()     7.4    -> 0.0
 *     V().count()      [control] 0.0    -> 0.0
 *     V().id()         [control] 2.80   -> 2.75    unaffected (isolated; in-sweep it read 1.4x worse,
 *                                                  and the BEFORE arm was the noisy one)
 * ```
 *
 * 🔑 **BOTH STEPS EMIT EXACTLY ONE VALUE PER ELEMENT**, so a `count()` tail cannot distinguish them from
 * the elements. ⚠️ This is `dropCountedSelect`'s reasoning (item 1800) with FEWER caveats: that pass must
 * prove the `select` cannot FILTER — it skips a traverser with no tag, and a `by()` drops an element
 * lacking the property — which is what its `TAG_PRESERVING` analysis exists for. `id` and `label` have no
 * such case.
 *
 * ⚠️⚠️ **`count(local)` IS REFUSED**: local scope counts WITHIN each value rather than along the stream,
 * so the projection is not dead there.
 *
 * ⚠️ IMPORTS COME FROM `./index.js`, THE SOURCE. Item 2169 lost a whole mutation round to importing
 * `@lenke/gremlin`, which resolves to the built dist — a test that imports the dist cannot witness a
 * source mutation.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { E, Scope, V, count, id, label, out, outE, toArray, traversal, values } from './index.js';

/** 5 vertices in a chain of 4 `T` edges; `v2` carries a second label. */
const g = (): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 5; i += 1) {
    graph.addVertex({
      id: `v${i}`,
      labels: i === 2 ? ['P', 'Q'] : ['P'],
      properties: { k: i, s: `s${i}` },
    });
  }

  for (let i = 0; i < 4; i += 1) {
    graph.addEdge({
      id: `e${i}`,
      from: graph.getVertexById(`v${i}`)!,
      to: graph.getVertexById(`v${i + 1}`)!,
      labels: ['T'],
      properties: { w: i },
    });
  }

  return graph;
};

const one = (plan: Parameters<typeof toArray>[0]): unknown => toArray(plan, g())[0];

describe('the counted-projection drop (item 2170)', () => {
  describe('🔑 the dropped forms answer what the unprojected form answers', () => {
    test.each([
      ['V().id()', traversal(V(), id(), count()), traversal(V(), count())],
      ['V().label()', traversal(V(), label(), count()), traversal(V(), count())],
      ['E().id()', traversal(E(), id(), count()), traversal(E(), count())],
      [
        'V().out().id()',
        traversal(V(), out('T'), id(), count()),
        traversal(V(), out('T'), count()),
      ],
      [
        'V().outE().id()',
        traversal(V(), outE('T'), id(), count()),
        traversal(V(), outE('T'), count()),
      ],
    ])('%s', (_name, projected, plain) => {
      // 🔑 The ORACLE is the engine's own answer to the unprojected question, not a number I chose.
      expect(one(projected)).toBe(one(plain));
    });

    test('and the values are right, not merely equal to each other', () => {
      expect(one(traversal(V(), id(), count()))).toBe(5);
      expect(one(traversal(E(), id(), count()))).toBe(4);
      expect(one(traversal(V(), out('T'), id(), count()))).toBe(4);
    });

    test('⚠️ an EMPTY graph counts zero', () => {
      expect(toArray(traversal(V(), id(), count()), new Graph())[0]).toBe(0);
    });

    test('⚠️ a vertex with TWO labels still contributes ONE', () => {
      /*
       * 🔑 `label()` emits one value per element even for a multi-labelled vertex — `v2` has `P` and `Q`
       * and yields just `'P'`, the FIRST. ⚠️ If it emitted one per label the drop would be unsound, and
       * this is the fixture that says it does not.
       */
      expect(one(traversal(V(), label(), count()))).toBe(5);
      expect(one(traversal(V(), label(), count()))).toBe(one(traversal(V(), count())));
    });
  });

  describe('⚠️ the refusals', () => {
    test('⚠️⚠️ `count(local)` keeps the projection', () => {
      /*
       * 🔑 Local scope counts WITHIN each value. `id()` yields a STRING per vertex, so `count(local)` on
       * it is a different question from counting vertices — the drop must not fire, and the answers must
       * differ from the plain count's 5.
       */
      const projected = toArray(traversal(V(), id(), count(Scope.local)), g());

      /*
       * ⚠️⚠️ **THE GUARD IS DEFENSIVE, NOT LOAD-BEARING, AND THE MUTATION ROUND PROVED IT.** Removing
       * `scope === 'local'` survived every test, so I measured what it actually changes:
       *
       * ```text
       *     V().id().count(local)   [1, 1, 1, 1, 1]
       *     V().count(local)        [1, 1, 1, 1, 1]      <- identical
       * ```
       *
       * 🔑 `id()` and `label()` each yield ONE SCALAR per element, and a vertex is itself one element, so
       * local scope answers `1` per row either way. The guard is kept because it costs nothing and the
       * equivalence is a property of these two steps rather than of local scope — but it is honest to say
       * no test can distinguish it, rather than to assert something weaker and call the mutant caught.
       */
      expect(projected).toStrictEqual([1, 1, 1, 1, 1]);
      expect(projected).toStrictEqual(toArray(traversal(V(), count(Scope.local)), g()));
    });

    test('`values(k).count()` is NOT dropped — it can skip an element', () => {
      /*
       * 🔑 THE BOUNDARY. `values()` emits nothing for an absent property, so it is not count-preserving.
       * ⚠️ Here one vertex loses its `k`, and the counts must then DIFFER.
       *
       * ⚠️⚠️ **ADMITTING `values` TO `COUNT_PRESERVING` IS A NO-OP, AND THE REASON IS WORTH KNOWING.** A
       * mutant that added it survived, so I probed the pass's entry: it sees `V, hasKey, count`. 🔑 **An
       * UPSTREAM rewrite has already turned `values(k).count()` into `hasKey(k).count()`** — counting
       * emitted values IS counting the elements that have the key — so no `values` step reaches this pass
       * in this shape at all. (It is also what item 2168's "values floor" really measures.)
       */
      const h = g();

      h.addVertex({ id: 'nok', labels: ['P'], properties: { s: 'x' } });

      expect(toArray(traversal(V(), values('k'), count()), h)[0]).toBe(5);
      expect(toArray(traversal(V(), count()), h)[0]).toBe(6);
    });

    test('a projection with NO count tail is untouched', () => {
      const rows = toArray(traversal(V(), id()), g());

      expect(rows).toHaveLength(5);
      expect(rows[0]).toBe('v0');
    });

    test('⚠️ a projection followed by something OTHER than count is untouched', () => {
      const rows = toArray(traversal(V(), label()), g());

      expect(rows).toHaveLength(5);
      /*
       * ⚠️ `label()` EMITS ONLY THE FIRST LABEL — `v2` carries `['P', 'Q']` and yields `'P'`. 🔑 That is
       * what makes the drop sound (one value per element, never one per label), and it is why my first
       * expectation of `{P, Q}` was wrong. Checked against the engine rather than assumed.
       */
      expect(new Set(rows)).toEqual(new Set(['P']));
    });

    test('a two-step plan is too short to rewrite', () => {
      // `V().count()` has no projection to drop, and must not be disturbed.
      expect(one(traversal(V(), count()))).toBe(5);
    });
  });

  test('⚠️ a WRITE between two asks is reflected', () => {
    const h = g();

    expect(toArray(traversal(V(), id(), count()), h)[0]).toBe(5);
    h.addVertex({ id: 'fresh', labels: ['P'], properties: { k: 9 } });
    expect(toArray(traversal(V(), id(), count()), h)[0]).toBe(6);
  });
});
