import { describe, expect, test } from 'bun:test';

import { filter } from './filter.js';

describe('functional iterator tests', () => {
  test('filter works', () => {
    const isOdd = (x: number) => Boolean(x % 2);
    expect(Array.from(filter(isOdd, [1, 2, 3, 4, 5]))).toEqual([1, 3, 5]);
  });
});
