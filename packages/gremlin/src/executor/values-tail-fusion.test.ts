/*
 * Item 2082 — `V().values(k).tail(n)`, the fused scan with a ring buffer.
 *
 * ⚠️⚠️ **THE WRAP POINT IS THE WHOLE RISK.** A ring stores at `seen % n` and the oldest surviving row
 * is then at `seen % n` — but ONLY once `seen > n`; below that it is at 0. So the three cases around
 * that boundary (`seen < n`, `seen === n`, `seen === n + 1`) are each asserted, because an off-by-one
 * in `start` rotates the answer rather than truncating it, and a rotated answer has the right LENGTH.
 *
 * ⚠️ And `seen` counts PRESENT values, not vertices: a vertex lacking the key never enters the ring,
 * so a fixture with such a vertex is what separates "the last n vertices" from "the last n values".
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { cap, order, store, tail, toArray, traversal, V, values } from '../index.js';
import { valuesTailShortcut } from './node-values.js';

/** Vertices `v0…v{m-1}` with `n = i * 10`, and ONE vertex in the middle holding no `n` at all. */
const build = (m: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < m; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: ['T'],
      // ⚠️ `v2` HAS NO `n`: it must not occupy a ring slot.
      properties: i === 2 ? { other: i } : { n: i * 10 },
    });
  }

  return g;
};

/** The present values in walk order — the reference the ring's output is a suffix of. */
const presentValues = (m: number): number[] => {
  const out: number[] = [];

  for (let i = 0; i < m; i++) {
    if (i !== 2) {
      out.push(i * 10);
    }
  }

  return out;
};

describe('fused values + tail (item 2082)', () => {
  test('THE ROUTE: the rung claims the three-step shape', () => {
    expect(valuesTailShortcut(traversal(V(), values('n'), tail(3)), build(8))).toBeDefined();
  });

  test('⚠️ `seen > n`: the ring has WRAPPED and the answer is the last n, in order', () => {
    const g = build(8);
    // present: [0, 10, 30, 40, 50, 60, 70] — seven values, ring of three.
    expect(toArray(traversal(V(), values('n'), tail(3)), g)).toStrictEqual([50, 60, 70]);
  });

  test('⚠️ `seen === n` EXACTLY: start must be 0, not `seen % n`', () => {
    /*
     * 🔑 THE BOUNDARY. With seven present values and `tail(7)`, `seen % n` is 0 either way — so this
     * case passes under both readings and is NOT the discriminating one. It is here to pin the
     * full-length answer; the test below is the one that separates them.
     */
    const g = build(8);

    expect(toArray(traversal(V(), values('n'), tail(7)), g)).toStrictEqual(presentValues(8));
  });

  test('⚠️⚠️ `seen === n + 1`: the oldest row is at index 1 and a wrong start ROTATES the answer', () => {
    /*
     * 🔑 THE DISCRIMINATING CASE. Seven present values into a ring of six: slot 0 has been overwritten
     * by the LAST value, so the buffer as stored reads [70, 10, 30, 40, 50, 60] while the answer is
     * [10, 30, 40, 50, 60, 70]. A walk yielding the buffer in storage order returns all six rows — the
     * right COUNT, the wrong ORDER — which is why `toStrictEqual` on the sequence is the assertion.
     */
    const g = build(8);

    expect(toArray(traversal(V(), values('n'), tail(6)), g)).toStrictEqual([
      10, 30, 40, 50, 60, 70,
    ]);
  });

  test('⚠️ `seen < n`: fewer values than the ring holds, and NO empty slots leak', () => {
    /*
     * ⚠️ `new Array(10)` IS TEN HOLES. If `kept` were the ring's length rather than `seen`, the answer
     * would carry trailing `undefined`s — and [[toequal-blind-to-trailing-undefined]] says `toEqual`
     * would PASS that. `toStrictEqual` plus an explicit length is what makes it fail.
     */
    const g = build(4);
    const rows = toArray(traversal(V(), values('n'), tail(10)), g);

    expect(rows).toStrictEqual([0, 10, 30]);
    expect(rows).toHaveLength(3);
  });

  test('⚠️ a vertex with NO key does not occupy a slot', () => {
    /*
     * 🔑 `v2` HOLDS NO `n`. Asking for exactly as many rows as there are PRESENT values returns all of
     * them; a walk incrementing `seen` per VERTEX would have advanced the ring past one, dropping the
     * oldest real value and leaving a hole.
     */
    const g = build(8);

    expect(toArray(traversal(V(), values('n'), tail(7)), g)).toStrictEqual([
      0, 10, 30, 40, 50, 60, 70,
    ]);
  });

  test('it agrees with the GENERIC path, which a trailing step forces', () => {
    const g = build(12);

    for (const n of [1, 2, 3, 7, 10, 11, 12, 50]) {
      expect(toArray(traversal(V(), values('n'), tail(n)), g)).toStrictEqual(
        // ⚠️ `order()` after the tail would re-sort; a tail of the ALREADY-tailed stream is identity
        // and defeats the three-step rung, so it is the generic path's own answer.
        toArray(traversal(V(), values('n'), tail(n), tail(n)), g),
      );
    }
  });

  test('the ITERATOR and `drain` agree exactly', () => {
    const claimed = valuesTailShortcut(traversal(V(), values('n'), tail(3)), build(8));

    expect(claimed).toBeDefined();
    expect([...claimed!]).toStrictEqual(claimed!.drain!());
  });

  test('⚠️⚠️ `tail(0)` DECLINES — `% 0` is NaN, and the right answer is coincidental', () => {
    /*
     * ⚠️ A ring of length zero makes `seen % n` NaN and `buf[NaN]` a silent no-op, so the walk would
     * emit nothing — which happens to be CORRECT for `tail(0)` and becomes wrong the instant the guard
     * is reused or the emit loop changes. It is refused instead, and the generic path answers it.
     */
    const g = build(8);

    expect(valuesTailShortcut(traversal(V(), values('n'), tail(0)), g)).toBeUndefined();
    expect(toArray(traversal(V(), values('n'), tail(0)), g)).toStrictEqual([]);
  });

  test('⚠️⚠️ `tail(0)` STILL CONSUMES ITS UPSTREAM — a lazy side effect must see every row', () => {
    /*
     * ⚠️⚠️ **THIS TEST EXISTS BECAUSE A SURVIVING MUTANT EXPOSED A DIVERGENCE I HAD JUST INTRODUCED.**
     * The generic `tailTraversers` now rings instead of shifting, and its `n < 1` arm first returned
     * WITHOUT touching the stream. `store` is lazy by contract (items 2070/2078) — it banks only what
     * actually flows through it — so `store('x').tail(0).cap('x')` read a bag of 0 where HEAD's
     * unconditional loop read 5. A perf change must not move an observable behaviour, so the zero arm
     * drains, and this pins it.
     *
     * 🔑 `aggregate` CANNOT SEE THIS: it is an EAGER barrier, so its bag was full either way. The
     * laziness of the side effect is what makes the difference observable, which is the same
     * distinction items 2070 and 2078 turned on.
     */
    const mk = (): Graph => {
      const g = new Graph();

      for (let i = 0; i < 5; i++) {
        g.addVertex({ id: `w${i}`, labels: ['T'], properties: { n: i } });
      }

      return g;
    };

    for (const n of [0, 1, 3]) {
      const bag = toArray(traversal(V(), store('x'), tail(n), cap('x')), mk())[0] as unknown[];

      expect(bag).toHaveLength(5);
    }
  });

  test('a NEGATIVE or fractional n declines', () => {
    const g = build(8);

    expect(valuesTailShortcut(traversal(V(), values('n'), tail(-1)), g)).toBeUndefined();
    expect(valuesTailShortcut(traversal(V(), values('n'), tail(1.5)), g)).toBeUndefined();
  });

  test("⚠️ `tail(local)` DECLINES — it slices each row's own value, a different step", () => {
    const g = build(8);
    const localScoped = {
      steps: [
        { kind: 'V' },
        { kind: 'values', keys: ['n'] },
        { kind: 'tail', n: 3, scope: 'local' },
      ],
    } as never;

    expect(valuesTailShortcut(localScoped, g)).toBeUndefined();
  });

  test('a TRAILING step declines', () => {
    const g = build(8);

    expect(valuesTailShortcut(traversal(V(), values('n'), tail(3), order()), g)).toBeUndefined();
    expect(toArray(traversal(V(), values('n'), tail(3), order()), g)).toStrictEqual([50, 60, 70]);
  });

  test('a MULTI-KEY projection declines', () => {
    expect(
      valuesTailShortcut(traversal(V(), values('n', 'other'), tail(3)), build(8)),
    ).toBeUndefined();
  });

  test('V(ids) declines — a given set is not the whole graph', () => {
    const g = build(8);

    expect(valuesTailShortcut(traversal(V('v0', 'v1'), values('n'), tail(3)), g)).toBeUndefined();
    expect(toArray(traversal(V('v0', 'v1'), values('n'), tail(3)), g)).toStrictEqual([0, 10]);
  });
});
