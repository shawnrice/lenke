import { describe, expect, test } from 'bun:test';

import { arraysAreEqual } from './arraysAreEqual.js';

describe('arraysAreEqual', () => {
  test('arrays of different lengths are not equal', () => {
    expect(arraysAreEqual([1], [1, 2])).toBe(false);
  });

  test('arrays can be equal', () => {
    expect(arraysAreEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  test('strings and numbers are not the same thing', () => {
    expect(arraysAreEqual([1, 2, 3], ['1', '2', '3'])).toBe(false);
  });

  test('two empty arrays are equal', () => {
    expect(arraysAreEqual([], [])).toBe(true);
  });

  test('order matters', () => {
    expect(arraysAreEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  test('an array equals itself (same reference)', () => {
    const a = [1, 2, 3];

    expect(arraysAreEqual(a, a)).toBe(true);
  });

  test('elements are compared with === (NaN never equals NaN)', () => {
    // documents the `===` contract: same position, but NaN !== NaN
    expect(arraysAreEqual([NaN], [NaN])).toBe(false);
  });

  test('objects are compared by reference, not structurally', () => {
    const shared = { a: 1 };

    expect(arraysAreEqual([shared], [shared])).toBe(true); // same ref
    expect(arraysAreEqual([{ a: 1 }], [{ a: 1 }])).toBe(false); // distinct refs
  });

  test('treats +0 and -0 as equal (=== semantics)', () => {
    expect(arraysAreEqual([0], [-0])).toBe(true);
  });
});
