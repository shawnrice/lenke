/**
 * ✅✅ **ITEM 169's INVARIANT FOR THE THREE SCAN RUNGS CONVERTED AT ITEM 2322.**
 *
 * `nodeValuesWhereShortcut`, and the two dedupe rungs, had `drain: () => [...walk()]`. Each is now a plain
 * loop over `graph.vertices` (**2.34x** on the `where(<hop>)` filter, **1.49x** on the dedupe), sharing the
 * walk's per-vertex rule but not its code — which is exactly the divergence item 169 warned about, and
 * Gremlin results are compared ORDERED by the differential fuzzer.
 *
 * ⚠️⚠️ **AND THE DEDUPE RUNGS CARRY A SHARPER RISK THAN ORDER: `valueDedupeFilter()` IS STATEFUL.** The
 * generator builds a fresh filter per invocation. A `drain` that hoisted it would share ONE filter across
 * calls — correct the first time, **returning NOTHING every time after.** 🔑 So every test here calls
 * `drain` TWICE and asserts both results; a single call cannot see that bug at all.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, dedupe, out, values, where } from '../steps.js';
import { traversal } from '../traversal.js';
import { run } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  /* ✅ `k` repeats, so dedupe has something to collapse; `d` has no `k` (the `key in props` skip). */
  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 1],
  ] as const) {
    g.addVertex({ id, labels: ['N'], properties: { k } });
  }

  g.addVertex({ id: 'd', labels: ['N'], properties: { other: 9 } });
  /* ✅ `e` has `k` but NO outgoing edge, so the `where(out('E'))` filter must exclude it. */
  g.addVertex({ id: 'e', labels: ['N'], properties: { k: 7 } });

  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => g.getVertexById(x));

  if (a === null || b === null || c === null || d === null) {
    throw new Error('fixture vertices missing');
  }

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: c, to: a, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e4', from: d, to: a, labels: ['E'], properties: {} });

  return g;
};

describe('converted scan drains: lazy ≡ eager, and eager is REPEATABLE', () => {
  for (const [name, plan, expected] of [
    /* ✅ `e` is excluded (no out-edge), `d` is excluded (no `k`). */
    ['where(out(E)) + values', traversal(V(), where(out('E')), values('k')), [1, 2, 1]],
    /* ✅ dedupe collapses the repeated 1; `e`'s 7 survives because there is no hop filter. */
    ['values + dedupe', traversal(V(), values('k'), dedupe()), [1, 2, 7]],
    /* ✅ both filters at once — the third converted rung. */
    [
      'where(out(E)) + values + dedupe',
      traversal(V(), where(out('E')), values('k'), dedupe()),
      [1, 2],
    ],
  ] as const) {
    test(name, () => {
      const g = build();
      const it = run(plan, g) as Iterable<unknown> & { drain?: () => unknown[] };

      /*
       * ⚠️ WITHOUT THIS THE TEST PROVES NOTHING: a shape whose rung declined offers no `drain`, so both
       * arms would come from the same generator and the comparison is vacuous. Item 2319's twin of this
       * guard fired on its first run.
       */
      expect(typeof it.drain, 'the converted rung must offer drain').toBe('function');

      const drain = it.drain as () => unknown[];

      /* 🔑 TWICE — a hoisted stateful `keep` is right once and empty forever after. */
      const first = drain();
      const second = drain();

      expect(first).toStrictEqual([...expected]);
      expect(second, 'drain must be repeatable').toStrictEqual([...expected]);

      /* ✅ And the lazy iterator agrees, element for element and in order. */
      expect([...run(plan, g)]).toStrictEqual([...expected]);
    });
  }
});
