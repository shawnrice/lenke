import { describe, expect, test } from 'bun:test';

import { partition } from './partition.js';

describe('partition', () => {
  test('splits into [pass, fail] preserving order', () => {
    const [pass, fail] = partition((n: number) => n % 2 === 0, [1, 2, 3, 4, 5]);

    expect(pass).toEqual([2, 4]);
    expect(fail).toEqual([1, 3, 5]);
  });

  test('an empty iterable yields two empty arrays', () => {
    expect(partition((n: number) => n > 0, [])).toEqual([[], []]);
  });

  test('curried form', () => {
    const splitSign = partition((n: number) => n >= 0);

    expect(splitSign([-1, 2, -3, 4])).toEqual([
      [2, 4],
      [-1, -3],
    ]);
  });
});
