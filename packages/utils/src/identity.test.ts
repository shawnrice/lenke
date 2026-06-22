import { describe, expect, test } from 'bun:test';

import { identity } from './identity.js';

describe('identity', () => {
  test('returns primitives unchanged', () => {
    expect(identity(42)).toBe(42);
    expect(identity('x')).toBe('x');
    expect(identity(true)).toBe(true);
  });

  test('returns the same reference for objects (no copy)', () => {
    const obj = { a: 1 };
    const arr = [1, 2, 3];

    expect(identity(obj)).toBe(obj);
    expect(identity(arr)).toBe(arr);
  });

  test('passes null and undefined through', () => {
    expect(identity(null)).toBeNull();
    expect(identity(undefined)).toBeUndefined();
  });
});
