import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasId, inject, math, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('math tests', () => {
  const g = createTestTinkerGraph();

  test('math: simple expression on injected number', () => {
    const r = arr(run(traversal(inject(10), math('_ + 5')), g));
    expect(r).toEqual([15]);
  });

  test('math: precedence and parens', () => {
    const r = arr(run(traversal(inject(2), math('(_ + 3) * 4')), g));
    expect(r).toEqual([20]);
  });

  test('math: applied to a property value', () => {
    // marko.age = 29; 29 + 100 = 129
    const r = arr(run(traversal(V(), hasId('1'), values('age'), math('_ + 100')), g));
    expect(r).toEqual([129]);
  });

  // Note: doc queries like `g.V().as('a').out('knows').as('b').math('a + b').by('age')`
  // require `as`-bound name resolution in math() — not yet implemented.

  // doc: g.V().hasId(1).values('age').math('_ / 12') — marko's age in dozens.
  test('math: division on a property value', () => {
    const r = arr(run(traversal(V(), hasId('1'), values('age'), math('_ / 10')), g));
    expect(r).toEqual([2.9]);
  });

  // doc: math with negative result.
  test('math: subtraction yields signed value', () => {
    const r = arr(run(traversal(inject(5), math('_ - 10')), g));
    expect(r).toEqual([-5]);
  });

  // doc: math chained with another math.
  test('math: chained transformations compose', () => {
    const r = arr(run(traversal(inject(2), math('_ * 3'), math('_ + 1')), g));
    expect(r).toEqual([7]);
  });
});
