/**
 * **THE ONLY TESTS THAT CAN SEE THIS CHANGE** (item 2293). Letting `hop2Projection` hand a query to
 * the orienting matcher is ANSWER-EQUIVALENT — both routes return the same rows in the same order — so
 * every mutation of a condition inline in the gate survives the differential tests. That is
 * `perf-gate-needs-its-own-test`, learned at items 1038/1044, and it is why the arithmetic is extracted.
 *
 * The two constants carry different jobs and are tested separately:
 *
 *   `FAR_BUCKET_DECISIVE` is the RATIO at which reversing is right. Item 2104 rejected bucket-size
 *   evidence because `orient` reverses on 4-against-40, and giving up this rung's fused walk for a 10x
 *   ratio costs 13.8x on `hop2distinct` (items 1821/1822). So the test that matters most is that a
 *   10x ratio still DECLINES.
 *
 *   `FAR_BUCKET_TINY` is COST, not correctness: without it the unindexed path paid for a second seed
 *   estimate on every query, measured at `hop2startwhere` 3.63 → 4.45 ms.
 */
import { describe, expect, test } from 'bun:test';

import { FAR_BUCKET_DECISIVE, FAR_BUCKET_TINY, farBucketIsDecisive } from './executor/matching.ts';

describe('farBucketIsDecisive: a RATIO, not merely "smaller"', () => {
  test('ITEM 2104s CASE STILL DECLINES: 4 far against 40 near is 10x and must keep the fused walk', () => {
    expect(farBucketIsDecisive(4, 40)).toBe(false);
  });

  test('item 2289s case fires: one document against a 400,000-user tenant', () => {
    expect(farBucketIsDecisive(1, 400_000)).toBe(true);
  });

  test('the boundary is exact and inclusive at the ratio', () => {
    expect(farBucketIsDecisive(10, 10 * FAR_BUCKET_DECISIVE)).toBe(true);
    expect(farBucketIsDecisive(10, 10 * FAR_BUCKET_DECISIVE - 1)).toBe(false);
  });

  test('a far end no smaller than the start never fires, including when equal', () => {
    expect(farBucketIsDecisive(100, 100)).toBe(false);
    expect(farBucketIsDecisive(400_000, 1)).toBe(false);
  });

  test('an EMPTY far bucket does not fire — zero would satisfy any ratio, and an empty label is not evidence about orientation', () => {
    expect(farBucketIsDecisive(0, 400_000)).toBe(false);
    expect(farBucketIsDecisive(0, 0)).toBe(false);
  });

  test('the single-label fixtures the rung serves cannot fire it, which is why they measured flat', () => {
    /* `hop2rows` and friends are all `:P` over 20,000 vertices, so both ends estimate the same bucket. */
    expect(farBucketIsDecisive(20_000, 20_000)).toBe(false);
  });
});

describe('the two constants keep their intended relationship', () => {
  test('a bucket at the TINY bound still needs a 64x start before the ratio can fire', () => {
    expect(farBucketIsDecisive(FAR_BUCKET_TINY, FAR_BUCKET_TINY * FAR_BUCKET_DECISIVE)).toBe(true);
    expect(farBucketIsDecisive(FAR_BUCKET_TINY, FAR_BUCKET_TINY * 2)).toBe(false);
  });

  test('TINY is far above item 2104s 4-document case, so the pre-check never hides it', () => {
    expect(FAR_BUCKET_TINY).toBeGreaterThan(4);
    /* And DECISIVE is far above that case's 10x ratio, which is the whole point. */
    expect(FAR_BUCKET_DECISIVE).toBeGreaterThan(10);
  });
});
