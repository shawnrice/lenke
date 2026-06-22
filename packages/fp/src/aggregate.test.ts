import { describe, expect, test } from 'bun:test';

import { max, maxBy, mean, min, minBy, sum, sumBy } from './aggregate.js';

describe('sum', () => {
  test('adds the numbers', () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  test('is 0 for an empty iterable', () => {
    expect(sum([])).toBe(0);
  });
});

describe('min / max', () => {
  test('find the extremes regardless of order', () => {
    expect(min([3, 1, 2])).toBe(1);
    expect(max([3, 1, 2])).toBe(3);
  });

  test('return undefined for an empty iterable', () => {
    expect(min([])).toBeUndefined();
    expect(max([])).toBeUndefined();
  });
});

describe('mean', () => {
  test('averages the numbers', () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  test('returns undefined for an empty iterable (no divide-by-zero)', () => {
    expect(mean([])).toBeUndefined();
  });
});

describe('sumBy / minBy / maxBy', () => {
  const items = [
    { name: 'a', score: 3 },
    { name: 'b', score: 1 },
    { name: 'c', score: 2 },
  ];

  test('sumBy sums the selected field', () => {
    expect(sumBy((x: { score: number }) => x.score, items)).toBe(6);
  });

  test('minBy / maxBy return the item, not the projected value', () => {
    expect(minBy((x) => x.score, items)?.name).toBe('b');
    expect(maxBy((x) => x.score, items)?.name).toBe('a');
  });

  test('minBy / maxBy return undefined for an empty iterable', () => {
    expect(minBy((x: number) => x, [])).toBeUndefined();
    expect(maxBy((x: number) => x, [])).toBeUndefined();
  });

  test('curried form', () => {
    const totalLength = sumBy((s: string) => s.length);

    expect(totalLength(['ab', 'c', 'def'])).toBe(6);
  });
});
