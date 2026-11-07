import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  both,
  eq,
  gt,
  has,
  hasLabel,
  id,
  neq,
  out,
  toArray,
  traversal,
  values,
  within,
} from '../index.js';

/**
 * A SINGLE `has` far filter is collapsed into one closure (item 1631): `pick` reads the property
 * and applies `specializePredicate`'s test directly, instead of `pick` calling `survives`, which
 * iterates a one-element array to call a gate, which calls the same specialized test.
 *
 * ⚠️ THE PREDICATE SEMANTICS ARE UNTOUCHED BY CONSTRUCTION, and that is the whole equivalence
 * argument. The collapsed arm calls `specializePredicate(only.pred)` — the identical function
 * `compileGates` already calls to build the gate — so the comparison performed is the same
 * function on the same object. What changes is only how many invocations stand between the walk
 * and that function. (This matters because specialized `eq` is `v === b` while `matches` uses
 * `valueEq`, and those are NOT the same for every value; that difference already existed inside
 * `compileGates` and this change neither widens nor narrows it.)
 *
 * ⚠️ TWO ORACLES ROUTE THE IDENTICAL QUESTION THROUGH THE GENERAL `survives` PATH:
 *
 *   1. A VACUOUS trailing `hasLabel('P')` — every vertex carries `P`, so the answer is unchanged
 *      while `farFilters.length` becomes 2 and the collapse declines.
 *   2. A predicate `specializePredicate` refuses (`present`, `within`), which leaves `fastOne`
 *      undefined.
 *
 * The fixture, and every literal below is derived from it. All six vertices carry `P`; `c` also
 * carries `Q`. Only `s` has out-edges, in this insertion order:
 *
 * ```text
 *   s  k=9       n=90   >a >b >c >d >e >f
 *   a  k=1       n=10
 *   b  k=2       n=20
 *   c  k=1       n=30   also labelled Q
 *   d  (NO k)    n=40          <- a MISSING key, which `neq` admits and `gt` rejects
 *   e  k=null    n=50          <- a PRESENT null, which is not the same as missing
 *   f  k=1       (NO n)        <- passes the filter and has nothing to project
 * ```
 */
const TABLE = [
  { id: 's', k: 9, n: 90, labels: ['P'], out: ['a', 'b', 'c', 'd', 'e', 'f'] },
  { id: 'a', k: 1, n: 10, labels: ['P'], out: [] },
  { id: 'b', k: 2, n: 20, labels: ['P'], out: [] },
  { id: 'c', k: 1, n: 30, labels: ['P', 'Q'], out: [] },
  { id: 'd', k: undefined, n: 40, labels: ['P'], out: [] },
  { id: 'e', k: null, n: 50, labels: ['P'], out: [] },
  { id: 'f', k: 1, n: undefined, labels: ['P'], out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = { id: r.id };

    // ⚠️ `undefined` MEANS THE KEY IS ABSENT, not that it holds undefined — the numeric model
    // converts a written `undefined` to `null`, so writing it would make `d` indistinguishable
    // from `e` and collapse the two cases this fixture exists to separate.
    if (r.k !== undefined) {
      properties.k = r.k;
    }

    if (r.n !== undefined) {
      properties.n = r.n;
    }

    graph.addVertex({ id: r.id, labels: [...r.labels], properties });
  }

  let i = 0;

  for (const r of TABLE) {
    for (const to of r.out) {
      graph.addEdge({
        id: `e${i++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: ['E'],
        properties: {},
      });
    }
  }

  return graph;
})();

describe('the collapsed single-`has` far filter answers what `survives` answers', () => {
  test('the fixture emits the six far ends the literals are derived from', () => {
    expect(toArray(traversal(V(), out('E'), id()), g)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('`eq` — the shape at 1.07x, and the vacuous-label oracle agrees', () => {
    /**
     * DERIVED: `k === 1` keeps `a`, `c`, `f`. Projecting `n` then DROPS `f`, which has no `n`, so
     * the answer is [10, 30] while the `id()` spelling keeps all three.
     */
    expect(toArray(traversal(V(), out('E'), has('k', eq(1)), values('n')), g)).toEqual([10, 30]);
    expect(toArray(traversal(V(), out('E'), has('k', eq(1)), id()), g)).toEqual(['a', 'c', 'f']);

    // ORACLE 1: `hasLabel('P')` is carried by every vertex, so it changes nothing but the branch.
    expect(
      toArray(traversal(V(), out('E'), has('k', eq(1)), hasLabel('P'), values('n')), g),
    ).toEqual([10, 30]);
    expect(toArray(traversal(V(), out('E'), has('k', eq(1)), hasLabel('P'), id()), g)).toEqual([
      'a',
      'c',
      'f',
    ]);
  });

  test('⚠️ `neq` ADMITS A MISSING KEY, and both branches must agree that it does', () => {
    /**
     * This is the case where a specialized predicate and `matches` could plausibly disagree, so it
     * gets a literal AND the oracle. Specialized `neq` is `v !== 1`, and a far vertex with no `k`
     * reads `undefined`, which is `!== 1` — so `d` SURVIVES. `e`'s present null does too.
     *
     * DERIVED: keeps `b`(20), `d`(40), `e`(50); `s` is not a far end of anything.
     */
    expect(toArray(traversal(V(), out('E'), has('k', neq(1)), values('n')), g)).toEqual([
      20, 40, 50,
    ]);
    expect(
      toArray(traversal(V(), out('E'), has('k', neq(1)), hasLabel('P'), values('n')), g),
    ).toEqual([20, 40, 50]);
  });

  test('⚠️ `gt` REJECTS a missing key where `neq` admits it — the contrast is the point', () => {
    /**
     * Specialized `gt` is `typeof v === 'number' && v > b`, so `d` (no `k`) and `e` (null) are both
     * rejected however low the bound. DERIVED with bound 0: `a`(1), `b`(2), `c`(1), `f`(1, no `n`)
     * survive, so projecting `n` gives [10, 20, 30].
     */
    expect(toArray(traversal(V(), out('E'), has('k', gt(0)), values('n')), g)).toEqual([
      10, 20, 30,
    ]);
    expect(
      toArray(traversal(V(), out('E'), has('k', gt(0)), hasLabel('P'), values('n')), g),
    ).toEqual([10, 20, 30]);
  });

  test('a bare hop with the filter keeps the far VERTEX', () => {
    const fast = toArray(traversal(V(), out('E'), has('k', eq(1))), g) as Vertex[];

    expect(fast.map((v) => v.id)).toEqual(['a', 'c', 'f']);

    const general = toArray(
      traversal(V(), out('E'), has('k', eq(1)), hasLabel('P')),
      g,
    ) as Vertex[];

    expect(general.map((v) => v.id)).toEqual(['a', 'c', 'f']);
  });

  test('`both` carries the collapse too, and agrees with its oracle', () => {
    // `both` has its own walk and its own `drain`; the composed `pick` is shared by all three.
    const fast = toArray(traversal(V(), both('E'), has('k', eq(1)), values('n')), g);
    const general = toArray(
      traversal(V(), both('E'), has('k', eq(1)), hasLabel('P'), values('n')),
      g,
    );

    expect(fast).toEqual(general);
    // `s -> a` is reachable from `a` via `both`, and `s`'s own `k` is 9, so the only survivors are
    // still the three with k=1 — reached from `s`.
    expect(fast).toEqual([10, 30]);
  });
});

describe('the collapse declines what it must', () => {
  test('a PRESENCE predicate declines — `specializePredicate` refuses it', () => {
    /**
     * DERIVED: `has('k')` is presence, which keeps every far end whose `k` is not absent — `a`, `b`,
     * `c`, `e`, `f`; only `d` lacks the key. A PRESENT NULL counts as present, which is the
     * distinction `matches`' `present` arm exists for. Projecting `n` drops `f`.
     */
    expect(toArray(traversal(V(), out('E'), has('k'), values('n')), g)).toEqual([10, 20, 30, 50]);
  });

  test('`within` declines — also not specializable', () => {
    expect(toArray(traversal(V(), out('E'), has('k', within(1, 2)), values('n')), g)).toEqual([
      10, 20, 30,
    ]);
  });

  test('a `hasLabel` far filter declines — the collapse has nothing to offer a label test', () => {
    // DERIVED: only `c` carries `Q`.
    expect(toArray(traversal(V(), out('E'), hasLabel('Q'), values('n')), g)).toEqual([30]);
  });

  test('⚠️ TWO `has` filters must BOTH apply — not just the first', () => {
    /**
     * The guard is `farFilters.length === 1`. A mutant reading `farFilters[0]` regardless would
     * apply only the first filter, so the second must CHANGE the answer: `k === 1` keeps `a`, `c`,
     * `f` and `n === 30` narrows that to `c` alone. [30], not [10, 30].
     */
    expect(
      toArray(traversal(V(), out('E'), has('k', eq(1)), has('n', eq(30)), values('n')), g),
    ).toEqual([30]);
    // And in the other order, which must agree — the filters are a conjunction.
    expect(
      toArray(traversal(V(), out('E'), has('n', eq(30)), has('k', eq(1)), values('n')), g),
    ).toEqual([30]);
  });

  test('⚠️ the FILTER key and the PROJECTED key are not interchangeable', () => {
    /**
     * A mutant reading the projection's key as the filter's (or vice versa) would answer this
     * identically if the two were ever the same key, so they are deliberately different throughout
     * this file. Filtering on `n` and projecting `k` is the mirror: `n === 10` keeps `a`, whose `k`
     * is 1.
     */
    expect(toArray(traversal(V(), out('E'), has('n', eq(10)), values('k')), g)).toEqual([1]);
    expect(toArray(traversal(V(), out('E'), has('k', eq(1)), values('n')), g)).toEqual([10, 30]);
  });
});
