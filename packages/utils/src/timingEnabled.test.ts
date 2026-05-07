import { afterEach, describe, expect, test } from 'bun:test';
import { isTimingEnabled } from './timingEnabled.js';

describe('isTimingEnabled', () => {
  afterEach(() => {
    delete globalThis.__DEV__;
  });

  test('is false when __DEV__ is not set', () => {
    expect(isTimingEnabled()).toBe(false);
  });

  test('is false when __DEV__ is explicitly false', () => {
    globalThis.__DEV__ = false;
    expect(isTimingEnabled()).toBe(false);
  });

  test('is false when __DEV__ is a truthy non-true value', () => {
    // @ts-expect-error: deliberately wrong type to exercise the strict check
    globalThis.__DEV__ = 1;
    expect(isTimingEnabled()).toBe(false);
  });

  test('is true when __DEV__ is exactly true', () => {
    globalThis.__DEV__ = true;
    expect(isTimingEnabled()).toBe(true);
  });
});
