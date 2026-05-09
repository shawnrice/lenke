import { describe, expect, test } from 'bun:test';

import { before } from './before.js';

describe('functional iterator tests', () => {
  test('before works', () => {
    const isFive = (x: number) => x === 5;
    expect(Array.from(before(isFive, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toEqual([1, 2, 3, 4]);
  });
});
