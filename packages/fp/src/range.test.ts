import { describe, expect, test } from 'bun:test';

import { range } from './range.js';
import { take } from './take.js';

describe('functional iterator tests', () => {
  test('range works', () => {
    expect(Array.from(range(1, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('range can go backwards', () => {
    expect(Array.from(range(10, 1))).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  test('range can be start and end', () => {
    expect(Array.from(range(10, 10))).toEqual([]);
  });

  test('we can use one arg', () => {
    expect(Array.from(take(5, range(5)))).toEqual([5, 6, 7, 8, 9]);
  });
});
