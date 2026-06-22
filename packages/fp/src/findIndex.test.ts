import { describe, expect, test } from 'bun:test';

import { findIndex } from './findIndex.js';

describe('findIndex', () => {
  test('returns the index of the first match', () => {
    expect(findIndex((x: number) => x > 2, [1, 2, 3, 4])).toBe(2);
  });

  test('returns -1 when nothing matches', () => {
    expect(findIndex((x: number) => x > 9, [1, 2])).toBe(-1);
  });

  test('returns -1 for an empty iterable', () => {
    expect(findIndex((x: number) => x > 0, [])).toBe(-1);
  });

  test('curried form', () => {
    const idxOfFive = findIndex((x: number) => x === 5);

    expect(idxOfFive([3, 4, 5, 6])).toBe(2);
  });
});
