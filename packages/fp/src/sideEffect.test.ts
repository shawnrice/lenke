import { describe, expect, mock, test } from 'bun:test';

import { sideEffect } from './sideEffect.js';

describe('functional iterator tests', () => {
  test('side effect calls functions', () => {
    const noop = mock(() => {});
    const noop2 = mock(() => {});

    Array.from(sideEffect(noop, [1, 2, 3, 4, 5]));
    expect(noop).toHaveBeenCalledTimes(5);
    expect(noop2).not.toHaveBeenCalled();
  });
});
