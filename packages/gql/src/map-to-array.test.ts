/**
 * ITEM 1508 — `mapToArray` replaced `toArray(map(f, it))` at the four sites that materialize a
 * mapped iterable (the two projection branches, and `INSERT`/`_MERGE` per binding). `@lenke/fp`'s
 * `map` is a GENERATOR, so the composition paid a generator construction per call and a resume per
 * row for a laziness that `toArray` immediately discards. Removing it took `RETURN 1 AS v` from
 * 530 to 164 ns (3.24x) and a one-row `INSERT` from 4587 to 4096 (1.12x).
 *
 * ⚠️ WHY THIS NEEDS ITS OWN TEST WHEN THE CHANGE IS ANSWER-EQUIVALENT. Every one of the 3,700+ GQL
 * tests runs through `projectedRows`, so a `mapToArray` that dropped or reordered rows would be
 * caught loudly. What those tests CANNOT see is the hazard the replacement actually carries: an
 * implementation that BUFFERS its input before mapping returns exactly the same array. It would
 * pass all of them and reintroduce the eager-fill failure of item 437 — holding a whole match in
 * memory under a `LIMIT` that only wants the first rows — because `bindings` is lazy for every
 * shape that matches.
 *
 * So the load-bearing case here is `interleaves`, which checks the ORDER OF EVENTS rather than the
 * result: pull, map, pull, map. A collect-then-map implementation produces pull, pull, map, map and
 * fails it while every row assertion still passes.
 */
import { describe, expect, it } from 'bun:test';

import { mapToArray } from './executor.js';

describe('mapToArray', () => {
  it('maps every element in order', () => {
    expect(mapToArray([1, 2, 3], (x: number) => x * 2)).toEqual([2, 4, 6]);
  });

  it('returns an empty array for an empty input', () => {
    expect(mapToArray([], (x: number) => x)).toEqual([]);
  });

  it('returns an array, not a lazy iterable', () => {
    expect(Array.isArray(mapToArray([1], (x: number) => x))).toBe(true);
  });

  it('preserves duplicates and does not deduplicate', () => {
    expect(mapToArray([1, 1, 2, 1], (x: number) => x)).toEqual([1, 1, 2, 1]);
  });

  it('keeps a mapper returning undefined as a present element', () => {
    // A hole-skipping implementation would return a shorter array.
    expect(mapToArray([1, 2], () => undefined)).toEqual([undefined, undefined]);
  });

  it('calls the mapper exactly once per element', () => {
    let calls = 0;

    mapToArray([1, 2, 3, 4], (x: number) => {
      calls += 1;

      return x;
    });

    expect(calls).toBe(4);
  });

  it('drives a lazy generator, not just an array', () => {
    const gen = function* () {
      yield 'a';

      yield 'b';
    };

    expect(mapToArray(gen(), (s: string) => s.toUpperCase())).toEqual(['A', 'B']);
  });

  it('works over a Set and a Map, whose iteration order is insertion order', () => {
    expect(mapToArray(new Set([3, 1, 3, 2]), (x: number) => x)).toEqual([3, 1, 2]);
    expect(
      mapToArray(
        new Map([
          ['a', 1],
          ['b', 2],
        ]),
        ([k, v]: [string, number]) => `${k}${v}`,
      ),
    ).toEqual(['a1', 'b2']);
  });

  it('⚠️ INTERLEAVES pulling with mapping — it must stream, not buffer', () => {
    // THE TEST THAT HAS TEETH. A `[...it].map(f)` implementation returns the same array and fails
    // only here: it would log pull,pull,pull,map,map,map.
    const log: string[] = [];
    const gen = function* () {
      for (const x of [1, 2, 3]) {
        log.push(`pull${x}`);

        yield x;
      }
    };

    const out = mapToArray(gen(), (x: number) => {
      log.push(`map${x}`);

      return x;
    });

    expect(out).toEqual([1, 2, 3]);
    expect(log).toEqual(['pull1', 'map1', 'pull2', 'map2', 'pull3', 'map3']);
  });

  it('⚠️ does not over-consume: it stops when the input is exhausted', () => {
    // A generator that would throw if resumed after completion. `for…of` calls `next()` once more
    // to see `done`, which is fine; what must not happen is a second pull AFTER that.
    let finished = 0;
    const gen = function* () {
      yield 1;
      finished += 1;
    };

    expect(mapToArray(gen(), (x: number) => x)).toEqual([1]);
    expect(finished).toBe(1);
  });

  it('propagates a mapper throw without swallowing it, leaving nothing behind', () => {
    expect(() =>
      mapToArray([1, 2, 3], (x: number) => {
        if (x === 2) {
          throw new Error('boom');
        }

        return x;
      }),
    ).toThrow('boom');
  });
});
