import { describe, expect, test } from 'bun:test';

import { chunk } from './chunk.js';

describe('chunk', () => {
  test('splits into fixed-size groups', () => {
    expect(Array.from(chunk(2, [1, 2, 3, 4]))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('keeps a short final chunk', () => {
    expect(Array.from(chunk(2, [1, 2, 3]))).toEqual([[1, 2], [3]]);
  });

  test('a size of 0 or less yields nothing', () => {
    expect(Array.from(chunk(0, [1, 2, 3]))).toEqual([]);
    expect(Array.from(chunk(-1, [1, 2, 3]))).toEqual([]);
  });

  test('an empty iterable yields no chunks', () => {
    expect(Array.from(chunk(3, []))).toEqual([]);
  });
});
