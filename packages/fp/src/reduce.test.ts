import { describe, expect, test } from 'bun:test';

import { reduce } from './reduce.js';

describe('reduce', () => {
  test('folds with the seed', () => {
    expect(reduce((acc: number, x: number) => acc + x, 0, [1, 2, 3, 4])).toBe(10);
  });

  test('returns the seed unchanged for an empty iterable', () => {
    expect(reduce((acc: number, x: number) => acc + x, 42, [])).toBe(42);
  });

  test('can change the accumulator type', () => {
    expect(reduce((acc: string, x: number) => acc + x, '', [1, 2, 3])).toBe('123');
  });

  test('curried form', () => {
    const sum = reduce((acc: number, x: number) => acc + x, 0);

    expect(sum([5, 5, 5])).toBe(15);
  });
});
