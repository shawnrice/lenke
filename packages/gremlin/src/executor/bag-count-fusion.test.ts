/*
 * Item 2069 — `aggregate(k).count()` / `store(k).count()` over a fused walk.
 *
 * ⚠️⚠️ **ITEM 1909 REFUSED THE PASS-THROUGH FORM ON A CONTRACT ARGUMENT, so these tests are the
 * evidence for reaching past it** — the same standing `projected-fold.test.ts` holds for the `cap`
 * pair at item 1911. The argument, quoted from `index.ts`: "a side effect that also PASSES THE STREAM
 * THROUGH is a different emit contract from a barrier that replaces it, and `aggregate` and `store`
 * differ from each other on eagerness in TinkerPop."
 *
 * 🔑 **BOTH HALVES ARE TRUE AND NEITHER IS OBSERVABLE UNDER `count`, because `count` is a
 * NON-CANCELLING FULL CONSUMER.** The declines below are where it becomes observable again, and they
 * are why the gate is `rest.length === 2` with a global `count` and not "a side effect somewhere".
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  aggregate,
  cap,
  count,
  limit,
  out,
  store,
  toArray,
  traversal,
  V,
  values,
} from '../index.js';
import {
  barrierProjectedBag,
  countProjectedBag,
  fusableProjectedBagCount,
  fusableProjectedBarrier,
} from './aggregation.js';

const fixture = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 6; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { n: i } });
  }

  for (let i = 0; i < 5; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${i + 1}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

describe('aggregate/store + count fusion (item 2069)', () => {
  test('THE GATE: it claims a global count after either bag step', () => {
    expect(fusableProjectedBagCount([{ kind: 'aggregate', key: 'x' }, { kind: 'count' }])).toBe(
      true,
    );
    expect(fusableProjectedBagCount([{ kind: 'store', key: 'x' }, { kind: 'count' }])).toBe(true);
  });

  test('⚠️ a NON-BAG first step declines — and this test exists because a mutant survived', () => {
    /*
     * ⚠️⚠️ REMOVING THE `aggregate`/`store` CHECK FROM THE GATE CHANGED NO ANSWER, because the call
     * site in `index.ts` independently narrows (`bag.kind === 'aggregate' || bag.kind === 'store'`)
     * before reading `bag.key`. That is defence in depth and worth keeping — but it meant the GATE's
     * own contract had no test, so the mutant survived. Asserted directly here.
     */
    expect(fusableProjectedBagCount([{ kind: 'dedupe' }, { kind: 'count' }] as never)).toBe(false);
    expect(
      fusableProjectedBagCount([{ kind: 'subgraph', key: 'x' }, { kind: 'count' }] as never),
    ).toBe(false);
  });

  test('⚠️ `count(local)` DECLINES — it counts WITHIN each element, not the stream', () => {
    /*
     * ⚠️ A local count is a different question entirely: it must not reach a drain of the whole walk.
     * Asserted because the gate reads a `scope` field that most `count` steps do not carry, so a
     * careless widening would admit it silently.
     */
    expect(
      fusableProjectedBagCount([
        { kind: 'aggregate', key: 'x' },
        { kind: 'count', scope: 'local' },
      ] as never),
    ).toBe(false);
  });

  test('a THIRD residual step declines — where eagerness becomes observable again', () => {
    expect(
      fusableProjectedBagCount([
        { kind: 'aggregate', key: 'x' },
        { kind: 'limit', n: 0 },
        { kind: 'count' },
      ] as never),
    ).toBe(false);
  });

  test('`cap` is not admitted here, so the two arms are disjoint by their second step', () => {
    expect(
      fusableProjectedBagCount([
        { kind: 'aggregate', key: 'x' },
        { kind: 'cap', key: 'x' },
      ]),
    ).toBe(false);
  });

  test('the ANSWER matches the generic path, for both bag steps', () => {
    const g = fixture();

    // Five edges, so five elements counted either way.
    expect(toArray(traversal(V(), out('E'), aggregate('x'), count()), g)).toStrictEqual([5]);
    expect(toArray(traversal(V(), out('E'), store('y'), count()), g)).toStrictEqual([5]);
  });

  test('⚠️⚠️ THE BAG IS STILL POPULATED, and with the SAME CONTENTS the generic path produces', () => {
    /*
     * ⚠️⚠️ **THIS IS THE ASSERTION THE FUSION COULD MOST EASILY HAVE CHEATED.** Nothing in
     * `aggregate(x).count()` reads the bag, so a fusion that skipped filling it would answer 5 and
     * pass every test above — and `ast.ts` exposes `sideEffects` to expression evaluation, so a bag is
     * observable in general. Reading it back through a `cap` in a SEPARATE query cannot see this
     * run's bag, so the check is made where it is visible: a three-step residual
     * (`aggregate, count, cap`) declines the fusion and takes the generic path, which gives the
     * reference contents — and the fused two-step form must fill the bag the same way.
     *
     * ⚠️ AND THE FUSED FORM'S OWN BAG IS ASSERTED IN THE NEXT TEST, by calling `countProjectedBag`
     * directly — from outside the engine the two-step form's bag has no reader, so a unit test of the
     * function is the only place it is visible at all.
     */
    const g = fixture();
    const viaGeneric = toArray(traversal(V(), out('E'), aggregate('x'), count(), cap('x')), g);

    // The generic path's bag: five edge heads, in walk order.
    expect(viaGeneric).toHaveLength(1);
    expect((viaGeneric[0] as unknown[]).length).toBe(5);
  });

  test('⚠️⚠️ `countProjectedBag` FILLS THE BAG — the one assertion a cheating fusion would pass without', () => {
    /*
     * ⚠️⚠️ **CALLED DIRECTLY, BECAUSE THE FUSED SHAPE HAS NO READER FOR ITS BAG.** `aggregate(x).count()`
     * never reads what it collected, so a fusion that returned the right number and filled nothing
     * would satisfy every other test in this file. `ast.ts` exposes `sideEffects` to expression
     * evaluation, so the bag is observable in general and skipping it is not licensed.
     *
     * Asserted: the contents, the ORDER, that an existing bucket is APPENDED to rather than replaced,
     * and that the returned value is the count.
     */
    const ctx = { sideEffects: new Map<string, unknown[]>() };
    const walk = {
      [Symbol.iterator]: () => [10, 20, 30][Symbol.iterator](),
      drain: () => [10, 20, 30],
    };

    expect(countProjectedBag(walk, 'x', ctx)).toStrictEqual([3]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([10, 20, 30]);

    // A second run APPENDS, which is what `aggregateStep` does with an existing bucket.
    expect(countProjectedBag(walk, 'x', ctx)).toStrictEqual([3]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([10, 20, 30, 10, 20, 30]);
  });

  test('⚠️ `countProjectedBag` works on a walk with NO drain, and agrees with the drained one', () => {
    /*
     * ⚠️ THE GENERAL ARM IS NOT DEAD CODE: `values.drain === undefined` falls back to spreading the
     * iterable, and a walk without a drain is reachable. Same contents, same count.
     */
    const ctx = { sideEffects: new Map<string, unknown[]>() };
    const noDrain = { [Symbol.iterator]: () => [7, 8][Symbol.iterator]() };

    expect(countProjectedBag(noDrain, 'y', ctx)).toStrictEqual([2]);
    expect(ctx.sideEffects.get('y')).toStrictEqual([7, 8]);
  });

  test('⚠️ THE EAGERNESS DISTINCTION IS UNTOUCHED — the shape where it is observable still declines', () => {
    /*
     * ⚠️⚠️ `projected-fold.test.ts` pins these two numbers, and they are the reason item 1909's
     * argument is real: `aggregate` buffers the whole upstream so a later `limit(0)` cannot cancel the
     * collection (6), while `store` is lazy and is pulled once before `limit(0)` rejects it (1). The
     * fusion must not reach either shape — and re-asserting it HERE is what catches a future widening
     * of this gate, not of that one.
     */
    const g = fixture();
    const eager = toArray(traversal(V(), out('E'), aggregate('x'), limit(0), cap('x')), g);
    const lazy = toArray(traversal(V(), out('E'), store('y'), limit(0), cap('y')), g);

    expect((eager[0] as unknown[]).length).toBe(5);
    expect((lazy[0] as unknown[]).length).toBe(1);
    expect((eager[0] as unknown[]).length).not.toBe((lazy[0] as unknown[]).length);
  });

  test('a values projection before the bag still counts correctly', () => {
    const g = fixture();

    expect(
      toArray(traversal(V(), out('E'), values('n'), aggregate('x'), count()), g),
    ).toStrictEqual([5]);
  });

  test('running the same plan TWICE gives the same answer — the bag is per-run', () => {
    /*
     * ⚠️ A key set or bag shared across two executions of one compiled plan would make the second run
     * differ. `projected-fold.test.ts` uses the same `twice` guard for the `cap` pair.
     */
    const g = fixture();
    const make = (): ReturnType<typeof traversal> =>
      traversal(V(), out('E'), aggregate('x'), count());

    expect(toArray(make(), g)).toStrictEqual(toArray(make(), g));
  });
});

describe('a bare trailing aggregate barrier (item 2070)', () => {
  test('THE GATE: `aggregate` alone is claimed, `store` alone is NOT', () => {
    /*
     * ⚠️⚠️ **THE ASYMMETRY IS THE CONTRACT, and it is the opposite shape from item 2069's.** There,
     * `count()` consumed the stream so eager and lazy were indistinguishable and BOTH bag steps were
     * admitted. Here the residual is the LAST step, so the stream passes through to a caller who may
     * stop early: `aggregate` already materializes its upstream (a drain changes nothing), while
     * `store` is lazy and a drain would collect what an early-exiting caller must never have caused
     * to be collected.
     */
    expect(fusableProjectedBarrier([{ kind: 'aggregate', key: 'x' }])).toBe(true);
    /*
     * ⚠️⚠️ **THIS ASSERTED `false` UNTIL ITEM 2112, AND THE REASON ABOVE IS WHY IT COULD.** The gate now
     * admits `store` too — but it takes a DIFFERENT ARM (`barrierProjectedStore`), lazy as an iterator
     * and eager only via `drain`, so an early-exiting caller still bags only what it pulled. The
     * comment above describes `barrierProjectedBag`, which `store` is still refused from.
     *
     * 🔑 The invariant that replaced it is BEHAVIOURAL and lives in `store-lazy-barrier.test.ts`: four
     * consumption patterns through the public API, including the part-way iteration this refusal existed
     * to protect. A gate boolean cannot express that, which is why the stronger test is elsewhere.
     */
    expect(fusableProjectedBarrier([{ kind: 'store', key: 'x' }])).toBe(true);
  });

  test('a TWO-step residual declines — that is item 2069s arm, and the two must stay disjoint', () => {
    expect(fusableProjectedBarrier([{ kind: 'aggregate', key: 'x' }, { kind: 'count' }])).toBe(
      false,
    );
    expect(fusableProjectedBarrier([])).toBe(false);
  });

  test('the barrier PASSES THE STREAM THROUGH and fills the bag with the projected values', () => {
    /*
     * 🔑 IT RETURNS THE ROWS, NOT A COUNT — that is what distinguishes this from
     * `countProjectedBag`. The bag holds the VALUES here, because the `aggregate` sits AFTER the
     * projection; a fusion that banked the elements instead would be a different answer.
     */
    const ctx = { sideEffects: new Map<string, unknown[]>() };
    const walk = { [Symbol.iterator]: () => [1, 2, 3][Symbol.iterator](), drain: () => [1, 2, 3] };

    expect(barrierProjectedBag(walk, 'x', ctx)).toStrictEqual([1, 2, 3]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([1, 2, 3]);
  });

  test('it APPENDS to an existing bucket, as `aggregateStep` does', () => {
    const ctx = { sideEffects: new Map<string, unknown[]>([['x', [9]]]) };
    const walk = { [Symbol.iterator]: () => [1][Symbol.iterator](), drain: () => [1] };

    expect(barrierProjectedBag(walk, 'x', ctx)).toStrictEqual([1]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([9, 1]);
  });

  test('the END-TO-END answer and bag match the generic path', () => {
    const g = fixture();

    // Five edges projected, and the bag read back through a cap on the generic (3-step) path.
    expect(toArray(traversal(V(), out('E'), values('n'), aggregate('x')), g)).toStrictEqual([
      1, 2, 3, 4, 5,
    ]);

    const capped = toArray(traversal(V(), out('E'), values('n'), aggregate('x'), cap('x')), g);

    expect(capped).toHaveLength(1);
    expect(capped[0]).toStrictEqual([1, 2, 3, 4, 5]);
  });

  test('⚠️⚠️ `store` STILL PASSES THROUGH LAZILY — the behaviour the decline protects', () => {
    /*
     * ⚠️⚠️ **THIS IS WHY `store` IS REFUSED, stated as a measurement rather than an intention.** With
     * a `limit(0)` after it, the lazy `store` is pulled once and then rejected, so its bag holds ONE
     * element; the eager `aggregate` collected the whole upstream first and holds five. If the fusion
     * ever admitted `store`, this test fails — which is the point of asserting it here as well as in
     * `projected-fold.test.ts`.
     */
    const g = fixture();
    const lazy = toArray(traversal(V(), out('E'), values('n'), store('y'), limit(0), cap('y')), g);
    const eager = toArray(
      traversal(V(), out('E'), values('n'), aggregate('x'), limit(0), cap('x')),
      g,
    );

    expect((lazy[0] as unknown[]).length).toBe(1);
    expect((eager[0] as unknown[]).length).toBe(5);
  });

  test('the store row still ANSWERS correctly on the generic path', () => {
    const g = fixture();

    expect(toArray(traversal(V(), out('E'), values('n'), store('y')), g)).toStrictEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});
