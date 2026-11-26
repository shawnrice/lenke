/**
 * **ITEM 169's INVARIANT FOR `edgeValuesShortcut` (item 2321).**
 *
 * `drain` used to be `[...edgeValuesWalk(…)]` — one derivation, so divergence was impossible, but it paid
 * the generator protocol per edge. It is now a plain loop over `graph.edges` (**3.47x**, 26.6 → 7.7 ns an
 * edge over 60,000), sharing only the per-edge `emit` decision with the generator.
 *
 * **SO THE RISK IS NOW EXACTLY ITEM 169's**: two loops that disagree. Gremlin results are compared
 * ORDERED by the differential fuzzer, so disagreeing about membership OR order is a wrong answer.
 *
 * The fixture covers what the two could plausibly differ on: an edge MISSING the projected key (the
 * `key in props` skip), an edge with a non-matching label (the label filter), and an edge carrying SEVERAL
 * labels (so `labels.some` is exercised rather than a single-label shortcut).
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { E, hasLabel, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { edgeValuesShortcut } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['N'], properties: {} });
  g.addVertex({ id: 'b', labels: ['N'], properties: {} });

  /* `getVertexById` returns `Vertex | null`, so narrow rather than cast — a null here would make
   * every `addEdge` below silently build a different graph than the test describes. */
  const a = g.getVertexById('a');
  const b = g.getVertexById('b');

  if (a === null || b === null) {
    throw new Error('fixture vertices missing');
  }

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: { w: 1 } });
  /* No `w` — exercises the `key in props` skip. */
  g.addEdge({ id: 'e2', from: a, to: b, labels: ['E'], properties: { other: 2 } });
  /* Wrong label — exercises the label filter in both derivations. */
  g.addEdge({ id: 'e3', from: a, to: b, labels: ['Other'], properties: { w: 3 } });
  /* SEVERAL labels — exercises `labels.some` rather than a single-label fast path. */
  g.addEdge({ id: 'e4', from: a, to: b, labels: ['Other', 'E'], properties: { w: 4 } });

  return g;
};

describe('edgeValuesShortcut: the lazy iterator and the eager drain agree exactly', () => {
  for (const [name, plan, expected] of [
    /* No label filter: every edge that HAS `w`, in insertion order. */
    ['no label filter', traversal(E(), values('w')), [1, 3, 4]],
    /* With a label filter: `e3` is excluded, `e4` included via its second label. */
    ['with a label filter', traversal(E(), hasLabel('E'), values('w')), [1, 4]],
  ] as const) {
    test(name, () => {
      const g = build();
      const shortcut = edgeValuesShortcut(plan, g);

      /*
       * WITHOUT THIS THE TEST PROVES NOTHING — a declined shortcut means both arms come from the same
       * general pipeline and the comparison is vacuous. Item 2319's twin of this guard fired on its
       * first run, so it is not hypothetical.
       */
      expect(shortcut, 'the shortcut must take this shape').toBeDefined();

      const lazy = [...(shortcut as Iterable<unknown>)];
      const eager = (shortcut as { drain: () => unknown[] }).drain();

      /* Same elements, SAME ORDER. */
      expect(eager).toStrictEqual(lazy);

      /*
       * And both equal the DEFINED output, so two loops wrong in the SAME direction still fail —
       * equality between the pair alone would not catch that.
       */
      expect(lazy).toStrictEqual([...expected]);
    });
  }
});
