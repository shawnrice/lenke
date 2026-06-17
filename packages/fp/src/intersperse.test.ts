import { describe, expect, test } from 'bun:test';

import { intersperse } from './intersperse.js';

describe('functional iterator tests', () => {
  test('intersperse inserts separators between items', () => {
    const result = Array.from(intersperse(',', ['a', 'b', 'c']));
    expect(result).toEqual(['a', ',', 'b', ',', 'c']);
  });

  test('intersperse yields original for single item', () => {
    const result = Array.from(intersperse(0, [42]));
    expect(result).toEqual([42]);
  });

  test('intersperse with empty iterable yields empty', () => {
    const result = Array.from(intersperse(0, [] as number[]));
    expect(result).toEqual([]);
  });

  test('intersperse works with generators', () => {
    const gen = function* () {
      yield 1;

      yield 2;

      yield 3;
    };
    const result = Array.from(intersperse(0, gen()));
    expect(result).toEqual([1, 0, 2, 0, 3]);
  });
});
