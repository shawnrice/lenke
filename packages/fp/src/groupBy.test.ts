import { describe, expect, test } from 'bun:test';

import { groupBy } from './groupBy.js';

describe('groupBy', () => {
  test('collects items into a Map of buckets, preserving order', () => {
    const grouped = groupBy((n: number) => (n % 2 === 0 ? 'even' : 'odd'), [1, 2, 3, 4, 5]);

    expect(grouped.get('odd')).toEqual([1, 3, 5]);
    expect(grouped.get('even')).toEqual([2, 4]);
  });

  test('an empty iterable yields an empty Map', () => {
    expect(groupBy((n: number) => n, []).size).toBe(0);
  });

  test('curried form', () => {
    const byFirstLetter = groupBy((s: string) => s[0]);

    expect(byFirstLetter(['ant', 'ape', 'bee']).get('a')).toEqual(['ant', 'ape']);
  });
});
