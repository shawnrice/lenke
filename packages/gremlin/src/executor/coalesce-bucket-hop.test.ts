import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  both,
  count,
  identity,
  coalesce,
  in_,
  out,
  pipe,
  toArray,
  traversal,
  values,
} from '../index.js';

/**
 * `coalesceStep` reads the adjacency bucket directly when its FIRST arm is a single vertex step
 * (item 1629) — **1.26x** on `V().coalesce(out(T), identity()).values(k)`, the half item 1628 left
 * open because `coalesce` had no fused detector where `optional` did.
 *
 * ⚠️ ONLY THE FIRST ARM, and the reason is the semantics: `coalesce` emits the output of the first
 * arm that produces anything, so arm 0 runs for EVERY incoming traverser and the rest run only for
 * the rows arm 0 missed. Fusing arm 0 reaches almost every row; fusing the others would reach almost
 * none.
 *
 * ⚠️ AND `from = 1` IS THE WHOLE CORRECTNESS QUESTION. When the fast arm's bucket is EMPTY the
 * remaining arms must run — and must start at arm 1, because the general loop would have moved past
 * arm 0 after it produced nothing. Re-running arm 0 would be answer-equivalent and wasteful;
 * SKIPPING arm 1 would drop rows. Every test below includes a vertex arm 0 misses.
 *
 * ⚠️ THE ORACLE IS A TWO-STEP FIRST ARM. `optionalSingleHop` admits exactly one step, so appending
 * `identity()` INSIDE arm 0 sends the identical question to the general loop. Gremlin stream order is
 * a TinkerPop contract compared ORDERED by the differential fuzzer, so the comparisons are element
 * for element.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  k=1  >b >c ~d
 *   b  k=2  >c
 *   c  k=3  >c          a SELF-LOOP
 *   d  k=4  >a
 *   e  k=5              NO edges — the arm-0-misses case
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
  { id: 'b', k: 2, out: [['c', 'E']] },
  { id: 'c', k: 3, out: [['c', 'E']] },
  { id: 'd', k: 4, out: [['a', 'E']] },
  { id: 'e', k: 5, out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    graph.addVertex({ id: r.id, labels: ['P'], properties: { id: r.id, k: r.k } });
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

/** The fast arm against the general loop: `identity()` inside arm 0 disqualifies the fusion. */
const bothWays = (
  first: Parameters<typeof pipe>[number],
  rest: readonly Parameters<typeof coalesce>[number][],
): void => {
  const fast = toArray(traversal(V(), coalesce(pipe(first), ...(rest as never[])), values('k')), g);
  const general = toArray(
    traversal(V(), coalesce(pipe(first, identity()), ...(rest as never[])), values('k')),
    g,
  );

  expect(fast).toEqual(general);
};

describe('the fast first arm agrees with the general loop, ORDERED', () => {
  test('`coalesce(out(E), identity())` — the shape at 1.26x', () => {
    /**
     * Derived. `a` has E to b(2) and c(3); `b` to c(3); `c` the self-loop(3); `d` to a(1); `e` has
     * NO `E` edge so arm 0 is empty and `identity()` supplies `e` itself, k=5. So [2, 3, 3, 3, 1, 5].
     */
    expect(
      toArray(traversal(V(), coalesce(pipe(out('E')), pipe(identity())), values('k')), g),
    ).toEqual([2, 3, 3, 3, 1, 5]);
    bothWays(out('E'), [pipe(identity())]);
  });

  test('⚠️ arm 0 empty for FOUR of five rows, so arm 1 carries them', () => {
    // Only `a` has an `F` edge (to d, k=4); the rest fall through to `identity()`.
    expect(
      toArray(traversal(V(), coalesce(pipe(out('F')), pipe(identity())), values('k')), g),
    ).toEqual([4, 2, 3, 4, 5]);
    bothWays(out('F'), [pipe(identity())]);
  });

  test('⚠️ arm 0 empty for EVERY row — arm 1 must still run', () => {
    // No `G` edge exists, so this is `identity()` for the whole stream.
    expect(
      toArray(traversal(V(), coalesce(pipe(out('G')), pipe(identity())), values('k')), g),
    ).toEqual([1, 2, 3, 4, 5]);
    bothWays(out('G'), [pipe(identity())]);
  });

  test('⚠️ THREE arms — the fall-through must reach arm 1, not arm 2', () => {
    /**
     * This is what a wrong `from` index looks like: with `from = 2` the `in(E)` arm is skipped and
     * `identity()` answers instead, so `d` and `e` would be the only rows.
     *
     * ⚠️ DERIVED FROM THE TABLE, after I got it wrong by deriving from MEMORY of the table and
     * dropped `a`'s second `E` edge — the twenty-second eyeballed literal this session. The `E` edges
     * are a>b, a>c, b>c, c>c and d>a, so by in-neighbour:
     *
     * ```text
     *    a <- d(4)              b <- a(1)
     *    c <- a(1), b(2), c(3)  d <- nothing, so arm 2 gives d itself (4)
     *    e <- nothing, so arm 2 gives e itself (5)
     * ```
     *
     * which is SEVEN rows, [4, 1, 1, 2, 3, 4, 5] — not the six I wrote.
     */
    expect(
      toArray(
        traversal(V(), coalesce(pipe(out('G')), pipe(in_('E')), pipe(identity())), values('k')),
        g,
      ),
    ).toEqual([4, 1, 1, 2, 3, 4, 5]);
    bothWays(out('G'), [pipe(in_('E')), pipe(identity())]);
  });

  test('a SINGLE arm emits NOTHING where it is empty — unlike `optional`', () => {
    /**
     * `coalesce` has no implicit fallback: a one-arm `coalesce` whose arm is empty drops the row,
     * where `optional` would yield the traverser. `e` is absent from the first and all five rows
     * from the second.
     */
    expect(toArray(traversal(V(), coalesce(pipe(out('E'))), values('k')), g)).toEqual([
      2, 3, 3, 3, 1,
    ]);
    expect(toArray(traversal(V(), coalesce(pipe(out('G'))), count()), g)).toEqual([0]);
    bothWays(out('E'), []);
    bothWays(out('G'), []);
  });

  test('`in(E)` as arm 0, which reads the other box', () => {
    bothWays(in_('E'), [pipe(identity())]);
  });
});

describe('the fast arm declines what it must', () => {
  test('`both`, a MULTI-TYPE arm and an UNTYPED arm all keep the general loop', () => {
    bothWays(both('E'), [pipe(identity())]);
    bothWays(out('E', 'F'), [pipe(identity())]);
    bothWays(out(), [pipe(identity())]);
  });

  test('a LONGER first arm', () => {
    const fast = toArray(
      traversal(V(), coalesce(pipe(out('E'), out('E')), pipe(identity())), values('k')),
      g,
    );

    expect(fast.length).toBeGreaterThan(0);
    // And the same question with a third step in arm 0 answers identically.
    expect(
      toArray(
        traversal(
          V(),
          coalesce(pipe(out('E'), out('E'), identity()), pipe(identity())),
          values('k'),
        ),
        g,
      ),
    ).toEqual(fast);
  });

  test('⚠️ a single hop in a LATER arm must not be mistaken for arm 0', () => {
    /**
     * ⚠️ THE MUTANT THAT FOUND THIS SURVIVED THE REST OF THE FILE. Reading
     * `optionalSingleHop(plans[plans.length - 1])` instead of `plans[0]` is answer-equivalent for
     * every shape above, because in all of them the LAST arm is `identity()` — which
     * `optionalSingleHop` refuses — so the fast arm simply never engaged.
     *
     * The shape that separates them has a first arm the fusion REFUSES and a last arm it would
     * accept: with the mutant, arm 1's `out(F)` runs as if it were arm 0, and the two-hop arm never
     * runs at all. Derived answer [3, 3, 3, 3, 2, 3] — the two-hop `E` walk for the four vertices
     * that have one, then `out(F)` for `a`... which is why the oracle spelling is asserted beside it
     * rather than a literal alone.
     */
    const fast = toArray(
      traversal(V(), coalesce(pipe(out('E'), out('E')), pipe(out('F'))), values('k')),
      g,
    );

    expect(fast).toEqual([3, 3, 3, 3, 2, 3]);
    expect(
      toArray(
        traversal(V(), coalesce(pipe(out('E'), out('E'), identity()), pipe(out('F'))), values('k')),
        g,
      ),
    ).toEqual(fast);
  });

  test('NO arms at all', () => {
    expect(toArray(traversal(V(), coalesce(), count()), g)).toEqual([0]);
  });
});
