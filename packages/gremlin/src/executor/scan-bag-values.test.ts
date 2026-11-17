/*
 * Item 2078 — `V().aggregate(k).values(key)`, the barrier BEFORE the projection.
 *
 * ⚠️⚠️ **THE BAG IS NOT THE ROW SET, AND THAT IS THE ONE THING THIS FUSION COULD GET WRONG.** The
 * `aggregate` runs before `values`, so it banks EVERY vertex — including those `values` then drops for
 * lacking the key. A fusion that bagged only the emitted rows would answer correctly and lose exactly
 * those vertices, which no row-count test could see.
 *
 * ⚠️ This is the mirror of item 2070, where the barrier sat AFTER the projection and banked the
 * already-projected VALUES. Same step kinds, opposite order, different bag contents.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { aggregate, cap, limit, order, store, toArray, traversal, V, values } from '../index.js';
import { scanBagValuesShortcut } from './node-values.js';

const ctxOf = (): { sideEffects: Map<string, unknown[]>; tracksPath: boolean } => ({
  sideEffects: new Map(),
  tracksPath: false,
});

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 10 } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { n: 20 } });
  /*
   * ⚠️ `c` IS THE WHOLE POINT: no `n`, so `values('n')` drops it — but `aggregate` ran FIRST, so the
   * bag must hold it. Two rows out, three vertices banked.
   */
  g.addVertex({ id: 'c', labels: ['T'], properties: { other: 1 } });

  return g;
};

describe('scan-bag values fusion (item 2078)', () => {
  const g = build();

  test('THE ROUTE: the rung claims the three-step shape', () => {
    expect(
      scanBagValuesShortcut(traversal(V(), aggregate('x'), values('n')), g, ctxOf() as never),
    ).toBeDefined();
  });

  test('⚠️⚠️ THE BAG HOLDS EVERY VERTEX, including the one with no projected key', () => {
    const ctx = ctxOf();
    const claimed = scanBagValuesShortcut(
      traversal(V(), aggregate('x'), values('n')),
      g,
      ctx as never,
    );

    expect(claimed).toBeDefined();

    const rows = claimed!.drain!();

    // TWO rows — `c` is dropped by `values('n')` …
    expect(rows).toStrictEqual([10, 20]);
    // … and THREE vertices banked, because `aggregate` ran before the projection could drop it.
    expect(ctx.sideEffects.get('x')).toHaveLength(3);
    expect((ctx.sideEffects.get('x') as { id: string }[]).map((v) => v.id)).toStrictEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('the ITERATOR and `drain` agree, and both fill the bag the same way', () => {
    const ctxA = ctxOf();
    const ctxB = ctxOf();
    const viaIter = [
      ...scanBagValuesShortcut(traversal(V(), aggregate('x'), values('n')), g, ctxA as never)!,
    ];
    const viaDrain = scanBagValuesShortcut(
      traversal(V(), aggregate('x'), values('n')),
      g,
      ctxB as never,
    )!.drain!();

    expect(viaIter).toStrictEqual(viaDrain);
    expect(ctxA.sideEffects.get('x')).toStrictEqual(ctxB.sideEffects.get('x'));
  });

  test('⚠️⚠️ `store` IS ADMITTED SINCE ITEM 2113 — and its laziness is PRESERVED, not traded away', () => {
    /*
     * ⚠️⚠️ **THIS ASSERTED `toBeUndefined()` UNTIL ITEM 2113.** The reasoning below was item 2070's and it
     * is about a DRAINED result (`barrierProjectedBag` returns the drained array, so every consumer gets
     * an eager one). 🔑 `scanBagValuesWalk` is a GENERATOR: it banks a vertex and yields it, so a caller
     * that `break`s out stops the walk and only the pulled vertices are banked. It was already exactly as
     * lazy as `store` requires.
     *
     * ⚠️ WHAT DID HAVE TO CHANGE is the RESULT, not the walk. `[Symbol.iterator]` was a FACTORY and
     * `drain` built another generator, so iterate-part-way-then-drain banked the prefix TWICE — item
     * 2098's demonstrated doubling. `store` now gets a SINGLE-PASS result over one shared generator.
     *
     * 🔑 The laziness this test was named for is asserted behaviourally in `scan-bag-store.test.ts`,
     * across all four consumption patterns; a `toBeUndefined()` could never have expressed it.
     */
    expect(
      scanBagValuesShortcut(traversal(V(), store('x'), values('n')), g, ctxOf() as never),
    ).not.toBeUndefined();
  });

  test('the END-TO-END answer matches, and the eager/lazy split is intact', () => {
    const fresh = build();

    expect(toArray(traversal(V(), aggregate('x'), values('n')), fresh)).toStrictEqual([10, 20]);
    expect(toArray(traversal(V(), store('y'), values('n')), fresh)).toStrictEqual([10, 20]);

    // ⚠️ The bag read back through a `cap`, which is four steps and so declines this fusion: the
    // GENERIC path's bag is the reference, and it holds all three vertices too.
    const capped = toArray(traversal(V(), aggregate('x'), values('n'), cap('x')), fresh);

    expect((capped[0] as unknown[]).length).toBe(3);
  });

  test('a FOUR-step plan declines — a residual would see a different element type', () => {
    expect(
      scanBagValuesShortcut(
        traversal(V(), aggregate('x'), values('n'), order()),
        g,
        ctxOf() as never,
      ),
    ).toBeUndefined();
    expect(toArray(traversal(V(), aggregate('x'), values('n'), order()), g)).toStrictEqual([
      10, 20,
    ]);
  });

  test('V(ids) declines — a given set is not the whole graph', () => {
    expect(
      scanBagValuesShortcut(traversal(V('a'), aggregate('x'), values('n')), g, ctxOf() as never),
    ).toBeUndefined();
    expect(toArray(traversal(V('a'), aggregate('x'), values('n')), g)).toStrictEqual([10]);
  });

  test('a MULTI-KEY projection declines — values(a, b) fans out per key', () => {
    expect(
      scanBagValuesShortcut(
        traversal(V(), aggregate('x'), values('n', 'other')),
        g,
        ctxOf() as never,
      ),
    ).toBeUndefined();
  });

  test('⚠️ a `limit(0)` after the barrier still collects — the contract the refusal protects', () => {
    /*
     * ⚠️ FOUR STEPS, so the fusion declines and this is the GENERIC path — asserted here anyway,
     * because it is the behaviour that makes `aggregate` safe to drain and `store` not. The eager
     * barrier banked the graph before `limit(0)` could cancel it.
     */
    const fresh = build();
    const eager = toArray(traversal(V(), aggregate('x'), limit(0), cap('x')), fresh);

    expect((eager[0] as unknown[]).length).toBe(3);
  });
});
