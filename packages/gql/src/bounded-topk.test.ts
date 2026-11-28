import { describe, expect, it } from 'bun:test';

import { boundedTopK } from './executor/projection.ts';

/**
 * Item 2459: `boundedTopK` had NO unit test.
 *
 * It is an exported pure function — a bounded max-heap with an arrival-index tiebreak — and it is
 * what makes `ORDER BY … SKIP s LIMIT n` bounded in MEMORY rather than in time: `projection.ts`
 * calls it with a cap of `(skipBound ?? 0) + limitBound`, so the live set is `s + n` and never the
 * walk. Item 2148 closed that shape on TIME and contains no memory measurement; the bound is a
 * property of THIS function.
 *
 * Why it needed its own tests, and why they are shaped like this. The route is ANSWER-EQUIVALENT —
 * a full sort and a bounded heap return the same rows in the same order, so a mutant that breaks
 * the bound survives every differential and fuzz test in the repo. That is
 * `perf-gate-needs-its-own-test`, and its sibling `boundedTopKeyed` already follows it in
 * `topk-node-scan.test.ts`. The thing a bounded heap CAN get wrong and a correctness suite cannot
 * see is TIE ORDER, which item 605 records as observable between the engines.
 *
 * The subtle case is the EVICTION tie, asserted below: when an incoming element compares EQUAL to
 * the worst kept, `less` falls through to `a.i < b.i` and the incoming index is always larger, so
 * it is NOT admitted. Earlier arrival wins a tie. Flipping that comparison keeps the same MULTISET
 * of keys and changes only which equal-keyed rows survive — invisible to a test that asserts keys.
 */

const asc = (a: number, b: number): number => a - b;

describe('boundedTopK', () => {
  it('returns [] for a non-positive cap, without touching the input', () => {
    let pulled = 0;
    const counted = {
      *[Symbol.iterator]() {
        pulled += 1;

        yield 1;
      },
    };

    expect(boundedTopK(counted, 0, asc)).toStrictEqual([]);
    expect(boundedTopK([3, 1, 2], -5, asc)).toStrictEqual([]);
    // cap <= 0 must short-circuit: with an empty heap the eviction branch would read heap[0].
    expect(pulled).toBe(0);
  });

  it('returns [] for empty input', () => {
    expect(boundedTopK([], 10, asc)).toStrictEqual([]);
  });

  it('returns every row, ascending, when cap exceeds the input', () => {
    expect(boundedTopK([5, 3, 9, 1], 10, asc)).toStrictEqual([1, 3, 5, 9]);
  });

  it('returns every row, ascending, when cap equals the input length exactly', () => {
    expect(boundedTopK([5, 3, 9, 1], 4, asc)).toStrictEqual([1, 3, 5, 9]);
  });

  it('keeps the cap smallest and returns them ascending', () => {
    expect(boundedTopK([5, 3, 9, 1, 7, 2], 3, asc)).toStrictEqual([1, 2, 3]);
  });

  it('handles cap 1 — the degenerate heap', () => {
    expect(boundedTopK([5, 3, 9, 1, 7], 1, asc)).toStrictEqual([1]);
  });

  it('admits a better element after the heap is full, evicting the worst', () => {
    // The first three fill the heap; 1 and 2 must each evict, and 99 must not.
    expect(boundedTopK([7, 8, 9, 99, 1, 2], 3, asc)).toStrictEqual([1, 2, 7]);
  });

  it('sorts the WHOLE result, not just the heap root', () => {
    // A heap's array order is not sorted order. Ascending input makes the distinction visible:
    // without the final sort the array would come back in sift order.
    const out = boundedTopK([9, 8, 7, 6, 5, 4, 3, 2, 1], 5, asc);

    expect(out).toStrictEqual([1, 2, 3, 4, 5]);
    expect([...out].sort(asc)).toStrictEqual(out);
  });

  /*
   * STABILITY. These are the assertions a correctness suite cannot make, because every arm agrees
   * on the KEYS and differs only in WHICH equal-keyed row survives and in what order.
   */
  it('keeps arrival order among equal keys', () => {
    const rows = [
      { k: 1, tag: 'a' },
      { k: 1, tag: 'b' },
      { k: 1, tag: 'c' },
      { k: 1, tag: 'd' },
    ];
    const byK = (x: { k: number }, y: { k: number }): number => x.k - y.k;

    expect(boundedTopK(rows, 4, byK).map((r) => r.tag)).toStrictEqual(['a', 'b', 'c', 'd']);
  });

  it('does NOT admit an incoming element that TIES the worst kept — earlier arrival wins', () => {
    const rows = [
      { k: 1, tag: 'first' },
      { k: 2, tag: 'second' },
      { k: 2, tag: 'later-tie' },
    ];
    const byK = (x: { k: number }, y: { k: number }): number => x.k - y.k;

    // cap 2: the heap fills with first/second, then `later-tie` compares EQUAL to the worst kept
    // (`second`) and must be refused, because `less` breaks the tie on arrival index.
    expect(boundedTopK(rows, 2, byK).map((r) => r.tag)).toStrictEqual(['first', 'second']);
  });

  it('keeps the EARLIEST of many equal keys when the cap forces a choice', () => {
    const rows = Array.from({ length: 8 }, (_v, i) => ({ k: 0, tag: `t${i}` }));
    const byK = (x: { k: number }, y: { k: number }): number => x.k - y.k;

    expect(boundedTopK(rows, 3, byK).map((r) => r.tag)).toStrictEqual(['t0', 't1', 't2']);
  });

  it('respects a descending comparator', () => {
    const desc = (a: number, b: number): number => b - a;

    expect(boundedTopK([5, 3, 9, 1, 7], 2, desc)).toStrictEqual([9, 7]);
  });

  it('does not sort the whole input: comparisons stay near n, not n log n', () => {
    /*
     * The bound is a property of the heap (at most `cap` residents) and is not observable from
     * outside, so this asserts the consequence that IS: the comparator is called O(n log cap)
     * times, not O(n log n).
     *
     * A first cut of this test counted the DISTINCT elements the comparator saw and asserted it
     * stayed below `n`. That can only ever equal `n` — every incoming element is compared against
     * the root at least once — so the assertion was unmeasurable rather than merely loose. The
     * count of CALLS is the observable; the set of elements is not.
     */
    let comparisons = 0;
    const counting = (a: number, b: number): number => {
      comparisons += 1;

      return a - b;
    };
    const n = 5000;
    const cap = 8;
    const fullSortFloor = n * Math.log2(n); // ~61,500
    const input = Array.from({ length: n }, (_v, i) => (i * 7919) % n);
    const out = boundedTopK(input, cap, counting);

    expect(out).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Most elements lose to the root in ONE comparison and are dropped; only an admission sifts,
    // and a sift is log2(cap) = 3 deep. Four per element is generous and still far under a sort.
    expect(comparisons).toBeLessThan(4 * n);
    expect(comparisons).toBeLessThan(fullSortFloor / 4);
  });
});
