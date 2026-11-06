import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  choose,
  fail,
  has,
  limit,
  order,
  out,
  pipe,
  toArray,
  traversal,
  values,
} from './index.js';

/**
 * ⚠️ THE TWO-PHASE ORDER OF `sortByBys`, WHICH ITEM 890 RECORDED AS GUARDED BY CONSTRUCTION ONLY.
 *
 * Its own comment states the invariant — *"every key is evaluated BEFORE the element check, so an
 * `evalBy` that throws still wins over the element fault"* — and item 890's method note says in so
 * many words that the phase order "is guarded by construction only, by no test". That was true
 * until this file.
 *
 * It matters because the structure it constrains is exactly what a streaming top-k would change
 * (item 1575 prices that at ~1.54x). A per-item loop that checked each key for elements as it went
 * would surface the ELEMENT error where the engine currently surfaces the `by` throw — a different
 * exception from the same query, which the cross-engine differential compares.
 *
 * Constructing it took finding a `by` that can THROW: `by(pipe(fail(...)))`. `order().by(fn)` with a
 * raw function is not a supported form (it is read as a plan), which is why this went untested.
 */
const mixed = (): Graph => {
  const graph = new Graph();
  // `a` HAS `flag`, so its `by` yields `out('E')` — a VERTEX, i.e. an element key.
  // `b` lacks it, so its `by` FAILS. `a` arrives first, so the element is seen before the throw.
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 0, flag: 1 } });
  const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });

  graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });

  return graph;
};

/** A `by` that yields an ELEMENT for flagged items and THROWS for the rest. */
const elementOrThrow = (): ReturnType<typeof pipe> =>
  pipe(choose(has('flag'), pipe(out('E')), pipe(fail('BY-BOOM'))));

describe('an evalBy throw wins over the element fault', () => {
  test('the THROW surfaces, not the element error, even though the element is seen FIRST', () => {
    expect(() => toArray(traversal(V(), order().by(elementOrThrow())), mixed())).toThrow('BY-BOOM');
  });

  test('with no throwing item, the element error surfaces', () => {
    // The control: the same element key, nothing to throw. Without this the test above would pass
    // for a build that never raised the element error at all.
    expect(() => toArray(traversal(V(), order().by(pipe(out('E')))), mixed())).toThrow(
      'order() over graph elements is not supported',
    );
  });

  test('⚠️ and the precedence holds under a CAP, where only one item would be kept', () => {
    // Item 1574's top-k must not let the cap decide which fault wins: both items' keys are still
    // evaluated, so the throw still beats the element even when the heap would fill after one.
    expect(() => toArray(traversal(V(), order().by(elementOrThrow()), limit(1)), mixed())).toThrow(
      'BY-BOOM',
    );
  });

  test('⚠️ a cap of ZERO still drains and still faults — via a BY, not a bare order()', () => {
    // ⚠️ THIS TEST FIRST PASSED FOR THE WRONG REASON. Written as `order().limit(0)` it caught a
    // PARSE-TIME rejection (`checkStep` refuses a pure-element `order()`), not the runtime drain —
    // so the `early-zero-cap` mutant survived it. The runtime element check is only reachable when
    // a `by` YIELDS an element, which is what this uses.
    //
    // Item 1576's streaming path must not early-return on `cap <= 0`: `order().limit(0)` evaluates
    // every key today, so an early return silently stops raising, and returning `[]` for a query
    // that should fault is invisible to any answer test over a non-faulting graph. The `cap > 0`
    // guard therefore sits on the HEAP ACCESS, not on the loop.
    expect(() => toArray(traversal(V(), order().by(pipe(out('E'))), limit(0)), mixed())).toThrow(
      'order() over graph elements is not supported',
    );
  });

  test('a bare order() over elements is rejected BEFORE execution, which is a different check', () => {
    // Pinned so the two are not confused again: this one never reaches `streamTopByBys`.
    expect(() => toArray(traversal(V(), order(), limit(0)), mixed())).toThrow(
      'order() over graph elements is not supported',
    );
  });

  test('a NO_VALUE key is filtered out of the ordering under a cap', () => {
    // TinkerPop: a `by()` that yields no value drops the item from the ordering entirely. Under a
    // cap that is easy to lose — keeping NO_VALUE items would let them occupy heap slots and
    // appear in the result. `b` has no `flag`, so `by('flag')` yields NO_VALUE for it.
    const rows = toArray(traversal(V(), order().by('flag'), limit(5), values('n')), mixed());

    expect(rows).toEqual([0]);
  });

  test('a cap of zero over ordinary values still returns empty', () => {
    // The control for the test above: `limit(0)` must stay empty where there is nothing to fault,
    // so the drain is not an excuse to return rows.
    expect(toArray(traversal(V(), values('n'), order(), limit(0)), mixed())).toEqual([]);
  });

  test('the element error also still raises under a cap', () => {
    expect(() => toArray(traversal(V(), order().by(pipe(out('E'))), limit(1)), mixed())).toThrow(
      'order() over graph elements is not supported',
    );
  });
});
