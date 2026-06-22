import { describe, expect, test } from 'bun:test';

import { zip } from './zip.js';

describe('zip', () => {
  test('pairs elements position-wise', () => {
    expect(Array.from(zip([1, 2, 3], ['a', 'b', 'c']))).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });

  test('stops at the shorter input', () => {
    expect(Array.from(zip([1, 2, 3], ['a']))).toEqual([[1, 'a']]);
  });

  test('yields nothing when either input is empty', () => {
    expect(Array.from(zip([], [1, 2]))).toEqual([]);
    expect(Array.from(zip([1, 2], []))).toEqual([]);
  });
});
