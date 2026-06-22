import { describe, expect, test } from 'bun:test';

import { flatten } from './flatten.js';

describe('flatten', () => {
  test('concatenates the inner iterables', () => {
    expect(Array.from(flatten([[1, 2], [3], [4, 5]]))).toEqual([1, 2, 3, 4, 5]);
  });

  test('flattens only one level deep', () => {
    expect(Array.from(flatten<number[]>([[[1, 2]], [[3]]]))).toEqual([[1, 2], [3]]);
  });

  test('skips empty inner iterables', () => {
    expect(Array.from(flatten([[], [1], []]))).toEqual([1]);
  });

  test('curried form', () => {
    const flat = flatten<number>();

    expect(Array.from(flat([[1], [2, 3]]))).toEqual([1, 2, 3]);
  });
});
