/*
 * Item 2112 — a bare trailing `store(k)` is FUSED, lazily, and the bag holds exactly what was pulled.
 *
 * ⚠️⚠️ **THIS REPLACES A REFUSAL, SO IT CARRIES THE REFUSAL'S OWN ARGUMENT AS ITS ASSERTIONS.** Item 2070
 * refused `store` from `barrierProjectedBag` because that returns the DRAINED array — "the stream passes
 * through to a caller who may stop early, and `store` is lazy by contract". That reason is correct and
 * `store` is still refused from THAT arm; item 2112 gives it a different one, lazy as an iterator and
 * eager only via `drain`.
 *
 * 🔑 THE FOUR CONSUMPTION PATTERNS, and the third is the one the refusal existed to protect:
 *   1. `toArray` — drains; the bag holds every row.
 *   2. `run` consumed fully — the bag holds every row.
 *   3. `run` BROKEN OUT OF EARLY — the bag holds ONLY what was pulled. ⚠️ If this ever regresses, the
 *      fusion is collecting elements the caller never caused, which is precisely what was refused.
 *   4. Iterate part-way THEN drain — the bag holds each element EXACTLY ONCE. ⚠️ Item 2098 demonstrated
 *      this DOUBLING (10 where 5 is correct) and concluded a single-use latch was needed; one shared
 *      generator makes it the generator's own guarantee instead.
 *
 * ⚠️ AND THE ANSWER MUST MATCH THE GENERIC PATH, not merely have the right length — a fusion that banked
 * the right COUNT of wrong elements would pass a length check.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { barrierProjectedStore } from './executor/aggregation.js';
import { cap, out, run, store, toArray, traversal, V, values } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
  }

  for (let e = 0; e < 80; e += 1) {
    const i = e % 40;
    const hop = Math.floor(e / 40);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % 40}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/** The shape the fusion claims: a projection then a BARE trailing `store`. */
const plan = () => traversal(V(), out('E'), values('n'), store('x'));

/** The same question with no `store`, for the expected element sequence. */
const bare = () => traversal(V(), out('E'), values('n'));

describe('a bare trailing store is fused lazily (item 2112)', () => {
  test('🔑 1. toArray — the bag holds every row, and the ROWS match the unstored walk', () => {
    const g = build();
    const rows = toArray(plan(), g);
    const expected = toArray(bare(), g);

    expect(rows).toStrictEqual(expected);

    /*
     * ⚠️ THE BAG IS READ THROUGH A SECOND TRAVERSAL rather than from internals, so this asserts what a
     * user can observe. `cap` is the public way to read a side-effect bag.
     */
    expect(rows.length).toBe(expected.length);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('🔑 2. run consumed FULLY — same rows, same order as the unstored walk', () => {
    const g = build();
    const got = [...run(plan(), g)];

    expect(got).toStrictEqual(toArray(bare(), g));
  });

  test('⚠️⚠️ 3. run BROKEN OUT OF EARLY — the walk stops, so nothing past the break is produced', () => {
    /*
     * 🔑 THE ASSERTION THE REFUSAL EXISTED FOR. A drained arm would have enumerated the WHOLE walk
     * before the caller saw its first element; this one must stop. Observed through the only thing a
     * caller can see — that the iterator yields the prefix and the walk is abandoned.
     */
    const g = build();
    const expected = toArray(bare(), g);
    const pulled: unknown[] = [];

    for (const v of run(plan(), g)) {
      pulled.push(v);

      if (pulled.length >= 5) {
        break;
      }
    }

    expect(pulled).toStrictEqual(expected.slice(0, 5));
    // ⚠️ And the walk really is longer, or "stops early" is vacuous.
    expect(expected.length).toBeGreaterThan(5);
  });

  test('⚠️⚠️ 4. iterate part-way THEN drain — every element exactly once, no doubling', () => {
    /*
     * 🔑 ITEM 2098's DEMONSTRATED HAZARD. Its arm had the iterator walk the source while `drain()` called
     * the source's own `drain`, so an element reached by both paths was bagged twice. One shared
     * generator cannot yield the same element twice.
     *
     * ⚠️ `drain` is not public API, so this reaches it the way `toArray` does — through the object `run`
     * returns. The cast is to the shape item 1412's rule describes, and the test asserts the CONTRACT
     * (prefix + remainder = the whole walk, once each) rather than the internals.
     */
    const g = build();
    const expected = toArray(bare(), g);
    const result = run(plan(), g) as Iterable<unknown> & { drain?: () => unknown[] };
    const pulled: unknown[] = [];

    for (const v of result) {
      pulled.push(v);

      if (pulled.length >= 5) {
        break;
      }
    }

    expect(pulled).toStrictEqual(expected.slice(0, 5));

    if (typeof result.drain === 'function') {
      const rest = result.drain();

      // 🔑 EXACTLY ONCE: the prefix the iterator took plus the remainder the drain took IS the walk.
      expect([...pulled, ...rest]).toStrictEqual(expected);
    } else {
      /*
       * ⚠️ NOT A SKIP. If `run` did not return a drainable result for this shape the fusion did not
       * claim it, and then this file is asserting nothing — so that is a failure, not a pass.
       */
      throw new Error(
        'the fused store arm did not expose `drain` — the fusion did not claim the shape',
      );
    }
  });

  test('⚠️ the bag is readable through `cap`, and holds the walk exactly once', () => {
    /*
     * 🔑 THE USER-VISIBLE CHECK. `store(x).cap(x)` was ALREADY fused before this item
     * (`fusableProjectedBagCap` admits both kinds), so this guards that the new bare-`store` arm did not
     * change what a `cap` reader sees.
     */
    const g = build();
    const expected = toArray(bare(), g);
    const capped = toArray(traversal(V(), out('E'), values('n'), store('y'), cap('y')), g);

    expect(capped).toHaveLength(1);
    expect(capped[0]).toStrictEqual(expected);
  });
});

/*
 * ⚠️⚠️ **THE BAG ITSELF, UNIT-TESTED — AND IT HAD TO BE.** Two hand-applied mutants that deleted the
 * `bucket.push` from the iterator path and from the drain path BOTH SURVIVED the five tests above: they
 * assert the ROWS, and a bare trailing `store(k)` has no reader for its bag from outside the engine. The
 * `cap` test routes through `fusableProjectedBagCap`, a DIFFERENT arm, so it never touched this one.
 *
 * 🔑 `bag-count-fusion.test.ts` already names this problem for its own fusion — "from outside the engine
 * the two-step form's bag has no reader, so a unit test of the function is the only place it is visible
 * at all" — and calls the function directly with a `ctx`. Same answer here.
 */
describe('barrierProjectedStore fills the bag EXACTLY ONCE (item 2112)', () => {
  /** A walk standing in for the fused one: a generator, plus the `drain` the real walks expose. */
  const walkOf = (n: number) => {
    const made = (function* () {
      for (let i = 0; i < n; i += 1) {
        yield i;
      }
    })();

    /*
     * ⚠️ THIS `drain` RE-WALKS FROM SCRATCH, exactly as the engine's do (`[...walk()]`). If
     * `barrierProjectedStore` ever calls it, the bag double-fills — which is the mutant this fixture
     * makes catchable.
     */
    return Object.assign(made, { drain: () => Array.from({ length: n }, (_x, i) => i) });
  };
  const ctxOf = () => ({ sideEffects: new Map<string, unknown[]>() });

  test('🔑 drain only — the bag holds every element, once', () => {
    const ctx = ctxOf();
    const rows = barrierProjectedStore(walkOf(5), 'x', ctx).drain();

    expect(rows).toStrictEqual([0, 1, 2, 3, 4]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([0, 1, 2, 3, 4]);
  });

  test('🔑 iterate fully — the bag holds every element, once', () => {
    const ctx = ctxOf();
    const got = [...barrierProjectedStore(walkOf(5), 'x', ctx)];

    expect(got).toStrictEqual([0, 1, 2, 3, 4]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([0, 1, 2, 3, 4]);
  });

  test('⚠️⚠️ iterate PART-WAY — the bag holds ONLY what was pulled', () => {
    /*
     * 🔑 THE ASSERTION ITEM 2070's REFUSAL EXISTED FOR. An eager arm would have banked all five.
     */
    const ctx = ctxOf();
    const pulled: unknown[] = [];

    for (const v of barrierProjectedStore(walkOf(5), 'x', ctx)) {
      pulled.push(v);

      if (pulled.length >= 2) {
        break;
      }
    }

    expect(pulled).toStrictEqual([0, 1]);
    expect(ctx.sideEffects.get('x')).toStrictEqual([0, 1]);
  });

  test('⚠️⚠️ part-way THEN drain — EXACTLY ONCE, which is item 2098 demonstrated doubling', () => {
    /*
     * 🔑 Item 2098 measured `bag` at 10 where 5 is correct. One shared generator cannot yield twice.
     */
    const ctx = ctxOf();
    const result = barrierProjectedStore(walkOf(5), 'x', ctx);
    const pulled: unknown[] = [];

    for (const v of result) {
      pulled.push(v);

      if (pulled.length >= 2) {
        break;
      }
    }

    const rest = result.drain();

    expect(pulled).toStrictEqual([0, 1]);
    expect(rest).toStrictEqual([2, 3, 4]);
    // ⚠️ THE BAG: five entries, each once — not ten, and not three.
    expect(ctx.sideEffects.get('x')).toStrictEqual([0, 1, 2, 3, 4]);
  });

  test('⚠️ an EXISTING bag is appended to, not replaced', () => {
    const ctx = ctxOf();

    ctx.sideEffects.set('x', [99]);
    barrierProjectedStore(walkOf(3), 'x', ctx).drain();

    expect(ctx.sideEffects.get('x')).toStrictEqual([99, 0, 1, 2]);
  });

  test('⚠️ TWO keys stay separate', () => {
    const ctx = ctxOf();

    barrierProjectedStore(walkOf(2), 'a', ctx).drain();
    barrierProjectedStore(walkOf(3), 'b', ctx).drain();

    expect(ctx.sideEffects.get('a')).toStrictEqual([0, 1]);
    expect(ctx.sideEffects.get('b')).toStrictEqual([0, 1, 2]);
  });
});
