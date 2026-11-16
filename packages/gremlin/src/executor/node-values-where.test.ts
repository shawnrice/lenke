// `V().where(<one hop>).values(k)` — the scan with its existence filter folded in (item 2025).
//
// ⚠️⚠️ **A ROUTE CHOICE, SO ANSWER-EQUIVALENT — the pipeline answers identically.** The route
// assertions here are the only thing that can see a gate mutant ([[perf-gate-needs-its-own-test]]),
// and the answer assertions the only thing that can see a walk mutant.
//
// 🔑 THE EXISTENCE TEST IS DELIBERATELY BROADER THAN A HOP WALK'S. `sub-plan-existence.ts` admits
// `both`, a multi-type hop and an untyped one — which `soleTypeBucket` refuses — because for a
// yes/no, double-counting a two-label edge, a self-loop's duplicate under `both`, and which END the
// edge is read from are all unobservable. Those three shapes are asserted below, because a gate that
// narrowed to `soleTypeBucket`'s rules would silently decline them (slower, not wrong) and a walk
// that widened WITHOUT the existence argument would be wrong.
//
// ⚠️ AND `where` IS AN OVERLOADED STEP KIND: `where(pred)` and `where(startKey, pred)` compare the
// traverser's value to a TAGGED step's, which is not an existence test at all. Both must decline.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { both, hasLabel, in_, neq, out, toArray, traversal, V, values, where } from '../index.js';
import { nodeValuesWhereShortcut } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * ⚠️ `n` IS SPARSE: `d` has no `n`, so `values('n')` must DROP it even though it passes the filter.
   * That is the one thing the filter and the projection can disagree about.
   */
  for (const [id, n] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', undefined],
    ['e', 5],
    ['f', 6],
  ] as const) {
    g.addVertex({
      id,
      labels: ['P'],
      properties: n === undefined ? {} : { n },
    });
  }

  let seq = 0;
  const E = (fr: string, to: string, label = 'E'): void => {
    seq += 1;

    g.addEdge({
      id: `e${seq}`,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(to)!,
      labels: [label],
      properties: {},
    });
  };

  E('a', 'b'); // a has an out E
  E('d', 'e'); // d has an out E but NO `n`
  E('c', 'f', 'F'); // c has only an out F
  E('f', 'f'); // a SELF-LOOP: f is both source and target
  // `b` has only an INBOUND E; `e` only an inbound E.

  return g;
};

const rows = (t: ReturnType<typeof traversal>, g: Graph): unknown[] => toArray(t, g);

describe('nodeValuesWhereShortcut: the answers', () => {
  const g = build();

  test('an outward test keeps the vertices with an out-edge, and `values` still DROPS', () => {
    /*
     * ⚠️ `a`, `d` and `f` have an out `E`; `d` has no `n`, so TWO rows from three survivors. A walk
     * that emitted `undefined` for `d` would give three, and nothing else here would notice.
     */
    expect(rows(traversal(V(), where(traversal(out('E'))), values('n')), g)).toEqual([1, 6]);
  });

  test('an INWARD test reads the other adjacency', () => {
    // Inbound `E`: b (from a), e (from d), f (its own self-loop).
    expect(rows(traversal(V(), where(traversal(in_('E'))), values('n')), g)).toEqual([2, 5, 6]);
  });

  test('`both` is admitted — an existence test cannot double-count', () => {
    // a, b, d, e, f all touch an `E` edge in some direction; `c` has only `F`.
    expect(rows(traversal(V(), where(traversal(both('E'))), values('n')), g)).toEqual([1, 2, 5, 6]);
  });

  test('a MULTI-TYPE and an UNTYPED test are admitted too', () => {
    // `out('E','F')`: a, c, d, f. `c` has an `n`, so it appears here and not in the E-only case.
    expect(rows(traversal(V(), where(traversal(out('E', 'F'))), values('n')), g)).toEqual([
      1, 3, 6,
    ]);
    expect(rows(traversal(V(), where(traversal(out())), values('n')), g)).toEqual([1, 3, 6]);
  });

  test('a SELF-LOOP passes both directions and is counted once', () => {
    // `f -> f` is the only edge `f` has, so it must survive an out test, an in test and `both`.
    for (const t of [
      traversal(V(), where(traversal(out('E'))), values('n')),
      traversal(V(), where(traversal(in_('E'))), values('n')),
      traversal(V(), where(traversal(both('E'))), values('n')),
    ]) {
      expect(rows(t, g)).toContain(6);
    }
  });

  test('a test nothing passes yields no rows', () => {
    expect(rows(traversal(V(), where(traversal(out('NOPE'))), values('n')), g)).toEqual([]);
  });

  test('the row ORDER is `graph.vertices` order, which the pipeline also uses', () => {
    // ⚠️ Gremlin results are compared ORDERED against the Rust engine for a single-type step, so this
    // is a contract rather than an incidental.
    expect(rows(traversal(V(), where(traversal(out())), values('n')), g)).toEqual([1, 3, 6]);
  });
});

describe('nodeValuesWhereShortcut: the route', () => {
  const g = build();
  const routed = (t: ReturnType<typeof traversal>): boolean =>
    nodeValuesWhereShortcut(t, g) !== undefined;

  test('TAKES every hop shape the existence helper admits', () => {
    expect(routed(traversal(V(), where(traversal(out('E'))), values('n')))).toBe(true);
    expect(routed(traversal(V(), where(traversal(in_('E'))), values('n')))).toBe(true);
    expect(routed(traversal(V(), where(traversal(both('E'))), values('n')))).toBe(true);
    expect(routed(traversal(V(), where(traversal(out('E', 'F'))), values('n')))).toBe(true);
    expect(routed(traversal(V(), where(traversal(out())), values('n')))).toBe(true);
  });

  test('DECLINES a `where` that is NOT a sub-plan — the step kind is overloaded', () => {
    /*
     * ⚠️⚠️ A WRONG ANSWER IF ADMITTED, NOT A SLOW ONE. `where(neq('x'))` compares the traverser's
     * value to the value tagged at step label `x`; it has `pred` and no `plan`. Treating it as an
     * existence test would filter on the wrong question entirely.
     */
    expect(routed(traversal(V(), where(neq('x')), values('n')))).toBe(false);
  });

  test('DECLINES a multi-step sub-plan', () => {
    // `singleHopExistence` requires ONE adjacency step; two hops is a reachability question.
    expect(routed(traversal(V(), where(traversal(out('E'), out('E'))), values('n')))).toBe(false);
    expect(routed(traversal(V(), where(traversal(hasLabel('P'))), values('n')))).toBe(false);
  });

  test('DECLINES a multi-key or keyless projection, and a narrowed source', () => {
    expect(routed(traversal(V(), where(traversal(out('E'))), values('n', 'other')))).toBe(false);
    expect(routed(traversal(V(), where(traversal(out('E'))), values()))).toBe(false);
    expect(routed(traversal(V('a'), where(traversal(out('E'))), values('n')))).toBe(false);
  });

  test('DECLINES anything but exactly three steps', () => {
    /*
     * ⚠️ THE LENGTH CHECK IS LOAD-BEARING: with a trailing step the walk would silently answer the
     * plan WITHOUT it. (Item 2021's `scanValuesResidual` is how a residual gets served; this rung
     * has no residual of its own.)
     */
    expect(routed(traversal(V(), where(traversal(out('E')))))).toBe(false);
    expect(routed(traversal(V(), where(traversal(out('E'))), values('n'), values('n')))).toBe(
      false,
    );
    expect(routed(traversal(V(), hasLabel('P'), where(traversal(out('E'))), values('n')))).toBe(
      false,
    );
  });
});

describe('the pipeline is the ORACLE', () => {
  const g = build();

  test('every routed shape matches its narrowed-source twin', () => {
    /*
     * 🔑 `V('a','b','c','d','e','f')` NAMES EVERY VERTEX, so it is the same question — and the rung
     * DECLINES a narrowed source, so the twin runs the pipeline. An oracle, not self-blessing.
     */
    const ALL = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

    for (const hop of [out('E'), in_('E'), both('E'), out('E', 'F'), out()]) {
      const fast = rows(traversal(V(), where(traversal(hop)), values('n')), g);
      const general = rows(traversal(V(...ALL), where(traversal(hop)), values('n')), g);

      expect(fast.length).toBeGreaterThan(0);
      expect(fast).toEqual(general);
    }
  });
});
