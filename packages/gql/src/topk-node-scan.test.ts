/**
 * Item 1064: selecting the top `cap` DURING the scan, instead of projecting every row first.
 *
 * `detectNodeProjection` already served a windowed sort — it projected a `Row` for every surviving
 * vertex and handed all of them to `sortRowsByColumns`, whose heap selected `cap`. Over 200,000
 * vertices that is 200,000 row objects to emit ten.
 *
 * WHY THESE TESTS LOOK LIKE THIS. The route choice is ANSWER-EQUIVALENT: both arms return the same
 * rows in the same order, so a mutant that flips a condition survives every differential test. That
 * is `perf-gate-needs-its-own-test`, so the admission rule is the pure function `topKPlan` and it is
 * unit-tested directly; the behavioural tests then pin the thing the selection CAN get wrong, which
 * is TIE ORDER — observable between the engines (item 605), and the reason `boundedTopKeyed` carries
 * an arrival-index tiebreak.
 *
 * Every expected value was confirmed against the NATIVE engine first (20 arms, all agreeing).
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { heapBeatsSort, topKPlan } from './executor/shortcuts.ts';
import { query } from './index.ts';

/**
 * 320 vertices in 3 tie groups on `k`, each with a distinct `s` and `n`.
 *
 * THE SIZE IS LOAD-BEARING. `heapBeatsSort` admits the selection only while `cap * 16 <= rows`, so
 * at 30 vertices a `LIMIT 5` took the sort-and-slice branch and the heap was never executed —
 * every test passed and SIX mutants survived, including the arrival tiebreak and the whole
 * direction/NULLS comparison. Mutation caught what agreement could not: a fixture that cannot
 * reach the code under test reads as a clean result. 320 keeps `LIMIT 5` (80 <= 320) and
 * `SKIP 3 LIMIT 4` (112 <= 320) on the heap.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 320; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 3, s: `s${i}`, n: i, u: i % 2 === 0 ? null : i },
    });
  }

  return g;
};

describe('topKPlan — the admission rule, tested as a function', () => {
  const sorts = [{ col: 'c', descending: false, nullsFirst: undefined }];

  it('admits a window whose single key is a direct property read', () => {
    expect(topKPlan({ sorts, skip: 0, limit: 10 }, ['c'], ['k'])?.keyProps).toEqual(['k']);
  });

  it('admits a SKIP alongside the limit, and carries both', () => {
    const got = topKPlan({ sorts, skip: 3, limit: 10 }, ['c'], ['k']);

    expect(got?.plan.skip).toBe(3);
    expect(got?.plan.limit).toBe(10);
  });

  it('declines with NO limit — there is no cap to select', () => {
    expect(topKPlan({ sorts, skip: 0, limit: undefined }, ['c'], ['k'])).toBeUndefined();
  });

  it('declines when no sort key is given', () => {
    expect(topKPlan({ sorts: [], skip: 0, limit: 10 }, ['c'], ['k'])).toBeUndefined();
  });

  it('declines when the key column is not a direct property read', () => {
    // `undefined` in `directKeys` means the item is an expression, so there is no property to read
    // off the vertex and the selection cannot key on it.
    expect(topKPlan({ sorts, skip: 0, limit: 10 }, ['c'], [undefined])).toBeUndefined();
  });

  it('declines when ONE of several keys is not a direct read', () => {
    const two = [
      { col: 'c', descending: false, nullsFirst: undefined },
      { col: 'd', descending: true, nullsFirst: undefined },
    ];

    expect(topKPlan({ sorts: two, skip: 0, limit: 10 }, ['c', 'd'], ['k', 'n'])?.keyProps).toEqual([
      'k',
      'n',
    ]);
    expect(
      topKPlan({ sorts: two, skip: 0, limit: 10 }, ['c', 'd'], ['k', undefined]),
    ).toBeUndefined();
  });

  it('resolves each key to ITS OWN column, not by position', () => {
    // The sort keys need not be in the projection's order, and reading `directKeys` positionally
    // would silently key on the wrong property — a wrong ANSWER that no timing shows.
    const reversed = [{ col: 'd', descending: false, nullsFirst: undefined }];

    expect(
      topKPlan({ sorts: reversed, skip: 0, limit: 10 }, ['c', 'd'], ['k', 'n'])?.keyProps,
    ).toEqual(['n']);
  });
});

describe('heapBeatsSort — the crossover, tested as a function', () => {
  // Also answer-equivalent: above the crossover both arms return the same rows, so only these
  // assertions can see a flipped or re-tuned constant.
  it('admits a small cap against many rows', () => {
    expect(heapBeatsSort(10, 200_000)).toBe(true);
  });

  it('refuses a cap at the measured boundary and above', () => {
    // `* 16` exactly: 12,500 * 16 === 200,000 is admitted, one more is not.
    expect(heapBeatsSort(12_500, 200_000)).toBe(true);
    expect(heapBeatsSort(12_501, 200_000)).toBe(false);
  });

  it('refuses a cap at or above the row count', () => {
    expect(heapBeatsSort(200_000, 200_000)).toBe(false);
    expect(heapBeatsSort(5, 30)).toBe(false);
  });

  it('refuses an empty input, where there is nothing to select', () => {
    expect(heapBeatsSort(10, 0)).toBe(false);
  });
});

describe('the selection answers exactly what the full sort answers, ties included', () => {
  it('keeps the first members of a tie group, in arrival order', () => {
    expect(query(fixture(), 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c LIMIT 5')).toEqual([
      { c: 0, d: 's0' },
      { c: 0, d: 's3' },
      { c: 0, d: 's6' },
      { c: 0, d: 's9' },
      { c: 0, d: 's12' },
    ]);
  });

  it('DESC keeps the first members of the LAST group, still in arrival order', () => {
    expect(
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c DESC LIMIT 5'),
    ).toEqual([
      { c: 2, d: 's2' },
      { c: 2, d: 's5' },
      { c: 2, d: 's8' },
      { c: 2, d: 's11' },
      { c: 2, d: 's14' },
    ]);
  });

  it('a SKIP drops from the front of that same order', () => {
    expect(
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c SKIP 3 LIMIT 4'),
    ).toEqual([
      { c: 0, d: 's9' },
      { c: 0, d: 's12' },
      { c: 0, d: 's15' },
      { c: 0, d: 's18' },
    ]);
  });

  it('the selection and the full sort agree row for row when the cap covers everything', () => {
    const g = fixture();
    const full = query(g, 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c');

    // `LIMIT 320` is exactly the row count and `LIMIT 400` past it; both must equal the
    // unwindowed sort. Both are ALSO above the crossover, so they exercise the sort-and-slice
    // branch of the same walk — which is how that branch is pinned to the full sort's answer.
    expect(query(g, 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c LIMIT 320')).toEqual(full);
    expect(query(g, 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c LIMIT 400')).toEqual(full);
  });

  it('a second key breaks the ties, and its own direction is honoured', () => {
    expect(
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, n.n AS e ORDER BY c, e DESC LIMIT 5'),
    ).toEqual([
      { c: 0, e: 318 },
      { c: 0, e: 315 },
      { c: 0, e: 312 },
      { c: 0, e: 309 },
      { c: 0, e: 306 },
    ]);
  });

  it('and with the directions swapped', () => {
    expect(
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, n.n AS e ORDER BY c DESC, e LIMIT 5'),
    ).toEqual([
      { c: 2, e: 2 },
      { c: 2, e: 5 },
      { c: 2, e: 8 },
      { c: 2, e: 11 },
      { c: 2, e: 14 },
    ]);
  });

  it('a gate filters before the selection', () => {
    expect(
      query(fixture(), 'MATCH (n:P) WHERE n.n > 5 RETURN n.k AS c, n.s AS d ORDER BY c LIMIT 5'),
    ).toEqual([
      { c: 0, d: 's6' },
      { c: 0, d: 's9' },
      { c: 0, d: 's12' },
      { c: 0, d: 's15' },
      { c: 0, d: 's18' },
    ]);
  });

  it('an inline property filters before the selection', () => {
    expect(
      query(fixture(), 'MATCH (n:P {k: 1}) RETURN n.k AS c, n.s AS d ORDER BY c LIMIT 5'),
    ).toEqual([
      { c: 1, d: 's1' },
      { c: 1, d: 's4' },
      { c: 1, d: 's7' },
      { c: 1, d: 's10' },
      { c: 1, d: 's13' },
    ]);
  });

  it('a key absent from every row leaves the scan order', () => {
    expect(query(fixture(), 'MATCH (n:P) RETURN n.k AS c ORDER BY n.missing LIMIT 4')).toEqual([
      { c: 0 },
      { c: 1 },
      { c: 2 },
      { c: 0 },
    ]);
  });
});

describe('NULLS placement cannot drift from the one comparator', () => {
  const CASES: ReadonlyArray<readonly [string, readonly unknown[]]> = [
    // The DEFAULT is nulls LAST in BOTH directions — `ORDER BY c` returns 1,3,5,… and
    // `ORDER BY c DESC` returns 29,27,…, neither leading with a null. That is read off native
    // rather than reasoned about, which is the point: `compareSort` is the one comparator and this
    // selection must not re-derive its placement.
    [
      'MATCH (n:P) RETURN n.u AS c, n.n AS e ORDER BY c LIMIT 5',
      [
        { c: 1, e: 1 },
        { c: 3, e: 3 },
        { c: 5, e: 5 },
        { c: 7, e: 7 },
        { c: 9, e: 9 },
      ],
    ],
    [
      'MATCH (n:P) RETURN n.u AS c, n.n AS e ORDER BY c DESC LIMIT 5',
      [
        { c: 319, e: 319 },
        { c: 317, e: 317 },
        { c: 315, e: 315 },
        { c: 313, e: 313 },
        { c: 311, e: 311 },
      ],
    ],
    [
      'MATCH (n:P) RETURN n.u AS c, n.n AS e ORDER BY c ASC NULLS LAST LIMIT 5',
      [
        { c: 1, e: 1 },
        { c: 3, e: 3 },
        { c: 5, e: 5 },
        { c: 7, e: 7 },
        { c: 9, e: 9 },
      ],
    ],
    [
      'MATCH (n:P) RETURN n.u AS c, n.n AS e ORDER BY c DESC NULLS FIRST LIMIT 5',
      [
        { c: null, e: 0 },
        { c: null, e: 2 },
        { c: null, e: 4 },
        { c: null, e: 6 },
        { c: null, e: 8 },
      ],
    ],
  ];

  for (const [q, want] of CASES) {
    it(q, () => {
      expect(query(fixture(), q)).toEqual(want as never);
    });
  }
});

describe('the statement-position spelling takes the same order', () => {
  // `boundedTopKeyed`'s other caller. Item 1064 changed its signature, so these pin that the two
  // spellings of one question still agree — item 868 closed a 6.6x gap between them and this is
  // the correctness half of keeping it closed.
  it('one key', () => {
    const g = fixture();

    expect(query(g, 'MATCH (n:P) ORDER BY n.k LIMIT 5 RETURN n.k AS c, n.s AS d')).toEqual(
      query(g, 'MATCH (n:P) RETURN n.k AS c, n.s AS d ORDER BY c LIMIT 5'),
    );
  });

  it('two keys with different directions', () => {
    const g = fixture();

    expect(
      query(g, 'MATCH (n:P) ORDER BY n.k, n.n DESC LIMIT 5 RETURN n.k AS c, n.n AS e'),
    ).toEqual(query(g, 'MATCH (n:P) RETURN n.k AS c, n.n AS e ORDER BY c, e DESC LIMIT 5'));
  });

  it('a DESC key over nulls', () => {
    const g = fixture();

    expect(query(g, 'MATCH (n:P) ORDER BY n.u DESC LIMIT 5 RETURN n.u AS c, n.n AS e')).toEqual(
      query(g, 'MATCH (n:P) RETURN n.u AS c, n.n AS e ORDER BY c DESC LIMIT 5'),
    );
  });
});
