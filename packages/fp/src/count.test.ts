import { describe, expect, test } from 'bun:test';

import { count } from './count.js';

describe('functional iterator tests', () => {
  test('count works with an array', () => {
    expect(count([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });

  test('count works with a set', () => {
    expect(count(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(10);
  });

  test('count works with an iterable', () => {
    const generator = function* () {
      let x = 0;
      while (x++ < 500) {
        yield x;
      }
    };
    expect(count(generator())).toBe(500);
  });
});
