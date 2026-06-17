import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { as_, out, V, hasId, inject, math, values } from '../steps.js';
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

  // doc: g.V().as('a').out('knows').as('b').math('a + b').by('age')
  test('math: resolves as_-bound names projected by by()', () => {
    // marko(29) —knows→ vadas(27) and josh(32): 29+27=56, 29+32=61.
    const r = arr(
      run(traversal(V(), as_('a'), out('KNOWS'), as_('b'), math('a + b').by('age')), g),
    );
    expect((r as number[]).sort((x, y) => x - y)).toEqual([56, 61]);
  });

  test('math: a single by() cycles across all named operands', () => {
    // a (marko, 29); same `by('age')` applies to a and b.
    const r = arr(
      run(traversal(V(), hasId('1'), as_('a'), out('KNOWS'), as_('b'), math('b - a').by('age')), g),
    );
    // josh 32-29=3, vadas 27-29=-2.
    expect((r as number[]).sort((x, y) => x - y)).toEqual([-2, 3]);
  });

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
