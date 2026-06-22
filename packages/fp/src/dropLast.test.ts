import { describe, expect, test } from 'bun:test';

import { dropLast } from './dropLast.js';

describe('dropLast', () => {
  test('drops the last N elements', () => {
    expect(Array.from(dropLast(2, [1, 2, 3, 4]))).toEqual([1, 2]);
  });

  test('a count of 0 or less yields everything', () => {
    expect(Array.from(dropLast(0, [1, 2, 3]))).toEqual([1, 2, 3]);
    expect(Array.from(dropLast(-1, [1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test('a count >= length yields nothing', () => {
    expect(Array.from(dropLast(5, [1, 2, 3]))).toEqual([]);
  });

  test('curried form', () => {
    const dropOne = dropLast<number>(1);

    expect(Array.from(dropOne([1, 2, 3]))).toEqual([1, 2]);
  });
});
