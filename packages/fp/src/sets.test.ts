import { describe, expect, test } from 'bun:test';

import { difference, intersection, union } from './sets.js';

describe('union', () => {
  test('yields each distinct element from both, a first then b', () => {
    expect(Array.from(union([1, 2], [2, 3]))).toEqual([1, 2, 3]);
  });

  test('dedupes within a single input too', () => {
    expect(Array.from(union([1, 1, 2], []))).toEqual([1, 2]);
  });
});

describe('intersection', () => {
  test('yields elements of a that are also in b', () => {
    expect(Array.from(intersection([1, 2, 3], [2, 3, 4]))).toEqual([2, 3]);
  });

  test('is empty when there is no overlap', () => {
    expect(Array.from(intersection([1, 2], [3, 4]))).toEqual([]);
  });
});

describe('difference', () => {
  test('yields elements of a that are not in b', () => {
    expect(Array.from(difference([1, 2, 3], [2]))).toEqual([1, 3]);
  });
});
