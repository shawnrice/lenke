import { describe, expect, test } from 'bun:test';

import { find } from './find.js';

describe('find', () => {
  test('returns the first matching element', () => {
    expect(find((x: number) => x > 2, [1, 2, 3, 4])).toBe(3);
  });

  test('returns undefined when nothing matches', () => {
    expect(find((x: number) => x > 9, [1, 2])).toBeUndefined();
  });

  test('stops at the first match (does not scan the rest)', () => {
    const seen: number[] = [];
    find(
      (x: number) => {
        seen.push(x);

        return x === 2;
      },
      [1, 2, 3, 4],
    );

    expect(seen).toEqual([1, 2]);
  });

  test('curried form', () => {
    const firstEven = find((x: number) => x % 2 === 0);

    expect(firstEven([1, 3, 4, 6])).toBe(4);
  });
});
