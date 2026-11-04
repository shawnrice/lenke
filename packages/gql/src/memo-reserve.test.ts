import { describe, expect, test } from 'bun:test';

import { type SlotMemo, memoReserve } from './executor/shortcuts.js';

/**
 * `memoReserve`, tested directly, because the query suite cannot reach its growth copy (item 1418).
 *
 * Item 1418 replaced the sweep's ~100,000 per-slot `Int32Array`s with one flat buffer plus per-slot
 * `(offset, length)` — worth **25.7%** on the 4-hop chain count at 81/81. Five mutants were run
 * against the offset arithmetic and four were caught by the 3,610-test query suite. The fifth was
 * not:
 *
 *   `grown.set(m.flat.subarray(0, m.used))`  →  `subarray(0, m.used - 1)`
 *
 * — which silently drops the last entry **every time the buffer doubles**.
 *
 * ⚠️ FOUR BLACK-BOX ATTEMPTS FAILED TO CATCH IT, and the two theories behind them were both wrong:
 *
 *   * "the fixtures are too small to grow the buffer" — a counter in the growth branch showed it
 *     fires **3 times** on a 4,096-slot fixture, with 2 of those having entries to copy.
 *   * "a path never reads the memo back, so the stored data cannot matter" — a counter on the read
 *     branch showed a 4,096-vertex path reads it **8,189 times**.
 *
 * The real reason is narrower: the dropped entry belongs to whichever slot was written immediately
 * before a growth, and whether that entry is ever read depends on frontier ordering. A query shape
 * that reliably reads it would have to be constructed from the sweep's internals, which is a test of
 * the arithmetic wearing a query costume.
 *
 * So this is the arithmetic itself — the repo's recorded answer for exactly this shape: *a route
 * choice is answer-equivalent, so every mutant survives the differential tests; extract the
 * arithmetic as a pure fn and unit-test it*. The invariant is one line: **growth preserves every
 * entry already written.**
 */

const fresh = (): SlotMemo => ({ flat: new Int32Array(0), used: 0, off: [], len: [] });

/** Append `n` entries with recognisable values, exactly as `sweepSlotCached` does. */
const append = (m: SlotMemo, slot: number, values: readonly number[]): void => {
  memoReserve(m, values.length);

  const base = m.used;

  for (let i = 0; i < values.length; i += 1) {
    m.flat[base + i] = values[i]!;
  }

  m.used = base + values.length;
  m.off[slot] = base;
  m.len[slot] = values.length;
};

/** Every entry ever written, read back through the per-slot offsets. */
const readBack = (m: SlotMemo): number[] => {
  const out: number[] = [];

  for (let slot = 0; slot < m.len.length; slot += 1) {
    const n = m.len[slot];

    if (n === undefined) {
      continue;
    }

    const base = m.off[slot];

    for (let i = 0; i < n; i += 1) {
      out.push(m.flat[base + i]);
    }
  }

  return out;
};

describe('memoReserve preserves every written entry across growth (item 1418)', () => {
  test('⚠️ 5,000 single-entry slots — the mutant-killer', () => {
    // THE DIRECT GUARD. The initial buffer is empty and the first allocation is 1024 entries, so
    // 5,000 slots force several doublings. Each slot's value is its own index, so a lost entry shows
    // up as a 0 in a known position rather than as a count that might coincide.
    const m = fresh();
    const expected: number[] = [];

    for (let slot = 0; slot < 5000; slot += 1) {
      append(m, slot, [slot + 1]);
      expected.push(slot + 1);
    }

    expect(readBack(m)).toEqual(expected);
    // No zeros anywhere: `slot + 1` is never 0, so a 0 can only be an uncopied cell.
    expect(readBack(m)).not.toContain(0);
  });

  test('runs of several entries, so an off-by-one WITHIN a run is visible too', () => {
    // Single-entry slots cannot distinguish "lost the run's last entry" from "lost the run", so the
    // runs here vary in length and carry distinct values.
    const m = fresh();
    const expected: number[] = [];

    for (let slot = 0; slot < 1200; slot += 1) {
      const run = [slot * 10 + 1, slot * 10 + 2, slot * 10 + 3];

      append(m, slot, run);
      expected.push(...run);
    }

    expect(readBack(m)).toEqual(expected);
    expect(m.used).toBe(1200 * 3);
  });

  test('the buffer only ever grows, and always holds at least what is used', () => {
    const m = fresh();
    let lastLen = 0;

    for (let slot = 0; slot < 3000; slot += 1) {
      append(m, slot, [slot]);

      expect(m.flat.length).toBeGreaterThanOrEqual(m.used);
      expect(m.flat.length).toBeGreaterThanOrEqual(lastLen);
      lastLen = m.flat.length;
    }
  });

  test('a single reserve larger than the whole buffer is honoured', () => {
    // The sweep calls `memoReserve(memo, n)` with a slot's full degree, so one high-degree vertex
    // can demand more than the current capacity in a single call — the `while` loop, not one double.
    const m = fresh();
    const big = Array.from({ length: 5000 }, (_, i) => i + 1);

    append(m, 0, big);

    expect(m.flat.length).toBeGreaterThanOrEqual(5000);
    expect(readBack(m)).toEqual(big);
  });

  test('reserving zero is a no-op, and reserving within capacity does not reallocate', () => {
    const m = fresh();

    append(m, 0, [7]);

    const before = m.flat;

    memoReserve(m, 0);
    expect(m.flat).toBe(before);

    // Well inside the 1024 already allocated.
    memoReserve(m, 10);
    expect(m.flat).toBe(before);
    expect(readBack(m)).toEqual([7]);
  });

  test('an empty memo reserves without reading past the zero-length buffer', () => {
    // `fresh()` starts at length 0, so the first growth copies `subarray(0, 0)`. This is the case
    // where the mutant is INVISIBLE even to this file — `Math.max(0, -1)` is also 0 — which is why
    // the 5,000-slot case above is the one that matters.
    const m = fresh();

    memoReserve(m, 1);
    expect(m.flat.length).toBeGreaterThanOrEqual(1);
    expect(m.used).toBe(0);
  });
});
