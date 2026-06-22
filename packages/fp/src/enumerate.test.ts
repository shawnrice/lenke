import { describe, expect, test } from 'bun:test';

import { enumerate } from './enumerate.js';

describe('enumerate', () => {
  test('pairs each element with its index', () => {
    expect(Array.from(enumerate(['a', 'b', 'c']))).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  test('an empty iterable yields nothing', () => {
    expect(Array.from(enumerate([]))).toEqual([]);
  });

  test('works on a non-array iterable', () => {
    expect(Array.from(enumerate(new Set(['x', 'y'])))).toEqual([
      [0, 'x'],
      [1, 'y'],
    ]);
  });
});
