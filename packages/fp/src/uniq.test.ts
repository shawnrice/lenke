import { describe, expect, test } from 'bun:test';

import { uniq, uniqBy } from './uniq.js';

describe('uniq', () => {
  test('removes duplicates, keeping first-seen order', () => {
    expect(Array.from(uniq([1, 2, 1, 3, 2, 4]))).toEqual([1, 2, 3, 4]);
  });

  test('dedupes by identity', () => {
    expect(Array.from(uniq(['a', 'a', 'b', 'a']))).toEqual(['a', 'b']);
  });

  test('an empty iterable yields nothing', () => {
    expect(Array.from(uniq([]))).toEqual([]);
  });
});

describe('uniqBy', () => {
  test('dedupes by a derived key, keeping the first of each', () => {
    expect(Array.from(uniqBy((s: string) => s.length, ['a', 'b', 'cc', 'dd', 'eee']))).toEqual([
      'a',
      'cc',
      'eee',
    ]);
  });
});
