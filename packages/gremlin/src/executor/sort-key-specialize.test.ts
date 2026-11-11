// The `order()` comparator specialization (item 1713): which key columns it admits, and that an
// admitted column sorts exactly as the untouched `compareTotal` would have sorted it.
//
// ⚠️ TWO ARMS BECAUSE `order()` HAS TWO SORT SITES, and that is the whole reason this module was
// nearly useless on arrival. `fusedProjectedOrder` sorts a FLAT array of values (the
// `values(k).order()` fusion) and `sortByBys` sorts `{ item, key }` WRAPPERS (the `order().by(...)`
// shapes). The first wiring covered only the wrapper site and the `values('s').order()` row did not
// move at all — a counter on every sort site showed the row entering the FUSED one and the
// wrapper arm's admit/decline counter never firing. So both arms are tested here, and the
// end-to-end cases below are picked so that each SITE is exercised by at least one of them.
//
// ⚠️ THE CRUX CASE IS A COLUMN WHERE CODE-UNIT AND CODE-POINT ORDER DISAGREE. `''` is code
// point 57344 in one UTF-16 unit; an astral char's FIRST unit is a high surrogate in
// 0xD800..0xDBFF, numerically LOWER. The reduced comparator is a plain `<`, so admitting such a
// column would silently restore the byte-identity break item 1712 fixed — correct-looking output in
// the wrong order, which no count assertion could see.
//
// Characters are built with `String.fromCodePoint`, never pasted: a literal astral char is invisible
// to `grep` and can be mangled by a tool that rewrites the file in the wrong encoding.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { Order, order, out, toArray, traversal, V, values } from '../index.js';
import {
  allPlainStringKeys,
  reducedKeyComparator,
  reducedValueComparator,
} from './sort-key-specialize.js';

const ASTRAL = String.fromCodePoint(0x1f600); // D83D DE00
const BMP_HIGH = String.fromCodePoint(0xe000); // one unit, numerically above D83D
const LONE_LOW = String.fromCodePoint(0xdc00); // unpaired LOW surrogate: no high surrogate

const keysOf = (xs: readonly unknown[]): { key: unknown }[] => xs.map((key) => ({ key }));

/** Code-point order, derived independently of the engine: `Array.from` iterates code points. */
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

/**
 * ⚠️ THE FLAT ARM'S CLASSIFICATION IS NO LONGER A FUNCTION, SO IT IS TESTED THROUGH `order()`
 * (item 1807). `allPlainStrings` scanned the column; the classification now rides
 * `fusedProjectedOrder`'s existing element-fault pass, which is what made the numeric arm free.
 * These are the same columns its unit test covered, asserted where the behaviour is observable —
 * and that is strictly better, because a unit test of the scanner could not have caught a wrong
 * comparator being SELECTED.
 */
describe('the FLAT arm, through order() — the columns the scanner used to classify', () => {
  /** One vertex per value, so `values('k').order()` sorts exactly this column. */
  const columnOf = (xs: readonly unknown[]): Graph => {
    const g = new Graph();

    for (const [i, k] of xs.entries()) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k } });
    }

    // One edge per vertex pair so `out('E')` is not needed: the shape below reads V() directly.
    return g;
  };

  const sortedColumn = (xs: readonly unknown[], desc = false): unknown[] =>
    toArray(traversal(V(), values('k'), desc ? order(Order.desc) : order()), columnOf(xs));

  test('a column of plain strings sorts by code point', () => {
    expect(sortedColumn(['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  // The disagreement column: both members are strings, so only the surrogate test can decline the
  // reduced comparator. If it is dropped, the reduced comparator's `<` gives code-UNIT order and
  // this assertion fails — which is item 1712's divergence, the whole reason the test exists.
  test('the column where code-unit and code-point order disagree', () => {
    expect(sortedColumn([BMP_HIGH, ASTRAL])).toEqual([BMP_HIGH, ASTRAL].sort(byCodePoint));
    expect(sortedColumn([ASTRAL, BMP_HIGH])).toEqual([BMP_HIGH, ASTRAL].sort(byCodePoint));
  });

  test('a column holding an astral character anywhere', () => {
    expect(sortedColumn(['a', ASTRAL, 'b'])).toEqual(['a', ASTRAL, 'b'].sort(byCodePoint));
  });

  // A LONE LOW surrogate is admitted rather than declined, and that is correct: with no HIGH
  // surrogate `codePointAt === charCodeAt` at every index, so code-point order IS code-unit order.
  test('a string holding only a lone LOW surrogate', () => {
    expect(sortedColumn(['a', LONE_LOW])).toEqual(['a', LONE_LOW].sort(byCodePoint));
  });

  // ⚠️ THE NUMERIC ARM, NEW AT ITEM 1807 and the reason the scan had to get cheaper.
  test('a column of plain numbers, both directions', () => {
    expect(sortedColumn([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sortedColumn([3, 1, 2], true)).toEqual([3, 2, 1]);
    expect(sortedColumn([-0, 0, -1, 1])).toEqual([-1, -0, 0, 1]);
  });

  // Each of these must FALL BACK to `compareTotal`, and each has an answer the reduced comparator
  // would get wrong: a null sorts FIRST, a NaN LAST, and a mixed column by type rank.
  test('a null in the column sorts FIRST, which the reduced comparator has no arm for', () => {
    expect(sortedColumn(['b', null, 'a'])).toEqual([null, 'a', 'b']);
    expect(sortedColumn([2, null, 1])).toEqual([null, 1, 2]);
  });

  test('a NaN sorts LAST by the engine total order', () => {
    const out = sortedColumn([2, Number.NaN, 1]) as number[];

    expect(out.slice(0, 2)).toEqual([1, 2]);
    expect(Number.isNaN(out[2])).toBe(true);
  });

  test('a mixed column orders by TYPE RANK, which is not the order I guessed', () => {
    // Numbers before strings, and BOOLEANS AFTER BOTH. I wrote `[true, 1, 'a']` first, on the
    // assumption that a boolean ranks lowest; `compareTotal`'s rank puts it last. Asserting the
    // engine's actual order rather than my model of it is the point of a black-box test.
    expect(sortedColumn(['a', 1])).toEqual([1, 'a']);
    expect(sortedColumn([true, 1, 'a'])).toEqual([1, 'a', true]);
  });

  test('a later disqualifying element still declines — the scan cannot stop at index 0', () => {
    expect(sortedColumn(['a', 'b', 7])).toEqual([7, 'a', 'b']);
    expect(sortedColumn(['a', 'b', null])).toEqual([null, 'a', 'b']);
  });

  test('an empty column', () => {
    expect(sortedColumn([])).toEqual([]);
  });
});

describe('allPlainStringKeys (the WRAPPER arm)', () => {
  test('admits plain string keys', () => {
    expect(allPlainStringKeys(keysOf(['b', 'a']))).toBe(true);
  });

  test('declines the disagreement pair', () => {
    expect(allPlainStringKeys(keysOf([BMP_HIGH, ASTRAL]))).toBe(false);
  });

  // Gremlin places nulls FIRST and the reduced comparator has no null arm, so a null key must
  // decline or the language contract would silently change.
  test.each([
    ['a null key', ['a', null]],
    ['an undefined key', ['a', undefined]],
    ['a numeric key', [1, 2]],
    ['a later astral key', ['a', ASTRAL]],
  ])('declines %s', (_label, xs) => {
    expect(allPlainStringKeys(keysOf(xs))).toBe(false);
  });

  test('declines an empty key set', () => {
    expect(allPlainStringKeys([])).toBe(false);
  });
});

describe('the reduced comparators', () => {
  // ⚠️ BOTH ARGUMENT ORDERS, AND A SURVIVING MUTANT IS WHY. The first draft asserted only
  // `desc('a', 'b') === 1`. Flipping the descending branch's `x > y` arm to `1` — a comparator that
  // returns 1 whichever way round the arguments come, i.e. no ordering at all — SURVIVED the whole
  // 2105-test suite, because that one assertion still held. A comparator needs both directions
  // asserted; checking one of them checks half a function.
  test('order flat values ascending, in both argument orders', () => {
    const asc = reducedValueComparator(false);

    expect(asc('a', 'b')).toBe(-1);
    expect(asc('b', 'a')).toBe(1);
  });

  test('order flat values descending, in both argument orders', () => {
    const desc = reducedValueComparator(true);

    expect(desc('a', 'b')).toBe(1);
    expect(desc('b', 'a')).toBe(-1);
  });

  test('order wrapper keys ascending, in both argument orders', () => {
    const asc = reducedKeyComparator(false);

    expect(asc({ key: 'a' }, { key: 'b' })).toBe(-1);
    expect(asc({ key: 'b' }, { key: 'a' })).toBe(1);
  });

  test('order wrapper keys descending, in both argument orders', () => {
    const desc = reducedKeyComparator(true);

    expect(desc({ key: 'a' }, { key: 'b' })).toBe(1);
    expect(desc({ key: 'b' }, { key: 'a' })).toBe(-1);
  });

  // A tie must stay 0 in BOTH directions, so `Array.prototype.sort` keeps arrival order — tie order
  // is observable and is compared against native. `-compareTotal(...)` has this property and a
  // comparator that flipped ties would not.
  test.each([
    ['flat ascending', reducedValueComparator(false)('x', 'x')],
    ['flat descending', reducedValueComparator(true)('x', 'x')],
  ])('keeps %s ties at 0', (_label, got) => {
    expect(got).toBe(0);
  });

  test('keeps wrapper ties at 0 in both directions', () => {
    expect(reducedKeyComparator(false)({ key: 'x' }, { key: 'x' })).toBe(0);
    expect(reducedKeyComparator(true)({ key: 'x' }, { key: 'x' })).toBe(0);
  });
});

describe('order() end to end', () => {
  const graphOf = (vals: readonly unknown[]): Graph => {
    const g = new Graph();

    vals.forEach((v, i) => {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { s: v } });
    });

    // One edge per vertex so `out('E')` reaches them, which is the shape the fused site serves.
    vals.forEach((_v, i) => {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById(`v${i}`) as never,
        to: g.getVertexById(`v${(i + 1) % vals.length}`) as never,
        labels: ['E'],
      });
    });

    return g;
  };

  // THE FUSED SITE: values(k).order().
  test('sorts an admitted string column by code point (fused site)', () => {
    const vals = ['pear', 'Apple', 'apple', 'banana', '', 'Zebra'];

    expect(toArray(traversal(V(), values('s'), order()), graphOf(vals))).toEqual(
      [...vals].sort(byCodePoint),
    );
  });

  // THE CRUX at the fused site: the scan must decline and `compareTotal` must give code-point order.
  test('keeps code-point order on the disagreement column (fused site)', () => {
    const vals = ['a', ASTRAL, BMP_HIGH, 'z'];
    const got = toArray(traversal(V(), values('s'), order()), graphOf(vals)) as string[];

    expect(got).toEqual([...vals].sort(byCodePoint));
    expect(got.indexOf(BMP_HIGH)).toBeLessThan(got.indexOf(ASTRAL));
  });

  // THE WRAPPER SITE: order().by(key), which sorts elements and so cannot take the fused path.
  test('sorts by a string key through the wrapper site', () => {
    const vals = ['pear', 'apple', 'banana', 'Zebra'];
    const got = toArray(traversal(V(), order().by('s'), values('s')), graphOf(vals));

    expect(got).toEqual([...vals].sort(byCodePoint));
  });

  test('keeps code-point order on the disagreement column (wrapper site)', () => {
    const vals = ['a', ASTRAL, BMP_HIGH, 'z'];
    const got = toArray(traversal(V(), order().by('s'), values('s')), graphOf(vals)) as string[];

    expect(got).toEqual([...vals].sort(byCodePoint));
    expect(got.indexOf(BMP_HIGH)).toBeLessThan(got.indexOf(ASTRAL));
  });

  // A hop in front, which is what the bench rows do — the walk feeds the fused site a drained array
  // rather than a generator, and that is the path the 1.50x was measured on.
  test('sorts a hopped string column by code point', () => {
    const vals = ['m', 'b', 'z', 'a'];
    const got = toArray(traversal(V(), out('E'), values('s'), order()), graphOf(vals));

    expect(got).toEqual([...vals].sort(byCodePoint));
  });

  // DESCENDING, END TO END, at both sites. Every other case here is ascending, so the descending
  // branch of each reduced comparator had no engine-level coverage at all.
  test('sorts an admitted string column DESCENDING (fused site)', () => {
    const vals = ['pear', 'apple', 'banana', 'Zebra'];
    const got = toArray(traversal(V(), values('s'), order().by(Order.desc)), graphOf(vals));

    expect(got).toEqual([...vals].sort(byCodePoint).reverse());
  });

  test('sorts by a string key DESCENDING (wrapper site)', () => {
    const vals = ['pear', 'apple', 'banana', 'Zebra'];
    const got = toArray(traversal(V(), order().by('s', Order.desc), values('s')), graphOf(vals));

    expect(got).toEqual([...vals].sort(byCodePoint).reverse());
  });

  // Nulls FIRST is Gremlin's contract and the specialization must not touch it: a stored null makes
  // the column decline, and the generic comparator then places it.
  test('still sorts a stored null first', () => {
    const got = toArray(traversal(V(), values('s'), order()), graphOf(['b', null, 'a']));

    expect(got).toEqual([null, 'a', 'b']);
  });

  test('sorts a numeric column, which the scan declines', () => {
    const got = toArray(traversal(V(), values('s'), order()), graphOf([3, 1, 2]));

    expect(got).toEqual([1, 2, 3]);
  });
});
