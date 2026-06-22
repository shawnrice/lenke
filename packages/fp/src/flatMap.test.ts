import { describe, expect, test } from 'bun:test';

import { flatMap } from './flatMap.js';

describe('flatMap', () => {
  test('maps each element to an iterable and concatenates', () => {
    expect(Array.from(flatMap((n: number) => [n, n * 10], [1, 2]))).toEqual([1, 10, 2, 20]);
  });

  test('an empty mapped iterable drops the element', () => {
    expect(Array.from(flatMap((n: number) => (n % 2 === 0 ? [n] : []), [1, 2, 3, 4]))).toEqual([
      2, 4,
    ]);
  });

  test('curried form', () => {
    const chars = flatMap((s: string) => s.split(''));

    expect(Array.from(chars(['ab', 'c']))).toEqual(['a', 'b', 'c']);
  });
});
