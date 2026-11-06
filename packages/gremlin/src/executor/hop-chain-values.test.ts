import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';

import {
  V,
  both,
  count,
  dedupe,
  eq,
  gte,
  has,
  hasLabel,
  id,
  in_,
  limit,
  order,
  out,
  run,
  toArray,
  traversal,
  values,
} from '../index.js';
import { hopChainValuesShortcut } from './hop-chain-values.js';

/**
 * `V().out(T).out(T).values(k)` — the two-hop fused walk (item 1614), 5.26x.
 *
 * ⚠️ THE ORACLE IS THE PIPELINE ITSELF, compared ORDERED, which is available here by a trick worth
 * stating: `hopChainValuesShortcut` declines a `V(id, …)` source, so spelling the SAME query with
 * every vertex id listed in `graph.vertices` order runs the identical question down the traverser
 * pipeline. `sourceFromIds` does not dedupe and preserves the id array's order (`index-seed.ts`),
 * so the two row sequences must be identical element for element — which is the strongest check
 * available for a walk whose whole risk is row ORDER, since Gremlin streams are compared ordered by
 * the differential fuzzer.
 *
 * A hand-built nested walk is the second oracle, and the literals below are the third.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  k=1   >b >c ~d
 *   b  k=2   >c >d
 *   c  k=3   >c          a SELF-LOOP, which is a legitimate step and emits
 *   d  (no k)>a          a MISSING property, so `values(k)` DROPS it and `id()` does not
 *   e  k=5              no edges at all, in or out
 * ```
 */
const TABLE = [
  {
    id: 'a',
    k: 1,
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  {
    id: 'b',
    k: 2,
    out: [
      ['c', 'E'],
      ['d', 'E'],
    ],
  },
  { id: 'c', k: 3, out: [['c', 'E']] },
  { id: 'd', k: undefined, out: [['a', 'E']] },
  { id: 'e', k: 5, out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = {};

    if (r.k !== undefined) {
      properties.k = r.k;
    }

    graph.addVertex({ id: r.id, labels: ['V'], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      graph.addEdge({
        id: `e${n++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  return graph;
})();

const ALL_IDS = [...g.vertices].map((v) => v.id);

/** The same question with an explicit id source, which the shortcut declines — so: the pipeline. */
const viaPipeline = (tail: readonly Parameters<typeof traversal>[number][]): unknown[] =>
  toArray(traversal(V(...ALL_IDS), ...tail), g);

const viaEngine = (tail: readonly Parameters<typeof traversal>[number][]): unknown[] =>
  toArray(traversal(V(), ...tail), g);

/**
 * ⚠️ DID `run` ACTUALLY TAKE THE WALK? A route choice is answer-equivalent, so every assertion above
 * passes whether the rung fires or the pipeline does — the `rung/never-fires` mutant SURVIVED the
 * first mutation pass for exactly that reason, which is `perf-gate-needs-its-own-test`'s rule.
 *
 * The observable is `drain`: `run` returns `projected.values` when the shortcut left nothing over,
 * and only the fused walks carry that method (`hop-values.ts`, item 1412). `eager-drain-route.test.ts`
 * reads the same signal for the one-hop walk.
 */
const tookTheWalk = (tail: readonly Parameters<typeof traversal>[number][]): boolean =>
  (run(traversal(V(), ...tail), g) as { drain?: unknown }).drain !== undefined;

/** The nested walk by hand, in TinkerPop's flatMap order. */
const byHand = (
  t0: string,
  fwd0: boolean,
  t1: string,
  fwd1: boolean,
  key: string | undefined,
): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

    if (b0 === undefined) {
      continue;
    }

    for (const e0 of b0 as Iterable<Edge>) {
      const mid = fwd0 ? e0.to : e0.from;
      const b1 = (fwd1 ? mid.adjFrom : mid.adjTo)?.get(t1);

      if (b1 === undefined) {
        continue;
      }

      for (const e1 of b1 as Iterable<Edge>) {
        const far = fwd1 ? e1.to : e1.from;

        if (key === undefined) {
          acc.push(far.id);
        } else if (far.properties[key] !== undefined) {
          acc.push(far.properties[key]);
        }
      }
    }
  }

  return acc;
};

describe('the two-hop fused walk agrees with the pipeline, ORDERED', () => {
  test('`out(E).out(E).values(k)` — the shape at 5.26x', () => {
    /**
     * Derived, not eyeballed. The `E` two-hop paths are a>b>c, a>b>d, a>c>c, b>c>c, b>d>a, c>c>c,
     * d>a>b, d>a>c — so the far ends in order are c, d, c, c, a, c, b, c, and `values(k)` DROPS
     * `d` for having no `k`: [3, 3, 3, 1, 3, 2, 3].
     */
    expect(viaEngine([out('E'), out('E'), values('k')])).toEqual([3, 3, 3, 1, 3, 2, 3]);
    expect(viaEngine([out('E'), out('E'), values('k')])).toEqual(
      viaPipeline([out('E'), out('E'), values('k')]),
    );
    expect(viaEngine([out('E'), out('E'), values('k')])).toEqual(byHand('E', true, 'E', true, 'k'));
  });

  test('`id()` keeps the row `values(k)` drops — the `drops` split', () => {
    expect(viaEngine([out('E'), out('E'), id()])).toEqual(['c', 'd', 'c', 'c', 'a', 'c', 'b', 'c']);
    expect(viaEngine([out('E'), out('E'), id()])).toEqual(viaPipeline([out('E'), out('E'), id()]));
  });

  test('a BARE two-hop, with no projection, yields the far vertices themselves', () => {
    const got = viaEngine([out('E'), out('E')]) as Vertex[];

    expect(got.map((v) => v.id)).toEqual(['c', 'd', 'c', 'c', 'a', 'c', 'b', 'c']);
    // The ELEMENTS themselves, so identity is the thing to compare, not a deep structural equality
    // (a `Vertex` carries its adjacency boxes and `toEqual` walks the whole graph through them).
    expect(got).toEqual((viaPipeline([out('E'), out('E')]) as Vertex[]).map((v) => v));
    expect(got.map((v) => v.id)).toEqual(
      (viaPipeline([out('E'), out('E')]) as Vertex[]).map((v) => v.id),
    );
  });

  test('MIXED directions — `out` then `in`, and `in` then `out`', () => {
    for (const tail of [
      [out('E'), in_('E'), values('k')],
      [in_('E'), out('E'), values('k')],
      [in_('E'), in_('E'), values('k')],
    ]) {
      expect(viaEngine(tail)).toEqual(viaPipeline(tail));
    }

    expect(viaEngine([out('E'), in_('E'), id()])).toEqual(byHand('E', true, 'E', false, undefined));
    expect(viaEngine([in_('E'), out('E'), id()])).toEqual(byHand('E', false, 'E', true, undefined));
  });

  test('DIFFERENT types per hop, including a hop whose type reaches nothing', () => {
    // `F` has exactly one edge, a>d, and `d` has one `E` out-edge to `a` (k=1).
    expect(viaEngine([out('F'), out('E'), values('k')])).toEqual([1]);
    expect(viaEngine([out('E'), out('F'), values('k')])).toEqual(
      viaPipeline([out('E'), out('F'), values('k')]),
    );
    // No `G` edge exists at all, so both hops are empty.
    expect(viaEngine([out('G'), out('E'), values('k')])).toEqual([]);
  });

  test('a RESIDUAL rides the walk — `order` and `dedupe` after it', () => {
    expect(viaEngine([out('E'), out('E'), values('k'), order()])).toEqual(
      viaPipeline([out('E'), out('E'), values('k'), order()]),
    );
    expect(viaEngine([out('E'), out('E'), values('k'), dedupe()])).toEqual(
      viaPipeline([out('E'), out('E'), values('k'), dedupe()]),
    );
    expect(viaEngine([out('E'), out('E'), id(), count()])).toEqual([8]);
  });

  test('⚠️ a LIMIT must not be answered by an eager fill', () => {
    /**
     * `eager-tail-cache` records a 473x and a 3680x from filling eagerly under a `LIMIT`. A trailing
     * `limit` lands in `rest`, so `drain` is never read — and the row it returns must be the FIRST
     * of the sequence above, not an arbitrary one.
     */
    expect(viaEngine([out('E'), out('E'), values('k'), limit(1)])).toEqual([3]);
    expect(viaEngine([out('E'), out('E'), id(), limit(3)])).toEqual(['c', 'd', 'c']);
  });

  test('the LAZY iterable and the EAGER `drain` produce the same rows in the same order', () => {
    /**
     * The two loops are written twice (`hop-values.ts`'s rule), so the thing to pin is that they did
     * not DRIFT — item 169's lesson, and a reordering here is a cross-engine failure rather than an
     * unspecified-order liberty.
     */
    const got = hopChainValuesShortcut(traversal(V(), out('E'), out('E'), values('k')), g);

    expect(got).not.toBeUndefined();
    expect([...(got?.values ?? [])]).toEqual([3, 3, 3, 1, 3, 2, 3]);
    expect(got?.values.drain?.()).toEqual([3, 3, 3, 1, 3, 2, 3]);
  });
});

describe('a FILTER in any of the three positions (item 1615)', () => {
  /**
   * The two shapes item 1614 left on the pipeline, at 3.91x and 2.68x. Every expectation is checked
   * against the pipeline ORDERED, by the `V(id, …)` trick above — which is the whole reason that
   * oracle was built, since a filter run shifts every step's POSITION and the parse is what changed.
   *
   * The two-hop `E` paths and their far ends, from the table: a>b>c, a>b>d, a>c>c, b>c>c, b>d>a,
   * c>c>c, d>a>b, d>a>c — far ends c, d, c, c, a, c, b, c with `k` of 3, -, 3, 3, 1, 3, 2, 3.
   */
  test('a TRAILING `has` — the shape at 3.91x', () => {
    // `k >= 3` keeps the five `c` rows: [3, 3, 3, 3, 3].
    expect(viaEngine([out('E'), out('E'), has('k', gte(3)), values('k')])).toEqual([3, 3, 3, 3, 3]);
    expect(viaEngine([out('E'), out('E'), has('k', gte(3)), values('k')])).toEqual(
      viaPipeline([out('E'), out('E'), has('k', gte(3)), values('k')]),
    );
  });

  test('a MID `has` — the shape at 2.68x, and it must test the MIDDLE vertex', () => {
    /**
     * ⚠️ DERIVED SO IT DISCRIMINATES — and I still got the literal wrong first, which is the FIFTH
     * eyeballed literal this session the engine was right about. The middles of the eight paths are
     * b(2), b(2), c(3), c(3), d(no `k`), c(3), a(1), a(1), so `has('k', gte(3))` keeps the three `c`
     * middles — far ends c, c, c, all `k = 3`. I wrote `[3, 3, 3, 1]`, having counted `d`'s path in;
     * `d` has NO `k` at all, so no `has('k', …)` admits it. What the literal IS for is separating the
     * positions: three rows here against the trailing filter's five, so a mutant testing the wrong
     * vertex cannot pass both.
     */
    expect(viaEngine([out('E'), has('k', gte(3)), out('E'), values('k')])).toEqual([3, 3, 3]);
    expect(viaEngine([out('E'), has('k', gte(3)), out('E'), values('k')])).toEqual(
      viaPipeline([out('E'), has('k', gte(3)), out('E'), values('k')]),
    );
  });

  test('a LEAD `has`, which narrows the START', () => {
    // The paths' starts are a(1), a(1), a(1), b(2), b(2), c(3), d(no `k`), d(no `k`), so `k >= 3`
    // keeps only `c` — the self-loop path c>c>c, one row. (I wrote `[3, 2, 3]` by eye, counting the
    // two `d` starts that have no `k`; a `has` on a missing key admits nothing.) ONE row against the
    // mid filter's three and the trailing filter's five, so no two positions share an answer.
    expect(viaEngine([has('k', gte(3)), out('E'), out('E'), values('k')])).toEqual([3]);
    expect(viaEngine([has('k', gte(3)), out('E'), out('E'), values('k')])).toEqual(
      viaPipeline([has('k', gte(3)), out('E'), out('E'), values('k')]),
    );
  });

  test('ALL THREE positions at once, and a `hasLabel` among them', () => {
    const tail = [
      hasLabel('V'),
      out('E'),
      has('k', gte(2)),
      out('E'),
      has('k', gte(3)),
      values('k'),
    ];

    expect(viaEngine(tail)).toEqual(viaPipeline(tail));
    expect(tookTheWalk(tail)).toBe(true);
  });

  test('TWO filters in one run, and a filtered `id()` tail', () => {
    for (const tail of [
      [out('E'), out('E'), hasLabel('V'), has('k', gte(3)), values('k')],
      [out('E'), out('E'), has('k', gte(3)), id()],
      [out('E'), out('E'), has('k', gte(3))],
      [in_('E'), has('k', gte(3)), in_('E'), values('k')],
    ]) {
      expect(viaEngine(tail)).toEqual(viaPipeline(tail));
      expect(tookTheWalk(tail)).toBe(true);
    }
  });

  test('a filtered walk with a RESIDUAL after the projection', () => {
    const tail = [out('E'), out('E'), has('k', gte(3)), values('k'), dedupe()];

    expect(viaEngine(tail)).toEqual(viaPipeline(tail));
    // `rest` is non-empty, so `drain` is not read — the residual rides the walk instead.
    expect(tookTheWalk(tail)).toBe(false);
  });

  test('⚠️ the LAZY loop is filtered too, not only the eager `drain`', () => {
    /**
     * ⚠️ THE `lead/ignored` AND `mid/ignored` MUTANTS SURVIVED IN THE LAZY LOOP while their EAGER
     * twins died — the loops are written twice, and every test above reached only the eager one,
     * because `toArray` with an empty `rest` reads `drain`. A trailing `limit` puts a step in `rest`,
     * which routes through the generator instead. That asymmetry is exactly what writing a loop
     * twice risks, and the far filter was covered only by accident (the `limit` test above).
     */
    for (const tail of [
      [has('k', gte(3)), out('E'), out('E'), values('k'), limit(5)],
      [out('E'), has('k', gte(3)), out('E'), values('k'), limit(5)],
      [out('E'), out('E'), has('k', gte(3)), values('k'), limit(5)],
    ]) {
      expect(tookTheWalk(tail)).toBe(false); // a residual, so the LAZY iterable is what runs
      expect(viaEngine(tail)).toEqual(viaPipeline(tail));
    }

    // And the answers differ by position, so none of the three could pass another's expectation.
    expect(viaEngine([has('k', gte(3)), out('E'), out('E'), values('k'), limit(5)])).toEqual([3]);
    expect(viaEngine([out('E'), has('k', gte(3)), out('E'), values('k'), limit(5)])).toEqual([
      3, 3, 3,
    ]);
    expect(viaEngine([out('E'), out('E'), has('k', gte(3)), values('k'), limit(5)])).toEqual([
      3, 3, 3, 3, 3,
    ]);
  });

  test('⚠️ a SEEKABLE lead `has` defers to the index; a seekable mid or far one does not', () => {
    /**
     * `collectVertexFilters`' asymmetry, pinned with the index actually present — `refuseSeekable`
     * is true for the LEAD run only. A seek seeds the SOURCE and this rung runs before
     * `seedFromIndex`, so a lead run that scanned would preempt a better route; nothing seeds from
     * the far side of a hop (`seedForStep` reads the source step), so refusing there would decline
     * the shape on every indexed graph and gain nothing. The mutant that passed `false` for the lead
     * run SURVIVED the first pass — no test had an index on it.
     */
    const indexed = new Graph();

    for (const r of TABLE) {
      const properties: Record<string, unknown> = {};

      if (r.k !== undefined) {
        properties.k = r.k;
      }

      indexed.addVertex({ id: r.id, labels: ['V'], properties });
    }

    let n = 0;

    for (const r of TABLE) {
      for (const [to, label] of r.out) {
        indexed.addEdge({
          id: `x${n++}`,
          from: indexed.getVertexById(r.id) as Vertex,
          to: indexed.getVertexById(to) as Vertex,
          labels: [label],
          properties: {},
        });
      }
    }

    indexed.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    // A seekable LEAD `has` — declined, so `seedFromIndex` gets the plan.
    expect(
      hopChainValuesShortcut(
        traversal(V(), has('k', eq(3)), out('E'), out('E'), values('k')),
        indexed,
      ),
    ).toBeUndefined();

    // The same predicate in the MID and FAR positions — answered, index or no index.
    expect(
      hopChainValuesShortcut(
        traversal(V(), out('E'), has('k', eq(3)), out('E'), values('k')),
        indexed,
      ),
    ).not.toBeUndefined();
    expect(
      hopChainValuesShortcut(
        traversal(V(), out('E'), out('E'), has('k', eq(3)), values('k')),
        indexed,
      ),
    ).not.toBeUndefined();
  });

  test('⚠️ a filter run whose steps are NOT all vertex filters declines', () => {
    // `dedupe` between the hops is not a vertex filter, so the whole shortcut must decline.
    expect(
      hopChainValuesShortcut(traversal(V(), out('E'), dedupe(), out('E'), values('k')), g),
    ).toBeUndefined();
  });
});

describe('`run` actually takes the walk — the ROUTE, not just the answer', () => {
  test('every admitted tail routes through the fused walk', () => {
    expect(tookTheWalk([out('E'), out('E'), values('k')])).toBe(true);
    expect(tookTheWalk([out('E'), out('E'), id()])).toBe(true);
    expect(tookTheWalk([out('E'), out('E')])).toBe(true);
    expect(tookTheWalk([in_('E'), out('E'), values('k')])).toBe(true);
  });

  test('and a declined tail does NOT — otherwise the check above proves nothing', () => {
    expect(tookTheWalk([out('E'), out('E'), out('E'), values('k')])).toBe(false);
    expect(tookTheWalk([out('E'), both('E'), values('k')])).toBe(false);
    expect(tookTheWalk([out('E'), out('E'), values('k', 'n')])).toBe(false);
  });
});

describe('the rung declines what it must', () => {
  const declines = (tail: readonly Parameters<typeof traversal>[number][]): void => {
    expect(hopChainValuesShortcut(traversal(V(), ...tail), g)).toBeUndefined();
  };

  test('ONE hop is `hopValuesShortcut`’s shape', () => {
    declines([out('E'), values('k')]);
  });

  test('THREE hops — priced and left open, so it must still decline', () => {
    declines([out('E'), out('E'), out('E'), values('k')]);
    // And the answer is still right down the pipeline: the `E` three-hop far ends.
    expect(viaEngine([out('E'), out('E'), out('E'), id()])).toEqual(
      viaPipeline([out('E'), out('E'), out('E'), id()]),
    );
  });

  test('`both` on either hop', () => {
    declines([both('E'), out('E'), values('k')]);
    declines([out('E'), both('E'), values('k')]);
  });

  test('a MULTI-TYPE hop on either side', () => {
    declines([out('E', 'F'), out('E'), values('k')]);
    declines([out('E'), out('E', 'F'), values('k')]);
  });

  test('an UNTYPED hop, which walks every bucket', () => {
    declines([out(), out('E'), values('k')]);
    declines([out('E'), out(), values('k')]);
  });

  test('`V(id, …)` enumerates a given set, not the whole graph', () => {
    expect(
      hopChainValuesShortcut(traversal(V('a'), out('E'), out('E'), values('k')), g),
    ).toBeUndefined();
  });

  test('`values()` with no key, and `values(a, b)`, are different shapes', () => {
    declines([out('E'), out('E'), values()]);
    declines([out('E'), out('E'), values('k', 'n')]);
  });

  test('an unrecognised projection declines the whole shortcut', () => {
    declines([out('E'), out('E'), dedupe(), values('k')]);
    declines([out('E'), out('E'), count()]);
  });
});
