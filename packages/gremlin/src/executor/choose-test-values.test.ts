// `V().choose(<one hop>, <value arm>, <value arm>)` fused (item 2014).
//
// **A ROUTE CHOICE, SO ANSWER-EQUIVALENT — the 2,464-test suite passes either way.** The route
// assertions here are the only thing that can see a gate mutant ([[perf-gate-needs-its-own-test]]),
// and the answer assertions the only thing that can see a walk mutant, because the general
// `chooseStep` answers identically.
//
// THE FIXTURE'S ONE REQUIREMENT, and the pricing fixture failed it: **the projected property must
// be MISSING on some vertex that PASSES the test.** The three arm kinds disagree about exactly that
// and nothing else:
//
//     values(k)     emits NOTHING for a vertex without `k`  — the row DISAPPEARS
//     identity()    emits the vertex itself                 — always one row
//     constant(c)   emits `c`                               — always one row
//
// `coalesce-vs-optional-1990.mjs`, which priced this rung at 9.9x, gives every vertex an `n` — so a
// route emitting `undefined` for a missing key would have agreed with it perfectly and diverged on
// any graph with a sparse property. `b` below has an `E` edge and no `n`.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  both,
  choose,
  constant,
  has,
  identity,
  in_,
  out,
  toArray,
  traversal,
  V,
  values,
} from '../index.js';
import { chooseTestValues } from './choose-test-values.js';

const build = (): Graph => {
  const g = new Graph();

  // `n` IS SPARSE: `a`, `c`, `e` have it; `b`, `d`, `f` do not.
  for (const [id, props] of [
    ['a', { n: 1, m: 'x' }],
    ['b', {}],
    ['c', { n: 3 }],
    ['d', {}],
    ['e', { n: 5, m: 'y' }],
    ['f', {}],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { ...props } });
  }

  const E = (k: string, fr: string, t: string, l = 'E'): void => {
    g.addEdge({
      id: k,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(t)!,
      labels: [l],
      properties: {},
    });
  };

  E('e1', 'a', 'b');
  E('e2', 'b', 'c');
  E('e3', 'c', 'a');
  E('e4', 'd', 'e', 'F'); // only an F edge: `d` fails an E test and passes an F one
  // `e` has an inbound F edge only; `f` has no edge at all.

  return g;
};

describe('chooseTestValues: the route', () => {
  const g = build();
  const routed = (t: ReturnType<typeof traversal>): boolean => chooseTestValues(t, g) !== undefined;

  test('TAKES a hop test with every combination of value arms', () => {
    expect(routed(traversal(V(), choose(out('E'), values('n'), constant('none'))))).toBe(true);
    expect(routed(traversal(V(), choose(out('E'), constant('none'), values('n'))))).toBe(true);
    expect(routed(traversal(V(), choose(out('E'), values('n'), identity())))).toBe(true);
    expect(routed(traversal(V(), choose(out('E'), identity(), constant('none'))))).toBe(true);
  });

  test('TAKES the absent-else form and the inward / both / untyped tests', () => {
    expect(routed(traversal(V(), choose(out('E'), values('n'))))).toBe(true);
    expect(routed(traversal(V(), choose(in_('E'), values('n'), constant('none'))))).toBe(true);
    expect(routed(traversal(V(), choose(both('E'), values('n'), constant('none'))))).toBe(true);
    expect(routed(traversal(V(), choose(out(), values('n'), constant('none'))))).toBe(true);
    expect(routed(traversal(V(), choose(out('E', 'F'), values('n'), constant('none'))))).toBe(true);
  });

  test('DECLINES a VERTEX-FILTER test — that is item 1999’s rung, not this one', () => {
    // THE TWO RUNGS MUST NOT CONTEND. `choose-hop-values.ts` takes a filter test with HOP arms and
    // explicitly declines a hop test; this takes a hop test with VALUE arms. A gate that admitted
    // both kinds of test here would start answering shapes with the wrong walk.
    expect(routed(traversal(V(), choose(has('n', 1), values('n'), constant('none'))))).toBe(false);
  });

  test('DECLINES a HOP arm, a multi-key values and a multi-step test', () => {
    expect(routed(traversal(V(), choose(out('E'), out('E'), constant('none'))))).toBe(false);
    expect(routed(traversal(V(), choose(out('E'), values('n', 'm'), constant('none'))))).toBe(
      false,
    );
    expect(
      routed(traversal(V(), choose(traversal(out('E'), out('E')), values('n'), constant('none')))),
    ).toBe(false);
  });

  test('DECLINES a MULTI-STEP arm even when its FIRST step is admissible', () => {
    /*
     * THE LENGTH CHECK IS LOAD-BEARING AND A MUTANT PROVED IT. `valueArmOf` reads `steps[0]`, so
     * without `plan.steps.length !== 1` a two-step arm whose FIRST step is a `values` would be
     * treated as a bare `values` and the second step silently dropped. A multi-step arm that starts
     * with a HOP declines on the kind check instead, which is why the case below has to start with
     * an admissible step to reach the length check at all.
     */
    expect(
      routed(traversal(V(), choose(out('E'), traversal(values('n'), identity()), constant('x')))),
    ).toBe(false);
    expect(
      routed(traversal(V(), choose(out('E'), constant('x'), traversal(values('n'), identity())))),
    ).toBe(false);
  });

  test('DECLINES a non-admissible ELSE arm rather than reading it as ABSENT', () => {
    /*
     * A MUTANT HERE IS A WRONG ANSWER, NOT A SLOW ONE. `valueArmOf` returns `null` for an arm it
     * cannot serve, and the gate must DECLINE on that — because `otherwise ?? undefined` would
     * otherwise turn a refused else into an ABSENT one, and an absent else PASSES THE TRAVERSER
     * THROUGH. So `choose(out(E), values(n), out(E))` would answer the vertex itself where the
     * general path answers the hop.
     */
    expect(routed(traversal(V(), choose(out('E'), values('n'), out('E'))))).toBe(false);
    // A SECOND CASE HERE ASSERTED THAT `choose(test, then, else, extra)` DECLINES, AND THAT WAS MY
    // ERROR, NOT THE GATE'S: the builder simply ignores a fourth argument, so that traversal IS
    // `choose(test, values, identity)` and is correctly admitted. The assertion was testing the
    // builder's arity, not this rung — removed rather than weakened.
    expect(routed(traversal(V(), choose(out('E'), values('n'), both('E'))))).toBe(false);
  });

  test('DECLINES a narrowed source', () => {
    expect(routed(traversal(V('a'), choose(out('E'), values('n'), constant('none'))))).toBe(false);
  });
});

describe('chooseTestValues: the answers', () => {
  const g = build();
  const rows = (t: ReturnType<typeof traversal>): unknown[] => toArray(t, g);

  test('`values` DROPS a vertex that passes the test but lacks the key', () => {
    /*
     * THE CENTRAL ASSERTION. `a`, `b`, `c` all have an `E` out-edge, so all three take the THEN
     * arm — but `b` has no `n`, so it emits NOTHING. FIVE rows for six vertices. A route emitting
     * `undefined` would give six, and every other assertion in this file would still pass.
     */
    expect(rows(traversal(V(), choose(out('E'), values('n'), constant('none'))))).toEqual([
      1,
      3,
      'none',
      'none',
      'none',
    ]);
  });

  test('`identity` and `constant` never drop', () => {
    expect(rows(traversal(V(), choose(out('E'), identity(), constant('none'))))).toHaveLength(6);
    expect(rows(traversal(V(), choose(out('E'), constant('yes'), constant('no'))))).toEqual([
      'yes',
      'yes',
      'yes',
      'no',
      'no',
      'no',
    ]);
  });

  test('an ABSENT else arm PASSES THE TRAVERSER THROUGH', () => {
    // Per TinkerPop, which `chooseStep`'s own comment records against the AST comment that reads the
    // other way. `d`, `e`, `f` fail the test and come back as themselves.
    const got = rows(traversal(V(), choose(out('E'), values('n'))));

    expect(got.slice(0, 2)).toEqual([1, 3]);
    expect(got).toHaveLength(5);
    expect((got[2] as { id: string }).id).toBe('d');
  });

  test('the TEST reads the adjacency it names — in, both, and a type only one vertex has', () => {
    // `in_('E')`: a, b, c each have an inbound E; d, e, f do not.
    expect(rows(traversal(V(), choose(in_('E'), constant('y'), constant('n'))))).toEqual([
      'y',
      'y',
      'y',
      'n',
      'n',
      'n',
    ]);
    // `out('F')`: only `d` has one.
    expect(rows(traversal(V(), choose(out('F'), constant('y'), constant('n'))))).toEqual([
      'n',
      'n',
      'n',
      'y',
      'n',
      'n',
    ]);
    // `both('E')` matches the same three here, which is why the `F` case above carries the weight.
    expect(rows(traversal(V(), choose(both('E'), constant('y'), constant('n'))))).toEqual([
      'y',
      'y',
      'y',
      'n',
      'n',
      'n',
    ]);
  });

  test('a trailing step after the wrapper still runs', () => {
    expect(
      rows(traversal(V(), choose(out('E'), values('n'), constant('none')), identity())),
    ).toEqual([1, 3, 'none', 'none', 'none']);
  });
});
