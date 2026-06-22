/* eslint-disable max-lines-per-function */
/* eslint-disable no-magic-numbers */
// Coverage for the List surface the original suite skips: length tracking,
// head/last/tail, distinct, equals-with-comparator, the static constructors,
// re-iteration, and stringification.
import { describe, expect, test } from 'bun:test';

import { List } from './List.js';

describe('List length tracking', () => {
  test('from an array reports the array length', () => {
    expect(List.from([1, 2, 3]).length).toBe(3);
  });

  test('from a Set reports its size', () => {
    expect(List.from(new Set([1, 2, 3, 3])).length).toBe(3);
  });

  test('of reports the argument count', () => {
    expect(List.of(1, 2, 3, 4).length).toBe(4);
  });

  test('empty has length 0', () => {
    expect(List.empty().length).toBe(0);
  });

  test('an unbounded generator source reports Infinity', () => {
    // The constructor is the typed path for an unbounded source (length defaults
    // to Infinity); `List.from` only accepts an `Iterable` in its signature.
    const naturals = new List<number>(function* naturalsGen() {
      let i = 0;

      while (true) {
        yield i++;
      }
    });

    expect(naturals.length).toBe(Infinity);
    // ...but it's still lazily consumable
    expect(naturals.take(3).toArray()).toEqual([0, 1, 2]);
  });
});

describe('List head / last / tail', () => {
  test('head returns the first element', () => {
    expect(List.of(1, 2, 3).head()).toBe(1);
  });

  test('last returns the final element', () => {
    expect(List.of(1, 2, 3).last()).toBe(3);
  });

  test('tail returns everything after the head', () => {
    expect(List.of(1, 2, 3).tail().toArray()).toEqual([2, 3]);
  });

  test('head / last are undefined on an empty list', () => {
    expect(List.empty<number>().head()).toBeUndefined();
    expect(List.empty<number>().last()).toBeUndefined();
  });
});

describe('List distinct / equals', () => {
  test('distinct removes duplicates, keeping order', () => {
    expect(List.from([1, 1, 2, 3, 3, 1]).distinct().toArray()).toEqual([1, 2, 3]);
  });

  test('equals honours a custom comparator', () => {
    const upper = List.of('A', 'B');
    const lower = List.of('a', 'b');

    expect(upper.equals(lower)).toBe(false);
    expect(upper.equals(lower, (x, y) => x.toLowerCase() === y.toLowerCase())).toBe(true);
  });

  test('equals is false when lengths differ', () => {
    expect(List.of(1, 2).equals(List.of(1, 2, 3))).toBe(false);
  });
});

describe('List static helpers & protocols', () => {
  test('isList distinguishes a List from a plain array', () => {
    expect(List.isList(List.of(1))).toBe(true);
    expect(List.isList([1])).toBe(false);
  });

  test('a List is re-iterable (the generator is re-invoked each pass)', () => {
    const list = List.of(1, 2, 3);

    expect(list.toArray()).toEqual([1, 2, 3]);
    expect(list.toArray()).toEqual([1, 2, 3]); // not exhausted by the first pass
  });

  test('spreads through the iterator protocol', () => {
    expect([...List.of(1, 2, 3)]).toEqual([1, 2, 3]);
  });

  test('map can change the element type', () => {
    expect(
      List.of(1, 2, 3)
        .map((n) => `#${n}`)
        .toArray(),
    ).toEqual(['#1', '#2', '#3']);
  });

  test('toString shows the first three elements', () => {
    expect(List.of(1, 2, 3, 4, 5).toString()).toBe('List { [1,2,3] }');
  });
});
