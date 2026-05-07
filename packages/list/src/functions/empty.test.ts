import { describe, expect, test } from 'bun:test';
import { List } from '../List.js';
import { empty } from './empty.js';

describe('List functional tests', () => {
  test('empty works', () => {
    const list = empty();
    expect(List.isList(list)).toBe(true);
    expect(list).toHaveLength(0);
  });
});
