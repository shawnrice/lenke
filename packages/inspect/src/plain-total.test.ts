import { describe, expect, test } from 'bun:test';

import { formatRows } from './table.js';
import { plain } from './value.js';

/*
 * Item 2525: `plain` must be TOTAL — it is annotated `: string` and a formatter that throws
 * replaces the information its caller came for.
 *
 * It ended in a bare `JSON.stringify(value)`, which is not total over `unknown`:
 *
 *   - THROWS on a `bigint` and on a cyclic structure;
 *   - returns `undefined`, not a string, for a function or a symbol — so the `: string` annotation
 *     was false and `formatRows` crashed downstream in `widths` with
 *     "undefined is not an object (evaluating 'cells[i].length')", a message pointing nowhere near
 *     the value that caused it.
 *
 * `Row = Record<string, unknown>` is the PUBLIC parameter type, so every one of these is a value a
 * caller can legitimately hold. An earlier comment argued the bigint case away by REACHABILITY
 * ("bigint is rejected at every write"), which is true of the write path and irrelevant to a
 * function that accepts `unknown` — item 2516's rule: safe by TYPE beats safe by REACHABILITY.
 *
 * Nothing pinned any of it: the pre-existing suite had no bigint, cyclic, symbol or function case.
 */
describe('plain is total over unknown (item 2525)', () => {
  test('a bigint renders rather than throwing', () => {
    expect(plain(10n)).toBe('10');
    expect(plain(-7n)).toBe('-7');
  });

  test('a cyclic structure names the reason instead of crashing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };

    cyclic.self = cyclic;

    // `String(value)` would give `[object Object]`, which tells the reader nothing.
    expect(plain(cyclic)).toBe('[unserializable]');
  });

  test('a function and a symbol return STRINGS, not undefined', () => {
    const named = function helper(): number {
      return 1;
    };

    expect(plain(named)).toBe('[function helper]');
    expect(typeof plain(() => 1)).toBe('string');
    expect(plain(Symbol('s'))).toBe('Symbol(s)');
  });

  /* CONTROLS — the pre-existing contract, which must not shift. */
  test('CONTROL: a string stays unquoted and null stays visible', () => {
    expect(plain('marko')).toBe('marko');
    expect(plain(null)).toBe('null');
    expect(plain(undefined)).toBe('');
  });

  test('CONTROL: numbers, booleans and plain objects are unchanged', () => {
    expect(plain(29)).toBe('29');
    expect(plain(true)).toBe('true');
    expect(plain({ a: 1 })).toBe('{"a":1}');
    expect(plain([1, 2])).toBe('[1,2]');
  });

  /*
   * THE INTEGRATION POINT, which is where the crash actually surfaced: `widths` reads
   * `cells[i].length`, so a non-string from `plain` took the whole table down.
   */
  test('formatRows survives every one of them', () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    const hostile = [
      { v: 10n },
      { v: cyclic },
      { v: (): number => 1 },
      { v: Symbol('s') },
      { v: new Map([['k', 1]]) },
    ];

    for (const row of hostile) {
      expect(() => formatRows([row], { color: false })).not.toThrow();
    }

    // And all together, where the column width is computed across mixed cells.
    expect(() => formatRows(hostile, { color: false })).not.toThrow();
  });
});
