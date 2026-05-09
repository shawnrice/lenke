import { describe, expect, test } from 'bun:test';

import { reject } from './reject.js';

describe('functional iterator tests', () => {
  test('reject works', () => {
    const isOdd = (x: number) => Boolean(x % 2);
    expect(Array.from(reject(isOdd, [1, 2, 3, 4, 5]))).toEqual([2, 4]);
  });
});
