/**
 * `values(k)` fused with a CAPPED `order()` — the top-k over a property stream (item 1591).
 *
 * **1.12x**, 3.208 to 2.854 ms over 50,000 vertices, measured as an asserted A/B with tight
 * non-overlapping ranges and every control flat (including a broad `bench:gremlin` sweep). ⚠️ That
 * is a MODEST win and the judgement is recorded rather than dressed up: item 1587 refused 1.09x,
 * and the difference here is that the ranges do not overlap and nothing unrelated moved.
 *
 * ⚠️ THE ORACLE IS THE UNCAPPED SPELLING. `V().values(k).order()` sorts the whole stream through
 * `sortByBys` — a different function from the capped `streamTopByBys` — so slicing its result is an
 * independent answer to the same question, not the code under test. Every ordering case below is
 * checked that way as well as against a literal.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { Order, V, limit, order, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { fusableValuesTopK } from './aggregation.js';
import { toArray } from './index.js';

const graphOf = (ks: readonly unknown[]): Graph => {
  const g = new Graph();

  for (const [i, k] of ks.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: k === undefined ? { other: i } : { k, other: i },
    });
  }

  return g;
};

// ⚠️ `order().by(Order.desc)` — the COMPARATOR-ONLY form, with the token as the FIRST argument.
// My first draft wrote `order().by(undefined, 'desc')`, which silently sorts ASCENDING: `[5,1,3]`
// came back `[1,3,5]` instead of `[5,3,1]`. Every descending assertion then passed VACUOUSLY,
// because the oracle below used the same wrong spelling and both arms were ascending — an oracle
// that shares the test's bug proves nothing. Only a LITERAL expectation caught it.
const topK = (g: Graph, n: number, desc = false): unknown[] =>
  toArray(traversal(V(), values('k'), desc ? order().by(Order.desc) : order(), limit(n)), g);

/** The independent answer: sort everything, then slice. */
const oracle = (g: Graph, n: number, desc = false): unknown[] =>
  toArray(traversal(V(), values('k'), desc ? order().by(Order.desc) : order()), g).slice(0, n);

describe('the capped order returns the same top-k as sorting and slicing', () => {
  const FIXTURES: Array<readonly [string, readonly unknown[]]> = [
    ['distinct numbers', [5, 3, 9, 1, 7, 2]],
    ['many TIES', [2, 1, 2, 1, 2, 1, 3]],
    ['all equal', [4, 4, 4, 4]],
    ['negatives and zero', [-3, 0, 2, -7, 5]],
    ['a present NULL among numbers', [3, null, 1, null, 5]],
    ['a MISSING key among numbers', [3, undefined, 1, undefined, 5]],
    ['strings', ['pear', 'apple', 'fig', 'date']],
    ['one element', [42]],
    ['no vertices', []],
  ];

  for (const [name, ks] of FIXTURES) {
    for (const n of [1, 3, 100]) {
      test(`${name}, limit ${n}`, () => {
        const g = graphOf(ks);

        expect(topK(g, n)).toEqual(oracle(g, n));
        expect(topK(g, n, true)).toEqual(oracle(g, n, true));
      });
    }
  }

  test('a cap LARGER than the stream returns everything, in order', () => {
    const g = graphOf([5, 1, 3]);

    expect(topK(g, 100)).toEqual([1, 3, 5]);
  });

  test('a MISSING key contributes nothing; a present NULL sorts FIRST', () => {
    // Gremlin's comparator is nulls-first (verbatim from `GremlinValueComparator.ORDERABILITY`),
    // which is the opposite of GQL's — the two languages do not have to agree here and must not.
    const g = graphOf([3, null, 1, undefined]);

    // Three values reach the sort (the missing key emits nothing), null leading.
    expect(topK(g, 3)).toEqual([null, 1, 3]);
    expect(topK(g, 1)).toEqual([null]);
    // Descending puts it last.
    expect(topK(g, 3, true)).toEqual([3, 1, null]);
  });

  test('ties are stable on ARRIVAL, so the result is deterministic', () => {
    const g = graphOf([2, 1, 2, 1]);

    expect(topK(g, 2)).toEqual([1, 1]);
    expect(topK(g, 4)).toEqual([1, 1, 2, 2]);
    // Values are indistinguishable once projected, so WHICH vertex supplied each is unobservable —
    // the reason this fusion needs no tie-order argument of its own.
    expect(topK(g, 4)).toEqual(oracle(g, 4));
  });
});

describe('the GATE — a route choice, so it needs its own test', () => {
  const vals1 = { kind: 'values', keys: ['k'] } as const;

  test('a capped global bare order is the shape', () => {
    expect(fusableValuesTopK(vals1, { kind: 'order', cap: 10 })).toEqual({
      key: 'k',
      desc: false,
      cap: 10,
    });
    expect(fusableValuesTopK(vals1, { kind: 'order', cap: 5, desc: true })).toEqual({
      key: 'k',
      desc: true,
      cap: 5,
    });
  });

  test('an UNCAPPED order declines — there is nothing to bound', () => {
    // Without a cap the sort must see everything, so the fusion would have to materialise, which
    // is exactly what it exists to avoid.
    expect(fusableValuesTopK(vals1, { kind: 'order' })).toBeUndefined();
  });

  test('⚠️ ONE IDENTITY by IS admitted — it carries the DESCENDING spelling', () => {
    // `order().by(Order.desc)` arrives as `bys: [{kind:'identity', direction:'desc'}]`, NOT as
    // `desc: true`. The first version of this gate refused any `bys`, which made the fused step's
    // `desc` parameter dead code and sent the descending form down the unfused path while these
    // tests appeared to cover it.
    expect(
      fusableValuesTopK(vals1, { kind: 'order', cap: 10, bys: [{ kind: 'identity' }] }),
    ).toEqual({ key: 'k', desc: false, cap: 10 });
    expect(
      fusableValuesTopK(vals1, {
        kind: 'order',
        cap: 10,
        bys: [{ kind: 'identity', direction: 'desc' }],
      }),
    ).toEqual({ key: 'k', desc: true, cap: 10 });
    // An explicit ascending direction too, so the mapping is not just "any direction means desc".
    expect(
      fusableValuesTopK(vals1, {
        kind: 'order',
        cap: 10,
        bys: [{ kind: 'identity', direction: 'asc' }],
      }),
    ).toEqual({ key: 'k', desc: false, cap: 10 });
  });

  test('a by of any OTHER kind declines — it projects a different sort key', () => {
    expect(
      fusableValuesTopK(vals1, { kind: 'order', cap: 10, bys: [{ kind: 'key', key: 'j' }] }),
    ).toBeUndefined();
    // Two bys is a compound sort, not this shape.
    expect(
      fusableValuesTopK(vals1, {
        kind: 'order',
        cap: 10,
        bys: [{ kind: 'identity' }, { kind: 'identity' }],
      }),
    ).toBeUndefined();
  });

  test('a legacy `key` declines — the sort key is projected, not the value', () => {
    expect(fusableValuesTopK(vals1, { kind: 'order', cap: 10, key: 'k' })).toBeUndefined();
  });

  test('a LOCAL scope declines — that sorts within each value, not across the stream', () => {
    expect(fusableValuesTopK(vals1, { kind: 'order', cap: 10, scope: 'local' })).toBeUndefined();
  });

  test('a MULTI-KEY values declines — one row PER KEY is a different stream', () => {
    expect(
      fusableValuesTopK({ kind: 'values', keys: ['k', 'j'] }, { kind: 'order', cap: 10 }),
    ).toBeUndefined();
  });

  test('a non-values first step, or no next step, declines', () => {
    expect(fusableValuesTopK({ kind: 'hasKey', keys: ['k'] }, { kind: 'order', cap: 10 })).toBe(
      undefined,
    );
    expect(fusableValuesTopK(vals1, undefined)).toBeUndefined();
    expect(fusableValuesTopK(vals1, { kind: 'count' })).toBeUndefined();
  });
});

describe('the shapes around the fusion still answer correctly', () => {
  test('an uncapped order still sorts everything', () => {
    const g = graphOf([5, 1, 3]);

    expect(toArray(traversal(V(), values('k'), order()), g)).toEqual([1, 3, 5]);
  });

  test('a multi-key values with a cap still answers', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 5, j: 2 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1, j: 9 } });

    // Four values across the two keys; the two smallest are 1 and 2.
    expect(toArray(traversal(V(), values('k', 'j'), order(), limit(2)), g)).toEqual([1, 2]);
  });

  test('a step AFTER the capped order still runs', () => {
    const g = graphOf([5, 1, 3, 9]);

    expect(toArray(traversal(V(), values('k'), order(), limit(3), limit(2)), g)).toEqual([1, 3]);
  });
});
