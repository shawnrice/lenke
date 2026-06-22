import { describe, expect, test } from 'bun:test';

import { boundary } from './boundary.js';

describe('boundary', () => {
  test('returns the same function reference (the brand is type-only)', () => {
    const fn = (it: Iterable<number>): number => Array.from(it).length;
    const branded = boundary(fn);

    expect(branded === fn).toBe(true); // identity preserved; brand is type-only
  });

  test('the branded function still behaves like the original', () => {
    const lengthOf = boundary((it: Iterable<number>): number => Array.from(it).length);

    expect(lengthOf([1, 2, 3])).toBe(3);
  });
});
