import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { timer } from './timer.js';

describe('timer', () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    delete globalThis.__DEV__;
  });

  test('is a noop when timing is disabled', () => {
    const end = timer('thing');
    end();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('logs when __DEV__ is true', () => {
    globalThis.__DEV__ = true;
    const end = timer('thing');
    end();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatch(/\[TIMER\] thing took/);
  });
});
