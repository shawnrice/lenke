import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1886: `distinctRows` keys a TWO-COLUMN row through a nested key space instead of building a
 * `\x01`-joined string through `rowKeyOf`. **2.40x at low cardinality, 1.68x in the middle, 1.28x
 * when every row is distinct** (`distinct2-ab-1886.mjs`, a kill-switch A/B at three cardinalities).
 *
 * EVERY TEST HERE IS A SEMANTIC EQUIVALENCE, not a speed check — `distinct-rows-one-column.test.ts`
 * is the same file one width down, and its reasoning carries over verbatim: a value key space and a
 * string key space can disagree on numeric edge cases (`-0`, `NaN`), on types that stringify alike
 * (`5` vs `'5'`), and on a string that happens to look like another kind's key (`'@v1'` vs a vertex
 * with id `v1`).
 *
 * AND EACH OF THOSE IS TESTED IN **BOTH POSITIONS**, which is the new risk this width adds. The
 * first column picks a bucket and the second keys inside it, so a collision confined to one
 * position would pass a test that only varied the other. Items 1561 and 1562 each found a silent
 * answer change in this area; `newOneColumnKeys`' own note says a second keyer "would be the
 * third", which is why the second column goes through `addOneColumnKey` unchanged and the first
 * reproduces its two spaces as two maps.
 */
const g = (): Graph => {
  const graph = new Graph();

  graph.addVertex({
    id: 'v1',
    labels: ['P'],
    properties: { k: 1, tag: '@v1', s: '5', n: 5, z: 0, neg: -0, nan: Number.NaN, nul: null },
  });
  graph.addVertex({
    id: 'v2',
    labels: ['P'],
    properties: { k: 2, tag: '@v2', s: '6', n: 6, z: 0, neg: -0, nan: Number.NaN, nul: null },
  });

  return graph;
};

const rowsOf = (q: string): readonly Record<string, unknown>[] => query(g(), q);

describe('two-column DISTINCT keeps the string key space equivalence classes', () => {
  test('duplicate pairs collapse and distinct pairs survive', () => {
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.k AS a, n.s AS b').length).toBe(2);
    // Both rows share `z`, so keying on the pair must leave exactly one row per distinct `k`.
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.z AS a, n.z AS b').length).toBe(1);
  });

  test('a number and the STRING of that number stay apart — in EITHER position', () => {
    // `n` is 5 and `s` is '5' on the same vertex. The pair (5, '5') and the pair ('5', 5) are
    // different rows, and a key space that stringified without a type prefix would merge each with
    // itself across the two sides of the UNION.
    const first = rowsOf(
      'MATCH (n:P) RETURN n.n AS a, n.k AS b UNION MATCH (n:P) RETURN n.s AS a, n.k AS b',
    );

    expect(first.length).toBe(4);

    const second = rowsOf(
      'MATCH (n:P) RETURN n.k AS a, n.n AS b UNION MATCH (n:P) RETURN n.k AS a, n.s AS b',
    );

    expect(second.length).toBe(4);
  });

  test('a STRING that looks like an element key does NOT collide with the element — position 1', () => {
    // THE CASE FOR TWO MAPS AT THE FIRST POSITION. An element keys as `@<id>`, so the string `'@v1'`
    // and the vertex `v1` would select the SAME bucket in one shared map, and these two rows would
    // collapse to one.
    const rows = rowsOf(
      'MATCH (n:P) RETURN n.tag AS a, n.k AS b UNION MATCH (n:P) RETURN n AS a, n.k AS b',
    );

    expect(rows.length).toBe(4);
  });

  test('and does NOT collide at position 2 either', () => {
    const rows = rowsOf(
      'MATCH (n:P) RETURN n.k AS a, n.tag AS b UNION MATCH (n:P) RETURN n.k AS a, n AS b',
    );

    expect(rows.length).toBe(4);
  });

  test('`0` and `-0` are ONE key, in either position — SameValueZero, as `valueKey` has it', () => {
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.z AS a, n.k AS b').length).toBe(2);
    // The two columns hold `0` and `-0`; they must key as the same pair, so one row per vertex.
    expect(
      rowsOf('MATCH (n:P) RETURN n.z AS a, n.k AS b UNION MATCH (n:P) RETURN n.neg AS a, n.k AS b')
        .length,
    ).toBe(2);
    expect(
      rowsOf('MATCH (n:P) RETURN n.k AS a, n.z AS b UNION MATCH (n:P) RETURN n.k AS a, n.neg AS b')
        .length,
    ).toBe(2);
  });

  test('NaN equals ITSELF as a key, in either position', () => {
    // `valueKey` maps NaN to `#NaN` and a `Map`/`Set` has NaN equal to itself (SameValueZero), so
    // the two spaces agree — but only if NaN actually reaches the keyer, which item 1561 nearly
    // missed because `JSON.stringify(NaN)` is the string `null`.
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.nan AS a, n.nan AS b').length).toBe(1);
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.nan AS a, n.k AS b').length).toBe(2);
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.k AS a, n.nan AS b').length).toBe(2);
  });

  test('`null` is a key like any other, in either position', () => {
    // `null` is a stored, present value in this engine (not an absence), so it keys.
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.nul AS a, n.nul AS b').length).toBe(1);
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.nul AS a, n.k AS b').length).toBe(2);
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.k AS a, n.nul AS b').length).toBe(2);
  });

  test('an ELEMENT keys by id, not by object identity — in either position', () => {
    // Two rows can hold different instances for one id. `valueKey` maps both to `@v1`, so the pair
    // must collapse; a key space using object identity would keep both.
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n AS a, n.k AS b').length).toBe(2);
    expect(
      rowsOf('MATCH (n:P) RETURN n AS a, n.k AS b UNION MATCH (n:P) RETURN n AS a, n.k AS b')
        .length,
    ).toBe(2);
    expect(
      rowsOf('MATCH (n:P) RETURN n.k AS a, n AS b UNION MATCH (n:P) RETURN n.k AS a, n AS b')
        .length,
    ).toBe(2);
  });

  test('POSITIONAL, not by name — differently-aliased sides are the same row', () => {
    // ISO set operations compare positionally and the right side aliases differently here. Reading
    // the names once from `rows[0]` would look up `a`/`b` on a row that has `x`/`y` and read
    // `undefined` twice, collapsing the whole right side into one row.
    const rows = rowsOf(
      'MATCH (n:P) RETURN n.k AS a, n.s AS b UNION MATCH (n:P) RETURN n.k AS x, n.s AS y',
    );

    expect(rows.length).toBe(2);
  });

  /**
   * THE DISCRIMINATING THREE-COLUMN CASE, and the first version of this test was VACUOUS without
   * it. A mutant widening the width test to `isWidth(rows, 2) || isWidth(rows, 3)` — so three-column
   * rows key on their first two columns — SURVIVED `RETURN DISTINCT n.k, n.s, n.n`, because those
   * rows already differ in column 1. The rows have to AGREE on the first two columns and differ only
   * in the third, which is what `n.z, n.z, n.k` gives: `(0, 0, 1)` and `(0, 0, 2)`.
   */
  test('THREE columns are keyed on all three — rows differing only in column 3 survive', () => {
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.z AS a, n.z AS b, n.k AS c').length).toBe(2);
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.k AS a, n.s AS b, n.n AS c').length).toBe(2);
    expect(rowsOf('MATCH (n:P) RETURN DISTINCT n.z AS a, n.z AS b, n.z AS c').length).toBe(1);
  });

  /**
   * AND THE SET-OP PROBE MUST READ BOTH COLUMNS, which the identical-sides tests below cannot
   * see. These pairs AGREE on the first column and differ in the second, so a probe that stopped at
   * the bucket would call them equal.
   */
  test('EXCEPT and INTERSECT probe the PAIR, not just the first column', () => {
    // Left pairs: (0, 1) and (0, 2) — same first column. Right holds only (0, 1).
    expect(
      rowsOf(
        'MATCH (n:P) RETURN n.z AS a, n.k AS b EXCEPT MATCH (n:P) WHERE n.k = 1 RETURN n.z AS a, n.k AS b',
      ),
    ).toStrictEqual([{ a: 0, b: 2 }]);
    expect(
      rowsOf(
        'MATCH (n:P) RETURN n.z AS a, n.k AS b INTERSECT MATCH (n:P) WHERE n.k = 1 RETURN n.z AS a, n.k AS b',
      ),
    ).toStrictEqual([{ a: 0, b: 1 }]);
  });

  test('EXCEPT and INTERSECT over two columns agree with the string key space', () => {
    expect(
      rowsOf(
        'MATCH (n:P) RETURN n.k AS a, n.s AS b EXCEPT MATCH (n:P) WHERE n.k = 1 RETURN n.k AS a, n.s AS b',
      ).length,
    ).toBe(1);
    expect(
      rowsOf(
        'MATCH (n:P) RETURN n.k AS a, n.s AS b INTERSECT MATCH (n:P) WHERE n.k = 1 RETURN n.k AS a, n.s AS b',
      ).length,
    ).toBe(1);
  });
});
