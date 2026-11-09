// The ORDER BY comparator specialization (item 1711): which columns it admits, and that an admitted
// column sorts exactly as the untouched `compareSort` would have sorted it.
//
// THE CRUX CASE IS A COLUMN WHERE CODE-UNIT AND CODE-POINT ORDER DISAGREE, because that is the one
// input where the reduced comparator would be WRONG rather than merely different. `''` is code
// point 57344 and a single UTF-16 unit; `'😀'` is code point 128512 whose FIRST unit is 0xD83D =
// 55357. So a plain `<` ranks the emoji first and Rust's `str::cmp` ranks `` first — the exact
// disagreement `compareCodePoints` exists to resolve, and the reason the scan tests for surrogates at
// all. A specialization that admitted this column would return a correctly-sorted-looking result in
// the wrong order, which no count assertion could see.
//
// ⚠️ THE ORACLE IS AN INDEPENDENT DERIVATION, not a second call to the engine's comparator: the test
// sorts by code point using `[...s]` iteration, which yields code points by construction. Pinning the
// new branch to `compareSort` would pass even if both agreed on something wrong.
//
// ⚠️ ASTRAL CHARACTERS ARE BUILT WITH `String.fromCodePoint`, NOT PASTED. A literal astral char in a
// source file is invisible to `grep` and silently mangled by a tool that rewrites the file in the
// wrong encoding; this repo has been bitten by searching for the escape form while the file held the
// literal. The numeric form says exactly which code point is meant.
import { Graph } from '@lenke/core';
import { describe, expect, it } from 'vitest';

import type { Row } from './executor/core.js';
import { reducedRowComparator, sortColumnKind } from './executor/sort-column-specialize.js';
import { query } from './index.js';

const ASTRAL = String.fromCodePoint(0x1f600); // U+1F600, surrogate pair D83D DE00
const BMP_HIGH = String.fromCodePoint(0xe000); // U+E000, one unit, numerically above D83D
const LONE_LOW = String.fromCodePoint(0xdc00); // an unpaired LOW surrogate: no high surrogate present

const rowsOf = (col: string, values: readonly unknown[]): Row[] =>
  values.map((v) => ({ [col]: v }));

/** Code-point order, derived independently of the engine: `[...s]` iterates code points. */
const byCodePoint = (a: string, b: string): number => {
  // `Array.from` on a string iterates CODE POINTS, which is the whole point of this oracle. (The
  // spread form does the same thing and is what `no-misused-spread` flags -- a rule whose warning,
  // that spreading a string yields code points and splits nothing, is exactly the property wanted.)
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

describe('sortColumnKind', () => {
  it('admits a column of plain strings', () => {
    expect(sortColumnKind(rowsOf('s', ['b', 'a', 'c']), 's')).toBe('string');
  });

  // A NUMERIC column is deliberately NOT admitted: the arm was built, measured across six readings
  // (0.93x-1.18x, straddling 1.0) and dropped. This asserts the decision so re-adding it has to
  // come with a test change and therefore with a reason.
  it('declines a column of plain numbers', () => {
    expect(sortColumnKind(rowsOf('n', [3, 1, 2]), 'n')).toBe('generic');
  });

  it('declines a column holding an astral character', () => {
    expect(sortColumnKind(rowsOf('s', ['a', ASTRAL, 'b']), 's')).toBe('generic');
  });

  // The disagreement column itself. Both members are strings, so only the surrogate test can
  // decline it — this is the assertion that fails if that test is dropped.
  it('declines the column where code-unit and code-point order disagree', () => {
    expect(sortColumnKind(rowsOf('s', [BMP_HIGH, ASTRAL]), 's')).toBe('generic');
  });

  // Documents that the guard is HIGH-surrogate-only, and that this is correct: with no high
  // surrogate, `codePointAt` equals `charCodeAt` at every index and the slow path degenerates to the
  // same code-unit comparison a plain `<` performs.
  it('admits a string holding only a LONE LOW surrogate', () => {
    expect(sortColumnKind(rowsOf('s', ['a', LONE_LOW]), 's')).toBe('string');
  });

  it('declines a mixed-type column', () => {
    expect(sortColumnKind(rowsOf('v', ['a', 1]), 'v')).toBe('generic');
  });

  // The scan must not decide from row 0 alone. Each of these qualifies on its first value and is
  // disqualified by a later one.
  it.each([
    ['a later number in a string column', ['a', 'b', 7]],
    ['a later null', ['a', 'b', null]],
    ['a later undefined', ['a', 'b', undefined]],
    ['a later astral string', ['a', 'b', ASTRAL]],
  ])('declines on %s', (_label, values) => {
    expect(sortColumnKind(rowsOf('v', values), 'v')).toBe('generic');
  });

  it.each([
    ['null', [null, null]],
    ['undefined', [undefined, undefined]],
    ['NaN', [Number.NaN, 1]],
    ['numbers', [1, 2]],
    ['booleans', [true, false]],
    ['lists', [[1], [2]]],
    ['objects', [{ a: 1 }, { a: 2 }]],
  ])('declines a column of %s', (_label, values) => {
    expect(sortColumnKind(rowsOf('v', values), 'v')).toBe('generic');
  });

  it('declines an empty row set', () => {
    expect(sortColumnKind([], 's')).toBe('generic');
  });

  it('declines a column that is absent from the rows', () => {
    expect(sortColumnKind(rowsOf('other', ['a', 'b']), 's')).toBe('generic');
  });
});

describe('reducedRowComparator', () => {
  it('returns undefined for a generic column', () => {
    expect(reducedRowComparator('generic', 's', false)).toBeUndefined();
  });

  it('orders strings ascending', () => {
    const cmp = reducedRowComparator('string', 's', false) as (a: Row, b: Row) => number;

    expect(cmp({ s: 'a' }, { s: 'b' })).toBe(-1);
    expect(cmp({ s: 'b' }, { s: 'a' })).toBe(1);
    expect(cmp({ s: 'a' }, { s: 'a' })).toBe(0);
  });

  // Descending must NEGATE, not reverse-and-also-flip-ties: a tie stays 0 so V8's stable sort keeps
  // arrival order, which is what `compareSort(...) * -1` does.
  it('orders strings descending, keeping ties at 0', () => {
    const cmp = reducedRowComparator('string', 's', true) as (a: Row, b: Row) => number;

    expect(cmp({ s: 'a' }, { s: 'b' })).toBe(1);
    expect(cmp({ s: 'b' }, { s: 'a' })).toBe(-1);
    expect(cmp({ s: 'a' }, { s: 'a' })).toBe(0);
  });
});

describe('ORDER BY through the engine', () => {
  const graphOf = (values: readonly unknown[]): Graph => {
    const g = new Graph();

    values.forEach((v, i) => {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { v, i } });
    });

    return g;
  };

  const col = (values: readonly unknown[], q: string): unknown[] =>
    query(graphOf(values), q).map((r) => r.k);

  it('sorts an admitted string column in code-point order', () => {
    const values = ['pear', 'Apple', 'apple', 'banana', '', 'Zebra', 'apple pie'];

    expect(col(values, 'MATCH (n:P) RETURN n.v AS k ORDER BY k')).toEqual(
      [...values].sort(byCodePoint),
    );
  });

  // THE CRUX. If the scan admitted this column, the emoji would come first.
  it('sorts the disagreement column by code point, not code unit', () => {
    const values = ['a', ASTRAL, BMP_HIGH, 'z'];
    const got = col(values, 'MATCH (n:P) RETURN n.v AS k ORDER BY k');

    expect(got).toEqual([...values].sort(byCodePoint));
    expect(got.indexOf(BMP_HIGH)).toBeLessThan(got.indexOf(ASTRAL));
  });

  it('sorts an admitted string column descending', () => {
    const values = ['pear', 'apple', 'banana'];

    expect(col(values, 'MATCH (n:P) RETURN n.v AS k ORDER BY k DESC')).toEqual(
      [...values].sort(byCodePoint).reverse(),
    );
  });

  // Numeric columns take the generic comparator now, so this guards the DECLINED path's answer.
  it('sorts a numeric column through the generic comparator', () => {
    const values = [5, -2, 0, 11, 3];

    expect(col(values, 'MATCH (n:P) RETURN n.v AS k ORDER BY k')).toEqual([-2, 0, 3, 5, 11]);
  });

  // A declined column still has to behave: nulls last by default, and the surrounding values ordered.
  it('places nulls last in a column the scan declines', () => {
    const got = col([3, null, 1, null, 2], 'MATCH (n:P) RETURN n.v AS k ORDER BY k');

    expect(got).toEqual([1, 2, 3, null, null]);
  });

  it('places nulls first when asked, in a declined column', () => {
    const got = col([3, null, 1], 'MATCH (n:P) RETURN n.v AS k ORDER BY k NULLS FIRST');

    expect(got).toEqual([null, 1, 3]);
  });

  // NaN is reachable only through a projection, and it is the GREATEST value rather than an absolute
  // last — so a column computing it must decline and keep that order.
  it('keeps NaN greatest in a projected column', () => {
    const g = new Graph();

    for (const [i, v] of [4, -1, 9].entries()) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { v } });
    }

    const got = query(g, 'MATCH (n:P) RETURN sqrt(n.v) AS k ORDER BY k').map((r) => r.k);

    expect(got.slice(0, 2)).toEqual([2, 3]);
    expect(Number.isNaN(got[2])).toBe(true);
  });

  it('sorts a mixed-type column by type rank, which the scan declines', () => {
    const got = col(['s', 2, true, 1], 'MATCH (n:P) RETURN n.v AS k ORDER BY k');

    // Num < Str < Bool, the engine's cross-type total order.
    expect(got).toEqual([1, 2, 's', true]);
  });
});
