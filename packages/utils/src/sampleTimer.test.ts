import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { sampleTimer } from './sampleTimer.js';

describe('sampleTimer', () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    delete globalThis.__DEV__;
  });

  test('is a noop sample timer when timing is disabled', () => {
    const t = sampleTimer('thing');
    const end = t.getTimer();
    end();
    t.stats();
    t.reset();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('records samples when enabled', () => {
    globalThis.__DEV__ = true;
    const t = sampleTimer('thing');
    t.getTimer()();
    t.getTimer()();
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  test('stats reports zero-sample case without crashing', () => {
    globalThis.__DEV__ = true;
    const t = sampleTimer('thing');
    expect(() => t.stats()).not.toThrow();
    expect(infoSpy.mock.calls.at(-1)?.[0]).toMatch(/0 samples/);
  });

  test('stats summarizes samples', () => {
    globalThis.__DEV__ = true;
    const t = sampleTimer('thing');
    t.getTimer()();
    t.getTimer()();
    t.getTimer()();
    infoSpy.mockClear();

    t.stats();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const message = infoSpy.mock.calls[0][0] as string;
    expect(message).toContain('thing 3 samples');
    expect(message).toContain('Mean:');
    expect(message).toContain('Median:');
    expect(message).toContain('StdDev:');
  });

  test('reset clears recorded samples', () => {
    globalThis.__DEV__ = true;
    const t = sampleTimer('thing');
    t.getTimer()();
    t.getTimer()();

    t.reset();
    infoSpy.mockClear();

    t.stats();
    expect(infoSpy.mock.calls[0][0]).toMatch(/0 samples/);
  });
});
