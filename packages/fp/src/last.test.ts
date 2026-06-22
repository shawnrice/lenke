import { describe, expect, test } from 'bun:test';

import { last } from './last.js';

describe('last', () => {
  test('returns the last element', () => {
    expect(last([1, 2, 3])).toBe(3);
  });

  test('returns undefined for an empty iterable', () => {
    expect(last([])).toBeUndefined();
  });

  test('curried form', () => {
    const l = last<number>();

    expect(l([1, 2, 3])).toBe(3);
  });
});
