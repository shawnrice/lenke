import { describe, expect, test } from 'bun:test';

import { pick } from './pick.js';

describe('functional iterator tests', () => {
  test('pick selects specified keys', () => {
    const src = { a: 1, b: 2, c: 3 };
    expect(pick(['a', 'c'] as const, src)).toEqual({ a: 1, c: 3 });
  });

  test('pick with empty keys returns empty object', () => {
    const src = { a: 1, b: 2 };
    expect(pick([] as const, src)).toEqual({});
  });

  test('pick preserves key value types', () => {
    const src = { a: 1, b: 'two', c: true };
    const result = pick(['b'] as const, src);
    expect(result.b).toBe('two');
  });
});
