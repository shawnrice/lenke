import { describe, expect, test } from 'bun:test';

import { bounded } from './bounded.js';
import { count } from './count.js';
import { range } from './range.js';

describe('bounded', () => {
  test('caps an infinite iterable at the default max', () => {
    const safeCount = bounded(count);
    expect(safeCount(range())).toBe(1_000_000);
  });

  test('respects an explicit max', () => {
    const tinyCount = bounded(count, 5);
    expect(tinyCount(range())).toBe(5);
  });

  test('passes through when input is smaller than max', () => {
    const safeCount = bounded(count, 1_000);
    expect(safeCount([1, 2, 3])).toBe(3);
  });

  test('preserves the wrapped function shape', () => {
    const safeCount = bounded(count, 10);
    expect(safeCount(range(0, 100))).toBe(10);
  });
});
