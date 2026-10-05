import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The dedup walk kept its seen-values in a `Map<string, Row>` keyed by `valueKey(value)`, so a
// bucket of 200,000 vertices built 200,000 STRINGS to find the handful of distinct values the
// query returns — the same 40ns-of-50ns the tally paid in item 192. A `valueSet` keyed on the raw
// value where that is exact takes `RETURN DISTINCT n.age ORDER BY a` from 14.68ms to 5.28ms
// (audit item 193).
//
// Two things change observably and both are pinned here:
//
//   - the EQUIVALENCE must stay `valueKey`'s, which for primitives is what a raw-keyed `Set`
//     already gives (SameValueZero: `-0` with `0`, `NaN` with itself, types distinct);
//   - the ROW ORDER is now the order rows were PUSHED rather than a map's insertion order. They
//     agree — both are first-seen — but only a fixture that INTERLEAVES primitive and object
//     values can tell a shared order from a per-container one.

const distinct = (g: Graph): unknown[] =>
  (query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS a') as Array<{ a: unknown }>).map((r) => r.a);

const build = (values: unknown[]): Graph => {
  const g = new Graph();

  values.forEach((k, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: k === undefined ? {} : { k } });
  });

  return g;
};

describe('the dedup walk keys on the raw value where that is exact', () => {
  test('-0 and 0 are ONE value', () => {
    expect(distinct(build([0, -0, 0]))).toEqual([0]);
  });

  test('NaN dedups with itself', () => {
    const out = distinct(build([Number.NaN, Number.NaN, 5]));

    // NaN is coerced to null on the write path, so these are one value either way — the point is
    // that they do not split, which is the rule `valueKey` spells `#NaN`.
    expect(out.length).toBe(2);
  });

  test('Infinity dedups with itself', () => {
    expect(distinct(build([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1])).length).toBe(2);
  });

  test('a number, its decimal string and a boolean are three values', () => {
    expect(distinct(build([1, '1', true]))).toEqual([1, '1', true]);
  });

  test('zero and false are two values', () => {
    expect(distinct(build([0, false]))).toEqual([0, false]);
  });

  test('a string that spells another type’s valueKey text stays apart', () => {
    // The collision the SECOND container exists to prevent: a raw string 'n1' and `valueKey(1)`
    // are the same string, so one mixed container would fold these together.
    expect(distinct(build([1, 'n1', null, 'N', true, 'bT']))).toEqual([
      1,
      'n1',
      null,
      'N',
      true,
      'bT',
    ]);
  });

  test('a stored null, an absent key and the empty string', () => {
    expect(distinct(build([null, undefined, '', null]))).toEqual([null, '']);
  });

  describe('non-primitives dedup STRUCTURALLY, not by identity', () => {
    test('two equal lists are one value', () => {
      expect(
        distinct(
          build([
            [1, 2],
            [1, 2],
            [2, 1],
          ]),
        ),
      ).toEqual([
        [1, 2],
        [2, 1],
      ]);
    });

    test('two equal maps are one value', () => {
      expect(distinct(build([{ a: 1 }, { a: 1 }, { a: 2 }])).length).toBe(2);
    });

    test('elements dedup by id', () => {
      const g = new Graph();
      g.addVertex({ id: 'x', labels: ['P'], properties: {} });
      g.addVertex({ id: 'y', labels: ['P'], properties: {} });

      const rows = query(g, 'MATCH (n:P) RETURN DISTINCT n AS a') as Array<{ a: { id: string } }>;

      expect(rows.map((r) => r.a.id)).toEqual(['x', 'y']);
    });
  });

  describe('FIRST-SEEN order across both containers', () => {
    test('a primitive, then an object, then a primitive', () => {
      // The order a per-container concatenation could not produce: "primitives then objects"
      // would answer 1, 'x', [2] and the reverse would answer [2], 1, 'x'.
      expect(distinct(build([1, [2], 1, [2], 'x']))).toEqual([1, [2], 'x']);
    });

    test('an object FIRST, then primitives', () => {
      expect(distinct(build([[9], 'a', [9], 3]))).toEqual([[9], 'a', 3]);
    });

    test('the walk order is preserved with no sort, which is the pinned contract', () => {
      expect(distinct(build(['z', 'a', 'z', 'm']))).toEqual(['z', 'a', 'm']);
    });
  });

  test('a sort still orders the pushed rows', () => {
    const g = build([20, 10, 20, 30]);

    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS a ORDER BY a')).toEqual([
      { a: 10 },
      { a: 20 },
      { a: 30 },
    ]);
  });

  test('a window still pages the sorted rows', () => {
    const g = build([20, 10, 20, 30]);

    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS a ORDER BY a LIMIT 2')).toEqual([
      { a: 10 },
      { a: 20 },
    ]);
  });

  test('a hop keyed on the far end dedups the same way', () => {
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

    const rows = query(h, 'MATCH (x:P)-[:T]->(f) RETURN DISTINCT f.k AS a ORDER BY a') as Array<{
      a: unknown;
    }>;

    // Three distinct values: 0 (with -0), the list, and the string 'n0'.
    expect(rows.length).toBe(3);
  });

  test('many values, all kept, in walk order', () => {
    const vals: unknown[] = [];

    for (let i = 0; i < 300; i++) {
      vals.push(i % 7);
    }

    expect(distinct(build(vals))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
