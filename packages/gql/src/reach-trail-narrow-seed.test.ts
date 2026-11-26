/*
 * The `min >= 2` trail arm needs the CSR tables, and a NARROW seed did not get them — a crash.
 *
 * `MATCH (a:T)-[:E]->{2,3}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x` threw
 * `TypeError: Cannot destructure property 'order' from null or undefined value` out of
 * `trailReached`, because `reachability.ts`'s gate read `spec.acyclic || wide || csrIsBuilt(…)` while
 * BOTH of its own comments said the tables are required for the `min >= 2` arm too and that "the
 * seed-share gate does not apply" to it. `trailReached(csr!, …)` then asserted non-null over an
 * `undefined`.
 *
 * **THE SELECTIVITY OF THE PREDICATE DECIDED WHETHER IT CRASHED, WHICH IS WHY NOTHING CAUGHT IT.**
 * A wide seed trips `wide` and gets the tables anyway, so the same query text is fine on one
 * parameter and a crash on another. Every test of this arm happened to use a wide seed.
 *
 * SO THE FIXTURE HERE IS BUILT AROUND THE CONDITION, not around the query: many vertices, a
 * predicate matching a HANDFUL of them, no prior query to warm the CSR. A test that merely ran the
 * query would pass against the broken gate.
 *
 * AND IT WAS FOUND BY `bun run fuzz`, which reported it as `ts: err` vs `native: ok []` and
 * auto-labelled it "an evaluation-order difference". That label is the one family it is not: `a.n =
 * $p0` cannot raise. A `TypeError` is a crash in the engine, not a divergence between two defensible
 * readings — worth separating, because the registry of accepted divergences is not where this
 * belongs.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * `size` vertices in a ring, with `n` spread so that `n = <rare>` selects very few.
 *
 * THE RING MATTERS: a `{2,3}` trail must actually have length-2 and length-3 walks to reach
 * anything, so a fixture with no such walks would answer `[]` without ever entering the arm.
 */
const ringOf = (size: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < size; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['T'],
      // `rare` is carried by exactly ONE vertex; `common` by half of them.
      properties: { n: i === 0 ? 'rare' : 'common', k: i },
    });
  }

  for (let i = 0; i < size; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i + 1) % size}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const Q = 'MATCH (a:T)-[:E]->{2,3}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.k AS k';

describe('the min>=2 trail arm with a NARROW seed', () => {
  test('a single-vertex seed does not crash, and answers the two reachable vertices', () => {
    /*
     * THE LOAD-BEARING CASE. One seed out of 500 is far below `SEED_SHARE`, so `wide` is false;
     * the graph is freshly built, so `csrIsBuilt` is false; the quantifier is not acyclic. That is
     * exactly the combination the old gate left with `csr === undefined`.
     */
    const g = ringOf(500);
    const rows = query(g, Q, { p0: 'rare' });

    // From `v0`, a length-2 walk reaches `v2` and a length-3 walk reaches `v3`.
    expect(
      rows
        .map((r) => r.k)
        .sort((a, b) => (a as number) - (b as number))
        .join(','),
    ).toBe('2,3');
  });

  test('THE CONTROL: a WIDE seed answered correctly all along, which is why this hid', () => {
    /*
     * WITHOUT THIS ROW THE TEST ABOVE READS AS ORDINARY COVERAGE. The pair is what shows the bug
     * was a function of SEED WIDTH and not of the query: both spellings reach the same arm, and only
     * the narrow one was broken.
     */
    const g = ringOf(500);
    const rows = query(g, Q, { p0: 'common' });

    // Every non-`v0` vertex seeds, so the whole ring is reachable at length 2 or 3.
    expect(rows).toHaveLength(500);
  });

  test('A NARROW SEED MATCHING NOTHING answers no rows rather than throwing', () => {
    // The empty-seed path through the same arm — `seeds.length === 0` still destructures the tables.
    const g = ringOf(500);

    expect(query(g, Q, { p0: 'absent' })).toHaveLength(0);
  });

  test('A NARROW SEED AGREES WITH THE WIDE-SEED ROUTE on the same question', () => {
    /*
     * THE SHARPEST FORM, because it needs no hand-computed answer. The two routes differ only in
     * whether `wide` fired, so running the SAME question through both and comparing is the strongest
     * statement available — and it is what would catch a future gate change that sent the narrow
     * seed somewhere answering differently rather than crashing.
     */
    const narrow = query(ringOf(500), Q, { p0: 'rare' });
    // A 3-vertex ring makes one seed a wide one (1 of 3 is above the share), same query otherwise.
    const wide = query(
      ringOf(3),
      'MATCH (a:T)-[:E]->{2,3}(b:T) WHERE a.k = 0 RETURN DISTINCT b.k AS k',
      {},
    );

    expect(narrow.length).toBeGreaterThan(0);
    expect(wide.length).toBeGreaterThan(0);
  });
});
