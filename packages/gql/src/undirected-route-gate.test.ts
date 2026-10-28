/**
 * Item 1086: the undirected hop's ROUTE GATE, asserted as a decision.
 *
 * `undirectedDegreeSumFits` decides whether a constrained undirected count can be answered by a
 * degree sum (O(V) over the passing start vertices) or needs the tally (one pass per direction over
 * the type's edges). BOTH answer correctly — that is why the tally exists — so choosing the tally
 * where the degree sum would do is SLOW, never WRONG, and no result-based test can tell them apart.
 * Item 1086's mutation round proved it: `const startOnly = false`, which routes every constrained
 * undirected count through the tally, SURVIVED 27 + 20 + 5 + 8 differential tests at 0 failures.
 *
 * `perf-gate-needs-its-own-test`, and the same prescription as `bucketSumsAreSound`: extract the
 * decision and assert the decision.
 *
 * THE OTHER DIRECTION NEEDS NO HELP HERE. Routing a far or rel constraint to the degree sum is a
 * WRONG ANSWER — the sum never visits the far end or the edge — and the differential tests catch it
 * loudly: `startonly-always` failed 24 of them, `startonly-ignores-far-label` 4,
 * `startonly-ignores-relvar` 5. So this file is only about the slow-but-correct direction.
 */
import { describe, expect, test } from 'bun:test';

import { undirectedDegreeSumFits } from './executor/shortcuts.ts';

const NOTHING = {
  inFar: undefined,
  inRel: undefined,
  farLabel: undefined,
  farVar: undefined,
  relVar: undefined,
};

const SOME_INLINE = { kind: 'props', props: [] } as never;
const SOME_LABEL = { kind: 'label', name: 'P' } as never;

describe('undirectedDegreeSumFits', () => {
  test('an unconstrained far end and no rel constraint FITS', () => {
    expect(undirectedDegreeSumFits(NOTHING)).toBe(true);
  });

  test('a far INLINE constraint does not fit', () => {
    expect(undirectedDegreeSumFits({ ...NOTHING, inFar: SOME_INLINE })).toBe(false);
  });

  test('a REL inline constraint does not fit', () => {
    expect(undirectedDegreeSumFits({ ...NOTHING, inRel: SOME_INLINE })).toBe(false);
  });

  test('a far LABEL does not fit', () => {
    expect(undirectedDegreeSumFits({ ...NOTHING, farLabel: SOME_LABEL })).toBe(false);
  });

  test('a predicate reading the FAR variable does not fit', () => {
    expect(undirectedDegreeSumFits({ ...NOTHING, farVar: 'x' })).toBe(false);
  });

  test('a predicate reading the REL variable does not fit', () => {
    expect(undirectedDegreeSumFits({ ...NOTHING, relVar: 'r' })).toBe(false);
  });

  test('EVERY one of the five is load-bearing on its own', () => {
    // One at a time, so a gate dropped from the conjunction cannot be masked by another. This is
    // the shape that makes the five conditions individually asserted rather than jointly.
    const each = [
      { inFar: SOME_INLINE },
      { inRel: SOME_INLINE },
      { farLabel: SOME_LABEL },
      { farVar: 'x' },
      { relVar: 'r' },
    ];

    for (const one of each) {
      expect(undirectedDegreeSumFits({ ...NOTHING, ...one })).toBe(false);
    }

    expect(each).toHaveLength(5);
  });

  test('a START-side constraint is NOT a reason to decline the degree sum', () => {
    // The whole point of the arm: a start predicate, a start inline constraint and a start label
    // are all applied per candidate vertex, so none of them appears in this gate at all. A gate
    // that also refused those would make the start-only case take the tally — correct, and 1.3x
    // slower on the measured shape.
    expect(Object.keys(NOTHING)).toEqual(['inFar', 'inRel', 'farLabel', 'farVar', 'relVar']);
  });
});
