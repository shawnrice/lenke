/**
 * ✅✅ **`filter(<hop>)` AND `where(<hop>)` MUST TAKE THE SAME RUNG (item 2323).**
 *
 * `dispatch.ts`'s `case 'filter'` has always contracted the two as one — "the same step as the sub-plan
 * `where`, so the same fusion" — but the two `nodeValues…Where…` rungs gated on `'where'` alone, so
 * `filter(out(E)).values(k)` fell to the general pipeline: **78.45 ns a row against `where`'s 13.56, a
 * 5.8x divergence between spellings that return the same answer.** Admitting `filter` converges them
 * (13.49 against 13.47).
 *
 * ⚠️⚠️ **A ROUTE CHOICE IS ANSWER-EQUIVALENT, SO AN ANSWER TEST CANNOT GUARD IT** —
 * `perf-gate-needs-its-own-test` is this repo's record of that, and every historical bug of this class
 * "returned the correct answer, so no correctness test could catch it". ✅ These tests therefore assert the
 * ROUTE: that both spellings reach a rung offering the fused `count`, which the general pipeline does not.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, count, filter, out, values, where } from '../steps.js';
import { traversal } from '../traversal.js';
import { run } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['N'], properties: { k: id } });
  }

  /* ⚠️ `c` gets NO out-edge, so the existence filter has something to exclude. */
  const [a, b] = [g.getVertexById('a'), g.getVertexById('b')];

  if (a === null || b === null) {
    throw new Error('fixture vertices missing');
  }

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: b, to: a, labels: ['E'], properties: {} });

  return g;
};

describe('filter(<hop>) and where(<hop>) take the same rung', () => {
  test('both reach the fused walk, which offers count()', () => {
    const g = build();

    const viaWhere = run(traversal(V(), where(out('E')), values('k')), g) as {
      count?: () => number;
    };
    const viaFilter = run(traversal(V(), filter(out('E')), values('k')), g) as {
      count?: () => number;
    };

    /*
     * 🔑 THE ROUTE ASSERTION. `nodeValuesWhereShortcut` attaches a fused `count` (item 2062); the general
     * pipeline does not. ⚠️ Asserting only that `where` has it would pass before this fix too — the
     * load-bearing half is that `filter` has it as well.
     */
    expect(typeof viaWhere.count, 'where must reach the fused walk').toBe('function');
    expect(typeof viaFilter.count, 'filter must reach the SAME fused walk').toBe('function');

    /* ✅ And the fused count agrees between them, not merely exists. */
    expect((viaFilter.count as () => number)()).toBe(2);
    expect((viaWhere.count as () => number)()).toBe(2);
  });

  test('and they agree on the answer, in order', () => {
    const g = build();

    const w = [...run(traversal(V(), where(out('E')), values('k')), g)];
    const f = [...run(traversal(V(), filter(out('E')), values('k')), g)];

    /* ✅ `c` is excluded by both; order is the scan's. */
    expect(w).toStrictEqual(['a', 'b']);
    expect(f).toStrictEqual(w);
  });

  test('the dedupe sibling rung admits filter too', () => {
    const g = build();

    const viaFilter = run(traversal(V(), filter(out('E')), values('k'), count()), g);
    const viaWhere = run(traversal(V(), where(out('E')), values('k'), count()), g);

    expect([...viaFilter]).toStrictEqual([2]);
    expect([...viaWhere]).toStrictEqual([2]);
  });
});
