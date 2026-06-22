import { describe, expect, test } from 'bun:test';

import { window } from './window.js';

describe('window', () => {
  test('slides a fixed-size window one step at a time', () => {
    expect(Array.from(window(2, [1, 2, 3, 4]))).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  test('yields nothing when the input is shorter than the window', () => {
    expect(Array.from(window(3, [1, 2]))).toEqual([]);
  });

  test('a size of 0 or less yields nothing', () => {
    expect(Array.from(window(0, [1, 2, 3]))).toEqual([]);
  });

  test('each window is an independent copy', () => {
    const windows = Array.from(window(2, [1, 2, 3]));

    expect(windows[0]).toEqual([1, 2]);
    expect(windows[1]).toEqual([2, 3]);
  });
});
