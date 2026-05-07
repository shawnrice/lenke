import { describe, expect, test } from 'bun:test';
import { List } from '../List.js';
import { of } from './of.js';

describe('List functional tests', () => {
  test('of works', () => {
    const list = of(1, 2, 3, 4, 5);
    expect(List.isList(list)).toBe(true);
    expect(list.toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(list).toHaveLength(5);
  });
});
