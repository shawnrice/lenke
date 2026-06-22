import { describe, expect, test } from 'bun:test';

import { takeWhile } from './takeWhile.js';

describe('takeWhile', () => {
  test('takes elements until the predicate first fails', () => {
    expect(Array.from(takeWhile((x: number) => x < 3, [1, 2, 3, 4, 1]))).toEqual([1, 2]);
  });

  test('does not resume after the predicate fails', () => {
    expect(Array.from(takeWhile((x: number) => x % 2 === 1, [1, 3, 2, 5]))).toEqual([1, 3]);
  });

  test('yields nothing when the first element fails', () => {
    expect(Array.from(takeWhile((x: number) => x > 9, [1, 2]))).toEqual([]);
  });

  test('curried form', () => {
    const whileSmall = takeWhile<number>((x) => x < 2);

    expect(Array.from(whileSmall([1, 1, 2, 1]))).toEqual([1, 1]);
  });
});
