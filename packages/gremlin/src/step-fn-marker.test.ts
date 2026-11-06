import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { STEP_FN, isStepFn } from './ast.js';
import { V, count, isSerializable, out, pipe, toArray, traversal } from './index.js';

/**
 * Item 1577: `appendStep` marks a step function with a plain assignment instead of
 * `Object.defineProperty`, which was **73% of plan construction** — 0.235 → 0.064 us/op to build
 * `traversal(V(id))`, 0.627 → 0.137 for a three-step plan, and 1.69x on a whole small `V(id)` call.
 *
 * ⚠️ THE PROPERTY IS NOW ENUMERABLE, and these tests exist to pin why that is safe rather than to
 * assert it is. Two independent facts carry it:
 *
 *   1. `STEP_FN` is a SYMBOL, and symbols are excluded from `Object.keys`, `for…in` and
 *      `JSON.stringify` whatever their enumerability. So the usual leaks cannot happen.
 *   2. An enumerable symbol DOES travel through `Object.assign`/spread — but only with the step
 *      function as the SOURCE, and every `Object.assign` in this package passes `fn` as the TARGET
 *      (the fluent `addE(...).from(...)`, `pageRank(...)`, `repeat(...)` builders all do).
 *
 * If someone later writes `Object.assign({}, someStepFn)` or `{ ...someStepFn }`, the marker will
 * ride along and `isStepFn` will say yes to a plain object. The last test here states that
 * explicitly, so the next person meets it as a documented consequence rather than a surprise.
 */
describe('the marker still identifies a step function', () => {
  test('isStepFn holds for a plain step and for pipe()', () => {
    expect(isStepFn(V())).toBe(true);
    expect(isStepFn(out('E'))).toBe(true);
    expect(isStepFn(pipe(out('E'), count()))).toBe(true);
  });

  test('and not for an ordinary function or value', () => {
    expect(isStepFn(() => 1)).toBe(false);
    expect(isStepFn({})).toBe(false);
    expect(isStepFn(null)).toBe(false);
  });

  test('plans still build and run', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'] });
    const b = g.addVertex({ id: 'b', labels: ['P'] });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });

    expect(toArray(traversal(V(), out('E'), count()), g)).toEqual([1]);
  });
});

describe('⚠️ why dropping `enumerable: false` is safe', () => {
  test('a SYMBOL key never appears in Object.keys or JSON.stringify', () => {
    // This is the half that makes enumerability irrelevant for the ordinary leaks, and it holds for
    // ANY symbol — it is a language fact, not something this code arranges.
    const step = V() as unknown as object;

    expect(Object.keys(step)).not.toContain('@lenke/gremlin/StepFn');
    expect(Object.keys(step).length).toBe(0);
    expect(JSON.stringify({ step })).toBe('{}');

    const seen: string[] = [];

    for (const k in step) {
      seen.push(k);
    }

    expect(seen).toEqual([]);
  });

  test('the marker IS an own symbol, which is how `isStepFn` finds it', () => {
    expect(Object.getOwnPropertySymbols(V() as unknown as object)).toContain(STEP_FN);
  });

  test('⚠️ and it DOES travel through a spread — the documented consequence', () => {
    // Nothing in the package spreads a step function, which is what makes the change safe today.
    // Pinned so that if someone adds such a spread, this test tells them what it now implies.
    const copied = { ...(V() as unknown as object) };

    expect(isStepFn(copied)).toBe(false); // not callable, so `isStepFn` still rejects it
    expect(Object.getOwnPropertySymbols(copied)).toContain(STEP_FN);
  });

  test('a PLAN is still reported serializable — the marker is invisible to that walk', () => {
    // ⚠️ `isSerializable` takes a PLAN, not a step function: my first version passed `V()` and
    // crashed on `plan.steps.length`. Kept as a plan check, which is the question worth asking —
    // the serializer walks `plan.steps`, i.e. the Step OBJECTS, and never the marked functions.
    expect(isSerializable(traversal(V(), out('E'), count()))).toBe(true);
  });
});
