import { describe, expect, test } from 'bun:test';

import { sortBy } from './sortBy.js';

describe('sortBy', () => {
  test('sorts by numeric key', () => {
    const items = [{ age: 30 }, { age: 10 }, { age: 20 }];
    expect(sortBy((x: { age: number }) => x.age, items)).toEqual([
      { age: 10 },
      { age: 20 },
      { age: 30 },
    ]);
  });

  test('sorts by string key', () => {
    const items = [{ name: 'charlie' }, { name: 'alice' }, { name: 'bob' }];
    expect(sortBy((x: { name: string }) => x.name, items)).toEqual([
      { name: 'alice' },
      { name: 'bob' },
      { name: 'charlie' },
    ]);
  });

  test('curries', () => {
    const byLen = sortBy((s: string) => s.length);
    expect(byLen(['ccc', 'a', 'bb'])).toEqual(['a', 'bb', 'ccc']);
  });

  test('does not mutate input', () => {
    const items = [3, 1, 2];
    const sorted = sortBy((x: number) => x, items);
    expect(items).toEqual([3, 1, 2]);
    expect(sorted).toEqual([1, 2, 3]);
  });
});
