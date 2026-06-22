import { describe, expect, test } from 'bun:test';

import { toArray } from './toArray.js';

describe('toArray', () => {
  test('materializes an arbitrary iterable into an array', () => {
    expect(toArray(new Set([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test('an empty iterable becomes an empty array', () => {
    expect(toArray([])).toEqual([]);
  });

  test('drains a non-array iterator (Map values)', () => {
    const m = new Map([
      ['a', 1],
      ['b', 2],
    ]);

    expect(toArray(m.values())).toEqual([1, 2]);
  });
});
