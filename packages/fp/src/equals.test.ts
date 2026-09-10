import { describe, expect, test } from 'bun:test';

import { equals } from './equals.js';

const range = function* (start: number, stop: number) {
  let x = start;

  while (x <= stop) {
    yield x++;
  }
};

describe('functional iterator tests', () => {
  test('equals works', () => {
    expect(equals([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeTruthy();
  });

  test('equals works with a comparator', () => {
    const a = [1, 2, 3, 4, 5];
    const b = ['1', '2', '3', '4', '5'];
    expect(equals<string | number>(a, b)).toBe(false);
    // eslint-disable-next-line eqeqeq -- intentional loose equality to verify the custom comparator path
    expect(equals<string | number>(a, b, (x, y) => x == y)).toBe(true);
  });

  test('equals finds different sizes', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2, 3];
    expect(equals(a, b)).toBe(false);
    expect(equals(b, a)).toBe(false);
    expect(equals(a.slice(0, 3), b)).toBe(true);
  });

  test('using generators works', () => {
    expect(equals(range(0, 10), range(0, 10))).toBe(true);
  });

  test('overflow protection throws past the cap (rather than a wrong `false`)', () => {
    // Past the 1M guard cap `equals` THROWS — reporting that the input exceeded the
    // supported length — instead of silently returning `false` for two EQUAL sequences.
    expect(() => equals(range(0, 1_000_500), range(0, 1_000_500))).toThrow(RangeError);
  });
});
