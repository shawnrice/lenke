import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  as_,
  both,
  hasLabel,
  identity,
  limit,
  optional,
  out,
  pipe,
  select,
  toArray,
  traversal,
  values,
} from '../index.js';
import type { Plan } from '../index.js';

/**
 * ⚠️ THE LAZY HALF OF EVERY FUSED WALK (item 1616).
 *
 * Item 1615 found that two mutants SURVIVED in a fused walk's LAZY loop while their EAGER twins
 * died. The cause is structural rather than one file's oversight: every `HopWalk` in this executor
 * is written twice — a generator and a `drain()` — and `toArray` with an empty residual reads
 * `drain`, so a suite that only calls `toArray` reaches the eager copy and never the generator.
 * `hop-values.ts`' header states the rule that keeps the two loops from DRIFTING; nothing stated
 * that the tests reach both.
 *
 * So item 1616 screened it mechanically: duplicate every `yield` in the executor's lazy walks, one
 * at a time, and run the suite. A duplicated emission changes the answer of every query routed
 * through that loop, so a SURVIVOR means no test drains it lazily at all. Nine of thirteen sites
 * died; these are the four that did not:
 *
 * ```text
 *   hop-values.ts:454                  the THREE-OR-MORE-TYPES walk (`manyTypes`)
 *   start-filtered-hop-values.ts:229   the `both(T)` walk, OUT bucket
 *   start-filtered-hop-values.ts:241   the `both(T)` walk, IN bucket
 *   optional-hop.ts:83                 `optional`'s non-vertex PASSTHROUGH
 * ```
 *
 * ⚠️ REACHING THE LAZY LOOP TAKES A RESIDUAL. A trailing `limit` leaves a step in `rest`, so `run`
 * wraps the generator instead of reading `drain` — which is the only spelling that routes there.
 * (`eager-tail-cache` is why `drain` must never be read under a `limit` in the first place.)
 *
 * ⚠️ AND THE ORACLE IS THE PIPELINE, compared ORDERED. All three values shortcuts decline a
 * `V(id, …)` source, so the same query with every vertex id listed in `graph.vertices` order runs
 * the identical question down the traverser pipeline — `sourceFromIds` neither dedupes nor
 * reorders. Gremlin stream order is a TinkerPop contract the differential fuzzer compares ordered,
 * so an array comparison is the right assertion and a count is not.
 *
 * `>` is `E`, `~` is `F`, `-` is `G`:
 *
 * ```text
 *   a  [Q]   k=1  >b ~c -d
 *   b  [Q]   k=2  >c ~a
 *   c  [R]   k=3  -a
 *   d  [Q]   (no k)  >a      a MISSING property, so `values(k)` drops it
 *   e  [R]   k=5            no edges at all
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['Q'],
    k: 1,
    out: [
      ['b', 'E'],
      ['c', 'F'],
      ['d', 'G'],
    ],
  },
  {
    id: 'b',
    labels: ['Q'],
    k: 2,
    out: [
      ['c', 'E'],
      ['a', 'F'],
    ],
  },
  { id: 'c', labels: ['R'], k: 3, out: [['a', 'G']] },
  { id: 'd', labels: ['Q'], k: undefined, out: [['a', 'E']] },
  { id: 'e', labels: ['R'], k: 5, out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = {};

    if (r.k !== undefined) {
      properties.k = r.k;
    }

    graph.addVertex({ id: r.id, labels: [...r.labels], properties });
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

type Tail = readonly Parameters<typeof traversal>[number][];

/** Through the shortcut (`V()`), with a residual so the LAZY generator is what runs. */
const lazily = (tail: Tail): unknown[] => toArray(traversal(V(), ...tail), g);
/** The same question with an explicit id source, which every values shortcut declines. */
const viaPipeline = (tail: Tail): unknown[] => toArray(traversal(V(...ALL_IDS), ...tail), g);

describe('`hop-values.ts` — the three-or-more-types walk, lazily', () => {
  /**
   * `manyTypes` is the arm for 3+ named types; `oneType` and `pairTypes` are specializations below
   * it, and both of those already had lazy coverage. Three types are needed to reach it at all.
   */
  test('`out(E, F, G).values(k)` under a residual', () => {
    /**
     * Derived. Bucket order is the ORDER THE TRAVERSAL NAMED, which this walk preserves on purpose
     * (`hop-values.ts`: GQL sorts largest-bucket-first and Gremlin must not). Per vertex: `a` emits
     * E=b(2), F=c(3), G=d(no k, DROPPED); `b` emits E=c(3), F=a(1); `c` emits G=a(1); `d` emits
     * E=a(1); `e` nothing. So [2, 3, 3, 1, 1, 1].
     */
    const tail = [out('E', 'F', 'G'), values('k'), limit(10)];

    expect(lazily(tail)).toEqual([2, 3, 3, 1, 1, 1]);
    expect(lazily(tail)).toEqual(viaPipeline(tail));
  });

  test('a SHORT limit, so the generator is abandoned part way', () => {
    // The point of laziness: taking two must not require walking the rest.
    expect(lazily([out('E', 'F', 'G'), values('k'), limit(2)])).toEqual([2, 3]);
    expect(lazily([out('E', 'F', 'G'), values('k'), limit(2)])).toEqual(
      viaPipeline([out('E', 'F', 'G'), values('k'), limit(2)]),
    );
  });

  test('the EAGER twin answers the same rows — the drift check', () => {
    // No residual, so `drain` is what `toArray` reads. Same rows, same order, by construction.
    expect(lazily([out('E', 'F', 'G'), values('k')])).toEqual([2, 3, 3, 1, 1, 1]);
  });
});

describe('`start-filtered-hop-values.ts` — the `both(T)` walk, lazily', () => {
  /**
   * `both` emits the OUT bucket then the IN bucket, per vertex — `iterBoth`'s contract and
   * TinkerPop's ordering. Two separate `yield` sites, and the screen found BOTH uncovered.
   */
  test('`hasLabel(Q).both(E).values(k)` under a residual', () => {
    /**
     * Derived, and `Q` is SELECTIVE so the label is not dropped as vacuous — `c` and `e` are `R`.
     * `E` edges: a>b, b>c, d>a. Per `Q` vertex in graph order:
     *   a: out E -> b(2); in E -> from d, which has NO k, DROPPED
     *   b: out E -> c(3); in E -> from a(1)
     *   d: out E -> a(1); in E -> none
     * So [2, 3, 1, 1].
     */
    const tail = [hasLabel('Q'), both('E'), values('k'), limit(10)];

    expect(lazily(tail)).toEqual([2, 3, 1, 1]);
    expect(lazily(tail)).toEqual(viaPipeline(tail));
  });

  test('a limit that stops INSIDE a vertex’s two buckets', () => {
    /**
     * ⚠️ THE LIMIT THAT SEPARATES THE TWO YIELD SITES. `limit(1)` takes only `a`'s out-bucket row,
     * so a mutant in the IN-bucket emission would survive it; `limit(3)` crosses from `b`'s out
     * bucket into `b`'s in bucket, which is the first row the second site produces. Both are
     * asserted, because one `limit` cannot reach both sites.
     */
    expect(lazily([hasLabel('Q'), both('E'), values('k'), limit(1)])).toEqual([2]);
    expect(lazily([hasLabel('Q'), both('E'), values('k'), limit(3)])).toEqual([2, 3, 1]);
  });

  test('the EAGER twin answers the same rows', () => {
    expect(lazily([hasLabel('Q'), both('E'), values('k')])).toEqual([2, 3, 1, 1]);
  });
});

describe('`optional-hop.ts` — the non-vertex passthrough', () => {
  /**
   * ⚠️ NOT A LAZY/EAGER PAIR but the same class of hole: a BRANCH no test reached. `optionalHopStep`
   * emits the traverser unchanged when its value is not a vertex, mirroring what the general path
   * does (`traverseToVertex` yields nothing for a non-vertex, so `optionalStep`'s empty branch fires).
   *
   * Reaching it took three attempts, and the first three spellings all RAISED instead: the static
   * frontier check rejects `values(k).optional(out(E))`, `inject(…)` and `id()` with "out() moves
   * from a vertex, but the frontier is a scalar". What gets through is a frontier the checker cannot
   * type — a `select` of a tag holding a scalar — so the branch is reachable, and the mutant survived
   * because nothing tested it rather than because it is dead code.
   *
   * THE ORACLE IS THE GENERAL PATH: a two-step sub-plan (`out(E), identity()`) is not the fused
   * shape, so it runs `optionalStep`. The two must agree, which is this module's whole claim.
   */
  const scalarFrontier = (inner: Parameters<typeof traversal>[number]): Plan =>
    traversal(V(), values('k'), as_('a'), select('a'), inner);

  test('a scalar frontier passes through unchanged', () => {
    const fused = toArray(scalarFrontier(optional(pipe(out('E')))), g);

    // `values('k')` over the five vertices drops `d`, leaving [1, 2, 3, 5] — and `optional` must
    // emit each scalar once, not drop it and not duplicate it.
    expect(fused).toEqual([1, 2, 3, 5]);
    expect(fused).toEqual(toArray(scalarFrontier(optional(pipe(out('E'), identity()))), g));
  });

  test('and the VERTEX branches still agree with the general path', () => {
    const ids = (plan: Plan): unknown[] =>
      toArray(plan, g).map((x) => (x !== null && typeof x === 'object' && 'id' in x ? x.id : x));

    // `a`,`b`,`d` have `E` out-edges; `c` and `e` have none, so they emit themselves.
    expect(ids(traversal(V(), optional(pipe(out('E')))))).toEqual(['b', 'c', 'c', 'a', 'e']);
    expect(ids(traversal(V(), optional(pipe(out('E')))))).toEqual(
      ids(traversal(V(), optional(pipe(out('E'), identity())))),
    );
  });
});
