import { describe, expect, it } from 'bun:test';

/**
 * ITEM 1493 — the far-driven filtered hop count (`out(T).has(k, pred).count()`) stopped calling the
 * megamorphic `matches` for the one shape where that pays. 53.76 -> 48.87 ms over 200,000 vertices
 * at FANOUT 2 scattered, one shape per process, three rounds (1.10x), with two- and three-filter
 * chains, string `eq` and four controls all flat.
 *
 * ⚠️ THE ROUTE IS THE THING UNDER TEST, not the answer. Every shape below answers identically on
 * both routes — that is what makes the fast path legal and also what makes it invisible to the
 * 1,376 differential tests (`perf-gate-needs-its-own-test`). So `specializedRowTest` is exported
 * and its decisions are asserted directly.
 *
 * The decisions are not arbitrary: the wide version WAS built and measured, and widths 2 and 3
 * came back 0.98x and 0.88x — a closure over a chain has to be one closure, so at width w it pays
 * a wrapper call plus w closure calls against w `matches` calls, and only w = 1 wins. `eq` loses
 * for the mirror reason (a 2-call chain has less dispatch to remove than the wrapper costs). A
 * change that widens either bound would be a REGRESSION measured at 1.14x, so each bound has a
 * test naming its number.
 */
import { Graph } from '@lenke/core';

import { specializedRowTest } from './executor/count-shortcut.js';
import {
  V,
  between,
  count,
  eq,
  gt,
  gte,
  has,
  lt,
  lte,
  neq,
  out,
  toArray,
  traversal,
  within,
} from './index.js';
import { matches } from './predicates.js';

describe('which shapes the row test claims', () => {
  it('claims ONE ordering filter over a scalar — the measured 1.10x', () => {
    for (const make of [gt, gte, lt, lte]) {
      expect(specializedRowTest(['k'], [make(5)]), `${make.name}(number)`).toBeDefined();
      expect(specializedRowTest(['k'], [make('s')]), `${make.name}(string)`).toBeDefined();
    }
  });

  it('⚠️ DECLINES two and three filters — measured 0.98x and 0.88x, so widening is a regression', () => {
    expect(specializedRowTest(['a', 'b'], [gt(1), gt(2)])).toBeUndefined();
    expect(specializedRowTest(['a', 'b', 'c'], [gt(1), gt(2), gt(3)])).toBeUndefined();
    expect(specializedRowTest(['a', 'b', 'c', 'd'], [gt(1), gt(2), gt(3), gt(4)])).toBeUndefined();
  });

  it('⚠️ DECLINES eq/neq — measured 0.96x, a LOSS and not a smaller win', () => {
    expect(specializedRowTest(['k'], [eq(5)])).toBeUndefined();
    expect(specializedRowTest(['k'], [neq(5)])).toBeUndefined();
    expect(specializedRowTest(['k'], [eq('s')])).toBeUndefined();
  });

  it('declines an empty chain and the ops with no operator form', () => {
    expect(specializedRowTest([], [])).toBeUndefined();
    expect(specializedRowTest(['k'], [between(1, 2)])).toBeUndefined();
    expect(specializedRowTest(['k'], [within([1, 2])])).toBeUndefined();
  });

  it('declines an ordering filter whose operand has no operator form', () => {
    // A temporal operand: `specializePredicate` returns undefined for it (item 1491's comparison
    // rules do not reduce to `>`), so this must fall through even though the OP is admitted.
    expect(specializedRowTest(['d'], [gt({ '@date': '2020-01-01' })])).toBeUndefined();
    expect(specializedRowTest(['b'], [gt(true)])).toBeUndefined();
  });
});

describe('the claimed closure is EXACTLY the matches call it replaces', () => {
  const VALUES: readonly unknown[] = [
    undefined,
    null,
    0,
    -0,
    5,
    6,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    'r',
    's',
    't',
    true,
    [1],
    { k: 1 },
  ];

  for (const make of [gt, gte, lt, lte]) {
    for (const operand of [0, 5, Number.NaN, '', 's'] as const) {
      it(`${make.name}(${String(operand)}) over a bag agrees with matches`, () => {
        const pred = make(operand);
        const fn = specializedRowTest(['k'], [pred]);

        expect(fn).toBeDefined();

        for (const v of VALUES) {
          expect(fn?.({ k: v }), `value ${String(v)}`).toBe(matches(pred, v));
        }

        // And the ABSENT key, which the bag spells as a missing property rather than a stored
        // undefined — the shape a real vertex has when it lacks the key entirely.
        expect(fn?.({})).toBe(matches(pred, undefined));
      });
    }
  }

  it('reads the key it was given, not the first key of the bag', () => {
    const fn = specializedRowTest(['b'], [gt(5)]);

    expect(fn?.({ a: 100, b: 1 })).toBe(false);
    expect(fn?.({ a: 1, b: 100 })).toBe(true);
  });
});

describe('the traversal answers identically on both routes', () => {
  const g = new Graph();
  const ids: string[] = [];

  for (let i = 0; i < 40; i += 1) {
    ids.push(`v${i}`);
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { num: i, m: i % 3 } });
  }

  for (let e = 0; e < 80; e += 1) {
    const from = g.getVertexById(ids[e % 40]);
    const to = g.getVertexById(ids[(e * 7 + 1) % 40]);

    if (from === null || to === null) {
      throw new Error('fixture endpoint missing');
    }

    g.addEdge({ id: `e${e}`, labels: ['E'], from, to });
  }

  it('a one-filter hop count equals the count of the rows it would emit', () => {
    // The row-emitting spelling cannot take the count shortcut at all, so this compares the fast
    // route against the walk rather than against itself.
    for (const make of [gt, gte, lt, lte]) {
      const viaCount = toArray(traversal(V(), out('E'), has('num', make(20)), count()), g);
      const viaRows = toArray(traversal(V(), out('E'), has('num', make(20))), g);

      expect(viaCount, make.name).toEqual([viaRows.length]);
    }
  });

  it('the declined widths still answer correctly', () => {
    for (const [plan, name] of [
      [traversal(V(), out('E'), has('num', gt(20)), has('m', gt(0)), count()), 'two'],
      [traversal(V(), out('E'), has('num', gt(20)), has('m', eq(1)), count()), 'two-eq'],
    ] as const) {
      const rows = toArray(
        name === 'two'
          ? traversal(V(), out('E'), has('num', gt(20)), has('m', gt(0)))
          : traversal(V(), out('E'), has('num', gt(20)), has('m', eq(1))),
        g,
      );

      expect(toArray(plan, g), name).toEqual([rows.length]);
    }
  });

  it('a filter matching NOTHING and a filter matching EVERYTHING both agree', () => {
    expect(toArray(traversal(V(), out('E'), has('num', gt(1000)), count()), g)).toEqual([0]);
    expect(toArray(traversal(V(), out('E'), has('num', gte(0)), count()), g)).toEqual([80]);
  });

  it('a missing key matches nothing, as the walk does', () => {
    expect(toArray(traversal(V(), out('E'), has('nope', gt(0)), count()), g)).toEqual([0]);
    expect(toArray(traversal(V(), out('E'), has('nope', gt(0))), g)).toEqual([]);
  });
});
