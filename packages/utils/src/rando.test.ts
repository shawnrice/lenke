import { describe, expect, test } from 'bun:test';

import { rando } from './rando.js';

describe('rando', () => {
  test('returns a string', () => {
    expect(typeof rando()).toBe('string');
  });

  test('is shaped like a UUID', () => {
    expect(rando()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('produces a distinct value on each call', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => rando()));

    expect(ids.size).toBe(1000); // no collisions across 1000 draws
  });
});
