// Gremlin orders STRINGS by Unicode code point, matching the engine (item 1712).
//
// THIS GUARDS A CONFIRMED BYTE-IDENTITY BREAK, not a hypothetical. `cmpSameType` sent a string pair
// to `cmpOrd`, a plain `x < y ? -1 : x > y ? 1 : 0`, so `values('s').order()` disagreed with the
// Rust engine on any column mixing an astral char with a BMP char in U+E000..U+FFFF. Measured
// three ways on `['a', U+1F600, U+E000, 'z']`:
//
//     gremlin NAT   a  z  U+E000   U+1F600     the engine (Rust str::cmp, code point)
//     gql     TS    a  z  U+E000   U+1F600     already matched native
//     gremlin TS    a  z  U+1F600  U+E000      the outlier (JS <, code unit)
//
// WHY THAT PAIR AND NOT ANY TWO STRINGS: `''` is code point 57344 in ONE UTF-16 unit, while
// an astral char's FIRST unit is a high surrogate in 0xD800..0xDBFF — numerically LOWER. So code
// units rank the astral char first and code points rank it last. Any pair that does not straddle
// that boundary agrees under both orders and would pass with the bug present, which is exactly why
// no fuzzer caught it: `gremlin-fuzz.test.ts` calls `order(` 59 times and generates ZERO astral and
// ZERO U+E000..U+FFFF characters.
//
// THE ORACLE IS DERIVED INDEPENDENTLY, not by calling the engine's own comparator: `Array.from`
// iterates a string by code point, so sorting on those is a second derivation of the contract
// rather than a restatement of the implementation.
//
// Characters are built with `String.fromCodePoint`, never pasted — a literal astral char is
// invisible to `grep` and can be mangled by any tool that rewrites the file in the wrong encoding.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { order, toArray, traversal, V, values } from './index.js';

const ASTRAL = String.fromCodePoint(0x1f600); // U+1F600, surrogate pair D83D DE00
const BMP_HIGH = String.fromCodePoint(0xe000); // U+E000, one unit, numerically above D83D
const LONE_LOW = String.fromCodePoint(0xdc00); // unpaired LOW surrogate: no high surrogate present

/** Code-point order, derived from `Array.from`'s code-point iteration. */
const byCodePoint = (a: string, b: string): number => {
  const xs = Array.from(a);
  const ys = Array.from(b);
  const n = Math.min(xs.length, ys.length);

  for (let i = 0; i < n; i += 1) {
    const x = xs[i].codePointAt(0) as number;
    const y = ys[i].codePointAt(0) as number;

    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  if (xs.length === ys.length) {
    return 0;
  }

  return xs.length < ys.length ? -1 : 1;
};

const graphOf = (vals: readonly string[]): Graph => {
  const g = new Graph();

  vals.forEach((v, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { s: v } });
  });

  return g;
};

const ordered = (vals: readonly string[]): unknown[] =>
  toArray(traversal(V(), values('s'), order()), graphOf(vals));

describe('gremlin string ordering', () => {
  // THE CRUX. With the bug present this returns the astral char BEFORE U+E000.
  test('orders an astral char AFTER a BMP char in U+E000..U+FFFF', () => {
    const vals = ['a', ASTRAL, BMP_HIGH, 'z'];
    const got = ordered(vals);

    expect(got).toEqual([...vals].sort(byCodePoint));
    expect(got.indexOf(BMP_HIGH)).toBeLessThan(got.indexOf(ASTRAL));
  });

  // The same question with nothing else in the column, so no other comparison can carry the result.
  test('orders the bare pair by code point', () => {
    expect(ordered([ASTRAL, BMP_HIGH])).toEqual([BMP_HIGH, ASTRAL]);
    expect(ordered([BMP_HIGH, ASTRAL])).toEqual([BMP_HIGH, ASTRAL]);
  });

  test('agrees with the code-point oracle on a mixed BMP and astral column', () => {
    const vals = [
      'apple',
      ASTRAL,
      BMP_HIGH,
      String.fromCodePoint(0x1f601),
      String.fromCodePoint(0xffff),
      'Zebra',
      '',
      String.fromCodePoint(0x4e2d),
    ];

    expect(ordered(vals)).toEqual([...vals].sort(byCodePoint));
  });

  // A lone LOW surrogate has no high surrogate, so code units and code points agree on it; this
  // pins that the guard being HIGH-surrogate-only is not a gap.
  test('orders a lone LOW surrogate the same under either reading', () => {
    expect(ordered(['a', LONE_LOW, 'z'])).toEqual(['a', 'z', LONE_LOW]);
  });

  // Plain ASCII must be untouched by the change — the overwhelmingly common case.
  test('leaves an ASCII column alone', () => {
    const vals = ['pear', 'Apple', 'apple', 'banana', '', 'Zebra'];

    expect(ordered(vals)).toEqual([...vals].sort(byCodePoint));
  });

  // Gremlin sorts nulls FIRST (TinkerPop's Orderability), which is a LANGUAGE contract and must not
  // have moved: the fix touched the same-type string arm, not the null arm.
  test('still sorts a missing property first', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { s: BMP_HIGH } });
    g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    g.addVertex({ id: 'c', labels: ['P'], properties: { s: ASTRAL } });

    expect(toArray(traversal(V(), values('s'), order()), g)).toEqual([BMP_HIGH, ASTRAL]);
  });
});
