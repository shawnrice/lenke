// A residual `count()` counted on the walk's drain (item 2020).
//
// **THIS IS GENERIC — EVERY FUSED WALK WITH A `count()` RESIDUAL NOW TAKES IT**, not one rung.
// So the question is not "does the edge-filter shape count correctly" but "does `count` still mean
// what it meant for every shape that reaches a fused walk".
//
// THE ORACLE IS THE SAME WALK WITHOUT `count()`. `toArray(V().out('E'))` returns the rows and
// takes the drain directly (its `rest` is empty), so its `.length` is what `count()` must equal —
// an oracle that does not depend on the code under test. Where a shape's row list is awkward, the
// hand-computed number is written out instead.
//
// `count` CARRIES A SCOPE and a LOCAL one is a different question — it counts each traverser's
// own iterable value, not the stream. It must be refused and still answer correctly.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  both,
  choose,
  constant,
  count,
  fold,
  gt,
  has,
  identity,
  inV,
  out,
  outE,
  Scope,
  toArray,
  traversal,
  V,
  run,
  values,
} from '../index.js';
import { fusableProjectedCount } from './aggregation.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * `k` IS SPARSE: `d` has no `k`, so a `values('k')` projection DROPS it — and a `count()` after
   * that projection must count the DROPPED-OUT total, not the element total. That is the one place
   * `count` over a fused walk can disagree with "number of elements visited".
   */
  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', undefined],
    ['e', 5],
  ] as const) {
    g.addVertex({
      id,
      labels: ['T'],
      properties: k === undefined ? {} : { k },
    });
  }

  let seq = 0;
  const E = (fr: string, to: string, w: number, label = 'E'): void => {
    seq += 1;

    g.addEdge({
      id: `e${seq}`,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(to)!,
      labels: [label],
      properties: { w },
    });
  };

  E('a', 'b', 1);
  E('a', 'c', 5);
  E('a', 'd', 7); // `d` has no `k`
  E('b', 'c', 9);
  E('b', 'e', 2);
  E('c', 'd', 6, 'F'); // another type
  E('d', 'd', 8); // a self-loop
  // `e` has no out-edge.

  return g;
};

/** The count the engine reports, unwrapped from Gremlin's one-element reducing stream. */
const counted = (t: ReturnType<typeof traversal>, g: Graph): unknown => toArray(t, g)[0];

describe('a residual count() equals the walk it counts', () => {
  const g = build();

  /*
   * EACH SHAPE IS WRITTEN TWICE — plain and with `count()` — rather than splicing `count()` onto
   * a built plan. `traversal(...)` takes step FUNCTIONS, not the AST nodes a built `Plan` holds, so
   * `traversal(...plan.steps, count())` throws. Writing the pair out is also what makes the oracle
   * honest: the plain shape's `rest` is EMPTY, so it takes the drain directly and does not share the
   * code under test.
   */
  const PAIRS = [
    ['hop', () => traversal(V(), out('E')), () => traversal(V(), out('E'), count())],
    [
      'hop values',
      () => traversal(V(), out('E'), values('k')),
      () => traversal(V(), out('E'), values('k'), count()),
    ],
    ['edge hop', () => traversal(V(), outE('E')), () => traversal(V(), outE('E'), count())],
    [
      'edge filter + move',
      () => traversal(V(), outE('E'), has('w', gt(3)), inV()),
      () => traversal(V(), outE('E'), has('w', gt(3)), inV(), count()),
    ],
    [
      'edge filter, edge-valued',
      () => traversal(V(), outE('E'), has('w', gt(3))),
      () => traversal(V(), outE('E'), has('w', gt(3)), count()),
    ],
    [
      'edge filter + values',
      () => traversal(V(), outE('E'), has('w', gt(3)), values('w')),
      () => traversal(V(), outE('E'), has('w', gt(3)), values('w'), count()),
    ],
    ['both', () => traversal(V(), both('E')), () => traversal(V(), both('E'), count())],
    [
      'two hops',
      () => traversal(V(), out('E'), out('E')),
      () => traversal(V(), out('E'), out('E'), count()),
    ],
    ['untyped hop', () => traversal(V(), out()), () => traversal(V(), out(), count())],
  ] as const;

  test('every shape agrees with its own row list', () => {
    for (const [name, plain, withCount] of PAIRS) {
      const rows = toArray(plain(), g);

      // A NON-EMPTY ROW LIST IS ASSERTED FIRST: `0 === 0` agrees trivially, and an always-zero
      // count would pass every comparison below. The empty case is checked on its own further down.
      expect(rows.length).toBeGreaterThan(0);
      expect(counted(withCount(), g)).toBe(rows.length);
      void name;
    }
  });

  test('a `values(k)` projection DROPS, and the count follows the drop', () => {
    /*
     * **THE ONE CASE WHERE "COUNT" AND "ELEMENTS VISITED" DIVERGE.** Six `E` edges are walked,
     * but two of them land on `d`, which has no `k` — so `values('k')` emits FOUR values. A count
     * taken from the walk's element total rather than its EMITTED total would say six.
     */
    expect(counted(traversal(V(), out('E'), count()), g)).toBe(6);
    expect(counted(traversal(V(), out('E'), values('k'), count()), g)).toBe(4);
  });

  test('an EMPTY result counts 0, not nothing', () => {
    // A reducing terminal emits ONE row even over an empty stream — Gremlin's contract, and where
    // an implementation that passed the stream through unchanged would show.
    expect(toArray(traversal(V(), out('NOPE'), count()), g)).toEqual([0]);
    expect(toArray(traversal(V(), outE('E'), has('w', gt(999)), inV(), count()), g)).toEqual([0]);
  });

  test('the self-loop and the second edge type are counted once each', () => {
    // `d -> d` is one of the six `E` edges; `c -> d` is `F` and must not appear in an `E` count.
    expect(counted(traversal(V(), outE('E'), count()), g)).toBe(6);
    expect(counted(traversal(V(), outE('F'), count()), g)).toBe(1);
    // The untyped hop sees both types: 6 + 1.
    expect(counted(traversal(V(), out(), count()), g)).toBe(7);
  });
});

describe('what the count residual must REFUSE', () => {
  const g = build();

  test('count(Scope.local) is refused and still answers correctly', () => {
    /*
     * **A LOCAL COUNT IS A DIFFERENT QUESTION** — it counts each traverser's own iterable value
     * rather than the stream. After `fold()` the stream holds ONE list of six elements, so
     * `count(Scope.local)` is 6 while a GLOBAL count is 1. An implementation that ignored the scope
     * would answer 1 for both. `count` carries that scope where `fold` does not, which is why
     * `fusableProjectedCount` guards it and `fusableProjectedFold` deliberately does not.
     */
    expect(counted(traversal(V(), out('E'), fold(), count(Scope.local)), g)).toBe(6);
    expect(counted(traversal(V(), out('E'), fold(), count()), g)).toBe(1);
  });

  test('a count that is not the LAST step declines, and answers the same', () => {
    // `count()` followed by another step leaves `rest.length > 1`, so the fused case declines and
    // the generic route runs. Same answer either way, which is the point.
    expect(counted(traversal(V(), out('E'), count(), identity()), g)).toBe(6);
  });
});

describe('the DRAIN-LESS branch, which every other shape here skips', () => {
  const g = build();

  test('a walk with NO `drain` is counted in one pass', () => {
    /*
     * **`countIterable` WAS UNREACHED BY EVERY TEST ABOVE AND A MUTANT PROVED IT**: changing
     * `n += 1` to `n += 2` survived this whole file AND the entire @lenke/gremlin suite, because
     * every shape above offers a `drain` and takes `drain().length` instead. Not dead code —
     * several rungs return a walk with no drain (item 2014's `choose-test-values.ts` among them,
     * plus one arm of `hop-values.ts` and one of `tagged-hop-values.ts`), so the branch is live and
     * was simply untested.
     *
     * `choose(<one hop>, <value arm>, <value arm>)` is the clearest: item 2014 gave it an iterator
     * and no drain. Asserted below, so a later edit that ADDS a drain there makes this test fail
     * loudly rather than silently moving the coverage back off this branch.
     */
    const plain = (): ReturnType<typeof traversal> =>
      traversal(V(), choose(out('E'), values('k'), constant('x')));

    expect(typeof (run(plain(), g) as { drain?: unknown }).drain).toBe('undefined');

    const rows = toArray(plain(), g);

    expect(rows.length).toBeGreaterThan(0);
    expect(counted(traversal(V(), choose(out('E'), values('k'), constant('x')), count()), g)).toBe(
      rows.length,
    );
  });
});

describe('fusableProjectedCount: the gate itself', () => {
  /*
   * **THE ROUTE CHOICE IS ANSWER-EQUIVALENT — the generic route returns the same numbers — so
   * nothing in the answer tests can see the fused case being declined.** The mutation round proved
   * it: forcing the gate to refuse every count ("count-never-fused") survived this file and the
   * whole suite. These assertions are the only thing that holds it
   * ([[perf-gate-needs-its-own-test]]), and they also cover the three gate-widening mutants, which
   * the answer tests could only catch through the wide suite.
   */
  const step = (over: Record<string, unknown>) => [{ kind: 'count', ...over }] as never;

  test('TAKES a global count, with the scope absent or explicit', () => {
    expect(fusableProjectedCount(step({}))).toBe(true);
    expect(fusableProjectedCount(step({ scope: undefined }))).toBe(true);
    expect(fusableProjectedCount(step({ scope: 'global' }))).toBe(true);
  });

  test('REFUSES a LOCAL scope — a different question, not a slower one', () => {
    expect(fusableProjectedCount(step({ scope: 'local' }))).toBe(false);
  });

  test('REFUSES another kind, and a residual that is not exactly one step', () => {
    expect(fusableProjectedCount([{ kind: 'fold' }] as never)).toBe(false);
    expect(fusableProjectedCount([] as never)).toBe(false);
    expect(fusableProjectedCount([{ kind: 'count' }, { kind: 'identity' }] as never)).toBe(false);
  });
});
