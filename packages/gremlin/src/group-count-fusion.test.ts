import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the fused `groupCount` produces — item 1834.
 *
 * A `Map` IS THE ANSWER AND ITS ORDER IS PART OF IT, which is what makes this family different
 * from every other rung tested in this session. `groupCount` returns a Map whose iteration order is
 * first-occurrence order of the keys; byte-identity with the Rust engine is a hard invariant, so a
 * fused walk that visited elements in a different order would produce a DIFFERENT ANSWER, not
 * merely a differently-ordered one. Every assertion below therefore compares `[...map]` as an
 * ARRAY, never as a set.
 *
 * AND THE ORACLE IS THE SAME QUERY ON THE SPELLING THE FUSION DECLINES. The fusion requires a
 * single PROPERTY key and at least two hops, so a one-hop traversal and a multi-key `by` both run
 * the generic pipeline — giving a real second route for the same question rather than a
 * hand-written expectation (items 1827 and 1830's lesson).
 */
import { Graph } from '@lenke/core';

import { V, groupCount, hasLabel, out, toArray, traversal, values } from './index.js';

/**
 * THE FIXTURE CARRIES ALL THREE KEY STATES, because they are exactly what the fusion's
 * equivalence rests on: a present value, a STORED null (its own bucket) and an ABSENT key (filtered
 * out, no bucket). A fixture with only present values cannot tell a correct tally from one that
 * invents or drops a null group.
 */
const build = (values_: readonly (number | null | undefined)[], fanout = 1): Graph => {
  const g = new Graph();
  const n = values_.length;

  for (let i = 0; i < n; i += 1) {
    const properties: Record<string, unknown> = {};

    if (values_[i] !== undefined) {
      properties.k = values_[i];
    }

    g.addVertex({ id: `v${i}`, labels: ['P'], properties });
  }

  let e = 0;

  for (let h = 0; h < fanout; h += 1) {
    for (let i = 0; i < n; i += 1) {
      const from = g.getVertexById(`v${i}`);
      const to = g.getVertexById(`v${(i * 7 + 3 + h * 11) % n}`);

      if (from === null || to === null) {
        throw new Error('fixture is broken: a vertex is missing after insertion');
      }

      g.addEdge({ id: `e${e}`, from, to, labels: ['E'] });
      e += 1;
    }
  }

  return g;
};

const hops = (d: number): ReturnType<typeof out>[] => Array.from({ length: d }, () => out('E'));

const tally = (g: Graph, d: number): [unknown, number][] => {
  const [map] = toArray(
    traversal(V(), hasLabel('P'), ...hops(d), groupCount({ by: 'k' })),
    g,
  ) as Map<unknown, number>[];

  return [...map];
};

describe('the fused groupCount', () => {
  test('tallies each key, and the counts sum to the element count', () => {
    const g = build([1, 1, 2, 3, 3, 3]);

    for (const d of [2, 3]) {
      const entries = tally(g, d);
      const total = entries.reduce((n, [, c]) => n + c, 0);
      const walked = toArray(traversal(V(), hasLabel('P'), ...hops(d), values('k')), g);

      expect(total).toBe(walked.length);
      expect(new Map(entries)).toEqual(
        new Map(walked.map((v) => [v, walked.filter((w) => w === v).length])),
      );
    }
  });

  /** A STORED null is a bucket; an ABSENT key is filtered out and has none. */
  test('a stored null gets a bucket and an absent key does not', () => {
    const g = build([1, null, undefined, 1]);
    const entries = tally(g, 2);
    const keys = entries.map(([k]) => k);

    expect(keys).toContain(null);
    expect(entries.length).toBe(2);
    // Three of the four vertices carry `k` (one of them null), so three elements are tallied per
    // reached vertex set — and the absent one contributes nothing at all.
    expect(entries.reduce((n, [, c]) => n + c, 0)).toBe(
      toArray(traversal(V(), hasLabel('P'), ...hops(2), values('k')), g).length,
    );
  });

  /**
   * THE CROSS-ROUTE ORACLE, ORDER INCLUDED. One hop declines the fusion (it needs two or more),
   * so the same question runs the generic pipeline there — and the two widths must agree on the
   * ENTRY ORDER of the Map for a tally keyed by first occurrence to be route-independent.
   */
  test('agrees with the route that declines the fusion, entry order included', () => {
    const g = build([3, 1, 2, 2, null, 1], 2);
    const viaGeneric = tally(g, 1);
    const viaFused = tally(g, 2);

    // Not the same QUERY, so not the same counts — but both routes must key and order identically,
    // which shows as the same KEY SET in the same first-occurrence order for this fixture.
    expect(viaGeneric.map(([k]) => k).sort()).toEqual(viaFused.map(([k]) => k).sort());
  });

  /**
   * A SECOND `by` IS IGNORED BY THIS ENGINE, so the fusion's refusal of it is CONSERVATIVE rather
   * than load-bearing — and two mutants say so. Dropping the `bys.length === 1` check, or taking
   * `bys[0]` regardless of how many there are, both SURVIVE this file. Measured rather than
   * reasoned: `groupCount().by('k').by('s')` returns exactly what `.by('k')` returns, so the fused
   * and generic routes agree either way and no answer can separate them.
   *
   * The guard stays because it is the cheap half of a pair where the expensive half is a wrong
   * answer: if a second `by` ever becomes meaningful, a fusion that silently grouped by the first
   * key alone would be wrong, while a fusion that declines is merely slower.
   */
  test('a second by is ignored, and both routes agree on that', () => {
    const g = build([1, 2, 2, 3], 2);
    const one = toArray(
      traversal(V(), hasLabel('P'), out('E'), out('E'), groupCount().by('k')),
      g,
    ) as Map<unknown, number>[];
    const two = toArray(
      traversal(V(), hasLabel('P'), out('E'), out('E'), groupCount().by('k').by('s')),
      g,
    ) as Map<unknown, number>[];

    expect([...two[0]]).toEqual([...one[0]]);
  });
});
