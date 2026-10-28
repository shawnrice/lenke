/**
 * Item 1086: the UNDIRECTED tally — `(a)-[:T]-(x)` with a constraint a degree sum cannot apply.
 *
 * `buildOneHopCount` declined a far label, a far-reading predicate and a rel constraint on an
 * undirected hop outright, so each fell to the general path and built a binding and a row per
 * edge. Item 1076's own controls measured them at 362.35 / 910.25 / 922.25 ms against 25 for the
 * start-constrained twin; `undirectedTally` answers all three at 76.17 / 66.61 / 35.57.
 *
 * WHAT GIVES THESE TESTS TEETH. The arm is answer-equivalent to the route it replaces, so the
 * oracle is that route: every case asserts the fast route against the SAME pattern with `AND true`
 * appended, which forces a real predicate and therefore the general path (item 570's control).
 *
 * THE SELF-LOOP IS THE ONLY ARITHMETIC, and `loopTally` is a SECOND COPY of the per-edge rule —
 * deliberate, because the alternative was a branch inside `tallyHopCount`'s per-edge body, which
 * item 1033 measured at ~2x on three shapes that cannot even reach it. The drift risk that
 * duplication carries is what the `a PASSING self-loop` block below exists to hold: it puts a loop
 * that SATISFIES the constraint through every constraint kind separately, so a gate missing from
 * `loopTally` alone is caught rather than cancelling out.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * An expected count per self-loop variant.
 *
 * NOT cosmetic. Indexing the OBJECT LITERAL `{ 0: a, 1: b, 3: c }[loops]` with a `number` yields
 * `number | undefined`, because the literal's keys are literal types — and `toBe` refuses that.
 * Widening the parameter to `Record<number, number>` makes the index a `number`, so this is the
 * fix rather than a cast over the top of it; `bun run check` rejected both the raw indexing and
 * then an `as number` on this line as unnecessary. `check` caught the same pattern at item 1078,
 * in a gate neither `lint` nor `fmt` looks at.
 */
const per = (m: Record<number, number>, loops: number): number => m[loops];

/** The fast route and the general path on ONE pattern, asserted equal and returned. */
const both = (g: Graph, pattern: string, filter: string): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} ${filter} RETURN count(*) AS c`)[0].c;
  const slow = query<{ c: number }>(
    g,
    `MATCH ${pattern} ${filter} AND true RETURN count(*) AS c`,
  )[0].c;

  expect(fast).toBe(slow);

  return fast;
};

/**
 * `loops` self-loops on the first `loops` vertices, every one of them carrying `w: 1` and a `P`
 * label — so a loop PASSES each constraint the tests below apply, which is the only way a missing
 * gate in `loopTally` is visible.
 */
const fixture = (loops: number): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: i < 5 ? ['P'] : ['Q'], properties: { k: i } }),
  );

  g.addEdge({ id: 'e0', labels: ['T'], from: vs[0], to: vs[1], properties: { w: 1 } });
  g.addEdge({ id: 'e1', labels: ['T'], from: vs[1], to: vs[2], properties: { w: 1 } });
  g.addEdge({ id: 'e2', labels: ['T'], from: vs[3], to: vs[1], properties: { w: 2 } });
  // One edge to the `Q` vertex, so a far LABEL is selective rather than vacuous.
  g.addEdge({ id: 'e3', labels: ['T'], from: vs[4], to: vs[5], properties: { w: 1 } });
  g.addEdge({ id: 'o0', labels: ['S'], from: vs[0], to: vs[2], properties: { w: 1 } });

  for (let i = 0; i < loops; i++) {
    g.addEdge({ id: `l${i}`, labels: ['T'], from: vs[i], to: vs[i], properties: { w: 1 } });
  }

  return g;
};

describe('a FAR constraint on an undirected hop', () => {
  for (const loops of [0, 1, 3]) {
    describe(`${loops} self-loops`, () => {
      test('a far LABEL', () => {
        const g = fixture(loops);

        expect(both(g, '(a)-[:T]-(x:P)', 'WHERE true')).toBe(per({ 0: 7, 1: 8, 3: 10 }, loops));
        expect(both(g, '(a)-[:T]-(x:Q)', 'WHERE true')).toBe(1);
      });

      test('a predicate reading the FAR end', () => {
        const g = fixture(loops);

        // The loops sit on `v0..v(loops-1)`, so one lands on `v1` only when `loops === 3` —
        // which is why this is `loops === 3` and not `loops > 0`. Both of my first literals here
        // were wrong and `both`'s own equality held, so every number is read off the two routes.
        expect(both(g, '(a)-[:T]-(x)', 'WHERE x.k = 1')).toBe(loops === 3 ? 4 : 3);
        expect(both(g, '(a)-[:T]-(x)', 'WHERE x.k > 3')).toBe(2);
      });

      test('an inline FAR property', () => {
        const g = fixture(loops);

        expect(both(g, '(a)-[:T]-(x {k: 1})', 'WHERE true')).toBe(loops === 3 ? 4 : 3);
      });

      test('BOTH ends constrained', () => {
        const g = fixture(loops);

        expect(both(g, '(a:P)-[:T]-(x:P)', 'WHERE a.k = 1 AND x.k = 2')).toBe(1);
        expect(both(g, '(a)-[:T]-(x)', 'WHERE a.k < x.k')).toBe(4);
      });
    });
  }
});

describe('a REL constraint on an undirected hop', () => {
  for (const loops of [0, 1, 3]) {
    test(`${loops} self-loops`, () => {
      const g = fixture(loops);

      // `w: 1` is what every loop carries, so the loop correction has to fire here.
      expect(both(g, '(a)-[r:T]-(x)', 'WHERE r.w = 1')).toBe(per({ 0: 6, 1: 7, 3: 9 }, loops));
      expect(both(g, '(a)-[r:T]-(x)', 'WHERE r.w = 2')).toBe(2);
      expect(both(g, '(a)-[r:T {w: 1}]-(x)', 'WHERE true')).toBe(per({ 0: 6, 1: 7, 3: 9 }, loops));
      // A rel constraint TOGETHER with a far one, so neither gate can hide the other.
      expect(both(g, '(a)-[r:T]-(x:Q)', 'WHERE r.w = 1')).toBe(1);
    });
  }
});

describe('a self-loop, one constraint kind at a time', () => {
  // THE DRIFT GUARD for `loopTally` being a second copy of the per-edge rule — and MUTATION
  // CORRECTED ITS DESIGN. The first version asserted only loops that PASS the constraint and its
  // comment claimed a FAILING loop "would pass whether or not the gate is there". That is exactly
  // backwards, and `looptally-drops-inrel` SURVIVED because of it:
  //
  //   - a loop that PASSES is counted twice by the two directions and once by `loopTally`. Gates
  //     only ever REJECT, so removing one leaves a passing loop still counted — same answer.
  //   - a loop that FAILS is counted ZERO times by the two directions, so `loopTally` must count
  //     zero too. Remove a gate and it counts one, subtracting a double-count that never happened.
  //
  // So the FAILING loop is the case with teeth, and both are kept: the passing one pins the
  // correction's arithmetic, the failing one pins each gate.
  const looped = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    g.addEdge({ id: 'plain', labels: ['T'], from: a, to: b, properties: { w: 1 } });
    g.addEdge({ id: 'loop', labels: ['T'], from: a, to: a, properties: { w: 1 } });

    return g;
  };

  test('the far LABEL gate', () => {
    expect(both(looped(), '(a)-[:T]-(x:P)', 'WHERE true')).toBe(3);
  });

  test('the far PREDICATE gate', () => {
    expect(both(looped(), '(a)-[:T]-(x)', 'WHERE x.k = 1')).toBe(2);
  });

  test('the far INLINE gate', () => {
    expect(both(looped(), '(a)-[:T]-(x {k: 1})', 'WHERE true')).toBe(2);
  });

  test('the REL predicate gate', () => {
    expect(both(looped(), '(a)-[r:T]-(x)', 'WHERE r.w = 1')).toBe(3);
  });

  test('the REL inline gate', () => {
    expect(both(looped(), '(a)-[r:T {w: 1}]-(x)', 'WHERE true')).toBe(3);
  });

  test('the START predicate gate, on the tally rather than the degree sum', () => {
    // A start predicate ALONE takes the degree sum; paired with a far one it takes the tally, so
    // this asserts the tally's own start gate.
    expect(both(looped(), '(a)-[:T]-(x)', 'WHERE a.k = 1 AND x.k >= 1')).toBe(2);
  });

  /**
   * The same two edges with the loop FAILING every constraint — `w: 9` and `k: 7` against the
   * plain edge's `w: 1`. This is the arm with teeth (see the block comment): each case's correct
   * answer counts the plain edge twice and the loop not at all, so a `loopTally` missing that
   * gate subtracts one and answers one less.
   */
  const failing = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
    const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 7 } });

    g.addEdge({ id: 'plain', labels: ['T'], from: a, to: b, properties: { w: 1 } });
    g.addEdge({ id: 'loop', labels: ['T'], from: c, to: c, properties: { w: 9 } });

    return g;
  };

  test('a loop FAILING the far LABEL', () => {
    expect(both(failing(), '(a)-[:T]-(x:P)', 'WHERE true')).toBe(2);
  });

  test('a loop FAILING the far PREDICATE', () => {
    expect(both(failing(), '(a)-[:T]-(x)', 'WHERE x.k < 7')).toBe(2);
  });

  test('a loop FAILING the far INLINE', () => {
    expect(both(failing(), '(a)-[:T]-(x {k: 2})', 'WHERE true')).toBe(1);
  });

  test('a loop FAILING the REL predicate', () => {
    expect(both(failing(), '(a)-[r:T]-(x)', 'WHERE r.w = 1')).toBe(2);
  });

  test('a loop FAILING the REL inline', () => {
    // `looptally-drops-inrel` survived until this case existed: the previous fixture gave BOTH
    // edges `w: 1`, so the rel gate was vacuous in it — the coinciding-fixture trap this repo
    // keeps re-learning.
    expect(both(failing(), '(a)-[r:T {w: 1}]-(x)', 'WHERE true')).toBe(2);
  });

  test('a loop FAILING the START predicate', () => {
    expect(both(failing(), '(a)-[:T]-(x)', 'WHERE a.k < 7 AND x.k >= 1')).toBe(2);
  });
});
