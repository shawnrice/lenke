// `V().values(k)` + a fused residual (item 2021).
//
// ⚠️⚠️ **THE SCAN RUNG REQUIRED THE PLAN TO BE EXACTLY `V() + values(k)`** — "and nothing after it" —
// so every trailing step dropped the whole query onto the traverser pipeline. That is why `dedupe`
// needed a rung of its own (item 1869) and why `order()` never got one:
//
//     V().values(n)             6.0 ms    the fused scan
//     V().values(n).order()    40.4       the pipeline  —  3.4x off its own hand floor of 11.8
//
// `scanValuesResidual` hands the scan walk to `fusedProjectedResidual`, which has handled a trailing
// `order`/`count`/`fold`/`min`/`max`/`cap` for the HOP walks since items 1630-2020. So this is one
// gate, five residuals.
//
// 🔑 THE ORACLE IS A SPELLING THAT CANNOT TAKE THE SCAN. `V().hasLabel(L).values(k)…` is refused by
// `nodeValuesShortcut` outright (item 1870 — the pipeline's `seedFromIndex` beats a full scan for
// every selective label, up to 678x), so with a label that covers EVERY vertex it is the same
// question answered by the general route. Compared element for element.
//
// ⚠️ AND `sum`/`mean` MUST STAY ON THE PIPELINE. `fusableProjectedAggregate` admits only `min`/`max`
// because f64 addition is order-sensitive in its last ulp and the fused walk's visit order is not
// the pipeline's — byte-identity with the Rust engine is a hard invariant. Their answers are pinned
// here so a later widening that reached for them has to break this file.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  aggregate,
  cap,
  count,
  dedupe,
  fold,
  hasLabel,
  limit,
  max,
  mean,
  min,
  order,
  sum,
  toArray,
  traversal,
  V,
  values,
} from '../index.js';
import { scanValuesResidual } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * ⚠️ `n` IS SPARSE AND UNSORTED AND REPEATS. `v3` has no `n` at all, so `values('n')` DROPS it —
   * which `count` must follow. The values arrive as [0, 2, 4, 3, 0]: not sorted, with a repeat, so
   * `order()` and `dedupe()` both produce sequences that arrival order alone cannot.
   *
   * ⚠️ EVERY VERTEX CARRIES THE SAME LABEL, which is what makes the `hasLabel` oracle below the same
   * question rather than a smaller one.
   */
  for (let i = 0; i < 6; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: i === 3 ? {} : { n: (i * 7) % 5 },
    });
  }

  return g;
};

const rows = (t: ReturnType<typeof traversal>, g: Graph): unknown[] => toArray(t, g);

describe('the fused residuals, each against a hand-computed answer', () => {
  const g = build();

  test('the unsorted scan is [0, 2, 4, 3, 0] — five values from six vertices', () => {
    // ⚠️ THE PREMISE OF EVERY ASSERTION BELOW. `v3` has no `n`, so `values('n')` emits five.
    expect(rows(traversal(V(), values('n')), g)).toEqual([0, 2, 4, 3, 0]);
  });

  test('order, and order with a limit', () => {
    expect(rows(traversal(V(), values('n'), order()), g)).toEqual([0, 0, 2, 3, 4]);
    expect(rows(traversal(V(), values('n'), order(), limit(2)), g)).toEqual([0, 0]);
  });

  test('count follows the DROP', () => {
    // Five, not six — the vertex without `n` never reaches the count.
    expect(rows(traversal(V(), values('n'), count()), g)).toEqual([5]);
  });

  test('fold and aggregate().cap() keep ARRIVAL order, not sorted order', () => {
    expect(rows(traversal(V(), values('n'), fold()), g)).toEqual([[0, 2, 4, 3, 0]]);
    expect(rows(traversal(V(), values('n'), aggregate('x'), cap('x')), g)).toEqual([
      [0, 2, 4, 3, 0],
    ]);
  });

  test('min and max', () => {
    expect(rows(traversal(V(), values('n'), min()), g)).toEqual([0]);
    expect(rows(traversal(V(), values('n'), max()), g)).toEqual([4]);
  });

  test('sum and mean are REFUSED and still correct', () => {
    // 0 + 2 + 4 + 3 + 0 = 9 over five values. Refused for byte-identity, not for difficulty.
    expect(rows(traversal(V(), values('n'), sum()), g)).toEqual([9]);
    expect(rows(traversal(V(), values('n'), mean()), g)).toEqual([1.8]);
  });

  test('dedupe keeps its own narrower rung, and composes after order', () => {
    expect(rows(traversal(V(), values('n'), dedupe()), g)).toEqual([0, 2, 4, 3]);
    expect(rows(traversal(V(), values('n'), order(), dedupe()), g)).toEqual([0, 2, 3, 4]);
  });
});

describe('the general route is the ORACLE', () => {
  const g = build();

  test('every residual matches its label-spelled twin, element for element', () => {
    /*
     * 🔑 `hasLabel` IS REFUSED BY THE SCAN RUNG OUTRIGHT (item 1870), so `V().hasLabel('P')…` is the
     * same question on the general route — and every vertex here carries `P`, so it is the same
     * ROWS too. That makes it an oracle rather than the fast path blessing itself.
     */
    for (const make of [
      (l: boolean) =>
        l
          ? traversal(V(), hasLabel('P'), values('n'), order())
          : traversal(V(), values('n'), order()),
      (l: boolean) =>
        l
          ? traversal(V(), hasLabel('P'), values('n'), count())
          : traversal(V(), values('n'), count()),
      (l: boolean) =>
        l
          ? traversal(V(), hasLabel('P'), values('n'), fold())
          : traversal(V(), values('n'), fold()),
      (l: boolean) =>
        l ? traversal(V(), hasLabel('P'), values('n'), min()) : traversal(V(), values('n'), min()),
      (l: boolean) =>
        l ? traversal(V(), hasLabel('P'), values('n'), max()) : traversal(V(), values('n'), max()),
      (l: boolean) =>
        l
          ? traversal(V(), hasLabel('P'), values('n'), order(), limit(3))
          : traversal(V(), values('n'), order(), limit(3)),
    ]) {
      const fast = rows(make(false), g);
      const general = rows(make(true), g);

      // ⚠️ A NON-EMPTY RESULT FIRST: two empty arrays agree trivially.
      expect(fast.length).toBeGreaterThan(0);
      expect(fast).toEqual(general);
    }
  });

  test('an empty graph answers the same on both routes', () => {
    const empty = new Graph();

    expect(rows(traversal(V(), values('n'), order()), empty)).toEqual([]);
    // A reducing terminal still emits one row over an empty stream.
    expect(rows(traversal(V(), values('n'), count()), empty)).toEqual([0]);
    expect(rows(traversal(V(), values('n'), fold()), empty)).toEqual([[]]);
  });
});

describe('scanValuesResidual: the gate itself', () => {
  /*
   * ⚠️⚠️ **THE ROUTE CHOICE IS ANSWER-EQUIVALENT — the pipeline returns the same rows — so nothing
   * above can see the residual path being declined.** [[perf-gate-needs-its-own-test]]. The gate is
   * exported for exactly this.
   */
  const g = build();
  const routed = (t: ReturnType<typeof traversal>): boolean =>
    scanValuesResidual(t, g) !== undefined;

  test('TAKES a two-step scan prefix with something after it', () => {
    expect(routed(traversal(V(), values('n'), order()))).toBe(true);
    expect(routed(traversal(V(), values('n'), count()))).toBe(true);
    expect(routed(traversal(V(), values('n'), order(), limit(2)))).toBe(true);
  });

  test('the RESIDUAL it reports is exactly the steps after `values(k)`', () => {
    /*
     * ⚠️⚠️ **ASSERTING "IT RETURNED SOMETHING" IS NOT ENOUGH, AND THREE MUTANTS PROVED IT.** A wrong
     * `rest` — empty, off by one, or the whole plan — still returns a non-`undefined` object, so a
     * `routed(...) === true` check passes; `fusedProjectedResidual` then finds no case it recognises,
     * declines, and the plan quietly falls through to the pipeline with the SAME ANSWER. Two of
     * those mutants survived this file AND the entire @lenke/gremlin suite. The residual's CONTENTS
     * are the only observable thing.
     */
    const one = scanValuesResidual(traversal(V(), values('n'), order()), g);

    expect(one?.rest.map((st) => st.kind)).toEqual(['order']);

    const two = scanValuesResidual(traversal(V(), values('n'), order(), limit(2)), g);

    // ⚠️ `limit(n)` COMPILES TO A `take` STEP, which is what the residual actually carries.
    expect(two?.rest.map((st) => st.kind)).toEqual(['order', 'take']);

    const three = scanValuesResidual(traversal(V(), values('n'), count()), g);

    expect(three?.rest.map((st) => st.kind)).toEqual(['count']);
  });

  test('DECLINES a plan with NO residual — the rung above owns that shape', () => {
    /*
     * ⚠️ IF THIS RETURNED A WALK, IT WOULD SHADOW `nodeValuesShortcut` for its own headline shape.
     * The guard is a length check, which is the kind of thing a mutant flips silently.
     */
    expect(routed(traversal(V(), values('n')))).toBe(false);
  });

  test('DECLINES a leading hasLabel, which the scan rung refuses for its own reasons', () => {
    // Item 1870: a full scan loses to `seedFromIndex` for every selective label, up to 678x. The
    // refusal lives in `nodeValuesShortcut`, and this must inherit it rather than route around it.
    expect(routed(traversal(V(), hasLabel('P'), values('n'), order()))).toBe(false);
  });

  test('DECLINES a narrowed source and a multi-key values', () => {
    expect(routed(traversal(V('v1'), values('n'), order()))).toBe(false);
    expect(routed(traversal(V(), values('n', 'other'), order()))).toBe(false);
    expect(routed(traversal(V(), values(), order()))).toBe(false);
  });
});
