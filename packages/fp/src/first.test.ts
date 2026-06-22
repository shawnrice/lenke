import { describe, expect, test } from 'bun:test';

import { first } from './first.js';

describe('first', () => {
  test('returns the first element', () => {
    expect(first([1, 2, 3])).toBe(1);
  });

  test('returns undefined for an empty iterable', () => {
    expect(first([])).toBeUndefined();
  });

  test('works on a non-array iterable (only pulls one element)', () => {
    expect(first(new Set(['a', 'b']))).toBe('a');
  });

  test('curried form', () => {
    const f = first<number>();

    expect(f([9, 8, 7])).toBe(9);
  });
});
