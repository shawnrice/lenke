import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The tally built its group index as `Map<string, slot>` with `valueKey(raw)` as the key, so a
// bucket of 200,000 vertices with 90 distinct values built 200,000 STRINGS to find 90 slots —
// 50.7ns a vertex where the property read itself is 10.3ns. Keying the raw value where that is
// exact is 12.5ns, and the whole grouped tally went 9.13ms to 3.66ms (audit item 192).
//
// A raw-keyed `Map` is exactly `valueKey`'s equivalence FOR PRIMITIVES, because `Map` uses
// SameValueZero. Non-primitives keep `valueKey` in a second map, since two equal lists or
// records are different objects. So what these tests have to pin is:
//
//   - the two equivalences `valueKey` deliberately has (-0 with 0, NaN with itself);
//   - that types stay distinct, including a string that spells another type's valueKey text —
//     the collision the SECOND map exists to prevent;
//   - that non-primitives still group STRUCTURALLY;
//   - and FIRST-SEEN group order across BOTH maps, which no longer comes from a map's own
//     insertion order but from a shared slot list. A fixture that keeps primitives and objects
//     apart cannot see that, so the order tests interleave them.

const tally = (g: Graph): Array<[unknown, number]> =>
  (
    query(g, 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a') as Array<{
      a: unknown;
      c: number;
    }>
  ).map((r) => [r.a, r.c]);

const build = (values: unknown[]): Graph => {
  const g = new Graph();

  values.forEach((k, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: k === undefined ? {} : { k } });
  });

  return g;
};

describe('the tally groups on the raw value where that is exact', () => {
  test('-0 and 0 are ONE group', () => {
    expect(tally(build([0, -0, 0]))).toEqual([[0, 3]]);
  });

  test('NaN groups with itself', () => {
    // NaN is coerced to null on the write path, so these land in one group either way — what
    // matters is that they do not split, which is the rule `valueKey` spells `#NaN`.
    const rows = tally(build([Number.NaN, Number.NaN, 5]));

    expect(rows.length).toBe(2);
    expect(rows[0][1]).toBe(2);
  });

  test('Infinity groups with itself', () => {
    const rows = tally(build([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1]));

    expect(rows.length).toBe(2);
    expect(rows[0][1]).toBe(2);
  });

  test('a number, its decimal string, and a boolean are three groups', () => {
    expect(tally(build([1, '1', true]))).toEqual([
      [1, 1],
      ['1', 1],
      [true, 1],
    ]);
  });

  test('zero and false are two groups', () => {
    expect(tally(build([0, false]))).toEqual([
      [0, 1],
      [false, 1],
    ]);
  });

  test('a string that spells another type’s valueKey text stays apart', () => {
    // `valueKey(1)` is 'n1' and `valueKey(null)` is 'N'. Keying raw primitives in one map and
    // structural values in ANOTHER is what makes these safe: a single mixed map would have the
    // raw string 'n1' and the key text of the number 1 collide.
    expect(tally(build([1, 'n1', null, 'N', true, 'bT']))).toEqual([
      [1, 1],
      ['n1', 1],
      [null, 1],
      ['N', 1],
      [true, 1],
      ['bT', 1],
    ]);
  });

  test('a stored null, an absent key and the empty string', () => {
    expect(tally(build([null, undefined, '', null]))).toEqual([
      [null, 3],
      ['', 1],
    ]);
  });

  describe('non-primitives group STRUCTURALLY, not by identity', () => {
    test('two equal lists are one group', () => {
      const rows = tally(
        build([
          [1, 2],
          [1, 2],
          [2, 1],
        ]),
      );

      expect(rows.map((r) => r[1])).toEqual([2, 1]);
    });

    test('two equal maps are one group', () => {
      const rows = tally(build([{ a: 1 }, { a: 1 }, { a: 2 }]));

      expect(rows.map((r) => r[1])).toEqual([2, 1]);
    });

    test('an element-valued key groups by element id', () => {
      const g = new Graph();
      g.addVertex({ id: 'x', labels: ['P'], properties: {} });
      g.addVertex({ id: 'y', labels: ['P'], properties: {} });

      const rows = query(g, 'MATCH (n:P) LET a = n RETURN a, count(*) AS c GROUP BY a') as Array<{
        c: number;
      }>;

      expect(rows.map((r) => r.c)).toEqual([1, 1]);
    });
  });

  describe('FIRST-SEEN order across both maps', () => {
    test('a primitive, then an object, then a primitive', () => {
      // The order a single map could not produce: the slots are shared, so this is the true
      // first-seen order. Concatenating "all primitives then all objects" would answer
      // 1, 'x', [2] — and "objects then primitives" would answer [2], 1, 'x'.
      const rows = tally(build([1, [2], 1, [2], 'x']));

      expect(rows.map((r) => r[1])).toEqual([2, 2, 1]);
      expect(rows[0][0]).toBe(1);
      expect(rows[1][0]).toEqual([2]);
      expect(rows[2][0]).toBe('x');
    });

    test('an object FIRST, then primitives', () => {
      const rows = tally(build([[9], 'a', [9], 3]));

      expect(rows.map((r) => r[1])).toEqual([2, 1, 1]);
      expect(rows[0][0]).toEqual([9]);
      expect(rows[1][0]).toBe('a');
      expect(rows[2][0]).toBe(3);
    });

    test('order survives a sort being absent, which is the pinned contract', () => {
      expect(tally(build(['z', 'a', 'z', 'm']))).toEqual([
        ['z', 2],
        ['a', 1],
        ['m', 1],
      ]);
    });
  });

  test('the hop tally groups the same way — the second site', () => {
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['P'], properties: {} });
    const mk = (id: string, k: unknown) => {
      const f = h.addVertex({ id, labels: ['Q'], properties: { k } });
      h.addEdge({ from: s, to: f, labels: ['T'], properties: {} });
    };

    mk('f0', 0);
    mk('f1', -0);
    mk('f2', [7]);
    mk('f3', [7]);
    mk('f4', 'n0');

    const rows = query(
      h,
      'MATCH (x:P)-[:T]->(f) LET a = f.k RETURN a, count(*) AS c GROUP BY a',
    ) as Array<{ a: unknown; c: number }>;

    expect(rows.map((r) => r.c)).toEqual([2, 2, 1]);
    expect(rows[0].a).toBe(0);
    expect(rows[2].a).toBe('n0');
  });

  test('the counts are right with many groups and many members', () => {
    const vals: unknown[] = [];

    for (let i = 0; i < 300; i++) {
      vals.push(i % 7);
    }

    const rows = tally(build(vals));

    expect(rows.length).toBe(7);
    // 300 = 7*42 + 6, so keys 0..5 appear 43 times and key 6 appears 42.
    expect(rows.map((r) => r[1])).toEqual([43, 43, 43, 43, 43, 43, 42]);
  });
});
