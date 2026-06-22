import { describe, expect, test } from 'bun:test';

import { takeLast } from './takeLast.js';

describe('takeLast', () => {
  test('takes the last N elements', () => {
    expect(Array.from(takeLast(2, [1, 2, 3, 4]))).toEqual([3, 4]);
  });

  test('a count of 0 or less yields nothing', () => {
    expect(Array.from(takeLast(0, [1, 2, 3]))).toEqual([]);
  });

  test('a count >= length yields everything', () => {
    expect(Array.from(takeLast(9, [1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test('curried form', () => {
    const lastTwo = takeLast<number>(2);

    expect(Array.from(lastTwo([1, 2, 3, 4]))).toEqual([3, 4]);
  });
});
