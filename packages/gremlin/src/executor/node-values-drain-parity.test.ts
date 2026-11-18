/**
 * ✅✅ **ITEM 169's INVARIANT FOR `nodeValuesShortcut`'s THREE PROJECTIONS (item 2320).**
 *
 * That shortcut returns an object with a lazy `[Symbol.iterator]` (one of three sibling generators —
 * `walkIds`, `walkLabels`, `walkValues`) and an eager `drain`. `drain` used to be `[...walk()]`, which made
 * divergence impossible but paid the generator protocol PER VERTEX: a profile of `V().values(k)` over
 * 50,000 vertices put `drain` at 55.08% and `walkValues` at 35.44% — 90.52% in the two of them. 🔑 `drain`
 * is now a sibling plain loop per projection (**3.86x**, 24.7 → 6.4 ns a row).
 *
 * ⚠️ **SO WHAT CAN NOW GO WRONG IS EXACTLY WHAT ITEM 169 WARNED ABOUT**: three pairs of loops that could
 * disagree. Gremlin results are compared ORDERED by the differential fuzzer, so a disagreement about
 * membership OR order is a wrong answer. These tests pin all three pairs equal, element for element.
 *
 * ⚠️ The fixtures are chosen for the cases the two derivations could plausibly differ on: a vertex MISSING
 * the projected key (the `key in props` skip), a vertex with NO labels (which must yield `null`, not
 * `undefined` — `dispatch.ts`'s `case 'label'` is the contract), and a vertex with several labels.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, id, label, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { nodeValuesShortcut } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['User'], properties: { score: 1 } });
  /* ⚠️ No `score` — exercises the `key in props` skip, which only the values arm has. */
  g.addVertex({ id: 'b', labels: ['User'], properties: { other: 2 } });
  /* ⚠️ No labels at all — the label arm must yield `null` here in BOTH derivations. */
  g.addVertex({ id: 'c', labels: [], properties: { score: 3 } });
  g.addVertex({ id: 'd', labels: ['Admin', 'User'], properties: { score: 4 } });

  return g;
};

describe('nodeValuesShortcut: the lazy iterator and the eager drain agree exactly', () => {
  for (const [name, plan, expected] of [
    ['values projection', traversal(V(), values('score')), [1, 3, 4]],
    ['id projection', traversal(V(), id()), ['a', 'b', 'c', 'd']],
    ['label projection', traversal(V(), label()), ['User', 'User', null, 'Admin']],
  ] as const) {
    test(name, () => {
      const g = build();
      const shortcut = nodeValuesShortcut(plan, g);

      /*
       * ⚠️ WITHOUT THIS THE TEST PROVES NOTHING. If the shortcut declines, the general pipeline answers
       * and both arms below come from the same code — a vacuous pass. Item 2319's twin of this guard
       * fired on its first run, so it is not hypothetical.
       */
      expect(shortcut, 'the shortcut must take this shape').toBeDefined();

      const lazy = [...(shortcut as Iterable<unknown>)];
      const eager = (shortcut as { drain: () => unknown[] }).drain();

      /* ✅ Same elements, SAME ORDER — `toStrictEqual` on arrays is order-sensitive. */
      expect(eager).toStrictEqual(lazy);

      /*
       * ✅ And both equal what the projection is DEFINED to produce, so a pair that diverged in the same
       * direction (two wrong loops) still fails. Equality between the two alone would not catch that.
       */
      expect(lazy).toStrictEqual([...expected]);
    });
  }
});
