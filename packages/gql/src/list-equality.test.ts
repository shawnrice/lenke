import { describe, expect, test } from 'bun:test';

import { createTestSocialGraph } from './fixtures/createTestSocialGraph.js';
import { query } from './index.js';

// Regression: list `=` / `<>` / `IN` must be STRUCTURAL, matching the Rust
// engine's `val_eq`. The TS engine previously used reference identity, so
// `[1,2] = [1,2]` returned false here but true on native — a byte-identical
// violation the (gremlin-only) differential runner never covered.
const g = createTestSocialGraph();
const one = (text: string): unknown => query(g, text)[0]?.x;

describe('GQL list value equality (structural, cross-engine)', () => {
  test('= compares lists by length then element-wise', () => {
    expect(one('RETURN [1, 2] = [1, 2] AS x')).toBe(true);
    expect(one('RETURN [1, 2] = [1, 3] AS x')).toBe(false);
    expect(one('RETURN [1, 2] = [1, 2, 3] AS x')).toBe(false);
    expect(one('RETURN [[1], [2]] = [[1], [2]] AS x')).toBe(true); // nested
  });

  test('<> is the negation', () => {
    expect(one('RETURN [1, 2] <> [1, 2] AS x')).toBe(false);
    expect(one('RETURN [1, 2] <> [1, 3] AS x')).toBe(true);
  });

  test('IN matches a list element structurally', () => {
    expect(one('RETURN [1] IN [[1], [2]] AS x')).toBe(true);
    expect(one('RETURN [3] IN [[1], [2]] AS x')).toBe(false);
  });

  test('scalar equality and null are unaffected', () => {
    expect(one('RETURN 1 = 1 AS x')).toBe(true);
    expect(one('RETURN null = null AS x')).toBeNull(); // UNKNOWN
    expect(one('RETURN 3 IN [1, 2, 3] AS x')).toBe(true);
  });
});
