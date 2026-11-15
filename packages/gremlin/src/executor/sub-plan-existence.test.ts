import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  and,
  both,
  bothE,
  count,
  filter,
  has,
  identity,
  in_,
  inE,
  not,
  or,
  out,
  outE,
  toArray,
  traversal,
  values,
  where,
} from '../index.js';
import { allHopExistence, hasAdjacency, singleHopExistence } from './sub-plan-existence.js';

/**
 * ⚠️ NOT `ReturnType<typeof where>`, which the first draft used and which does not typecheck:
 * `where` is OVERLOADED and that resolves to the `ByableStep` overload, not the plain `StepFn`
 * every one of these call sites actually passes. Taken from `traversal`'s own parameter so it
 * cannot drift from what `traversal` accepts.
 */
type TraversalStep = Parameters<typeof traversal>[number];

/**
 * `where(out(T))` / `filter` / `not` / `and` / `or` whose sub-plan is ONE adjacency step answer from
 * the adjacency box instead of running a sub-pipeline per traverser (item 1915).
 *
 * At 200,000 vertices / 1,000,000 edges, interleaved PRE/POST over 3 rounds with both controls flat:
 *
 *     where(out(E)).values(n)    86.33 -> 20.87 ms   4.14x
 *     where(out(E)).count()      72.65 -> 11.88      6.11x   the filter ALONE, one row
 *     not(out(E))                73.89 -> 11.25      6.57x
 *     filter(out(E))             88.13 -> 22.52      3.91x
 *     and(out(E))                94.80 -> 20.85      4.55x
 *     CONTROL plain hop          40.98 -> 41.58      flat
 *     CONTROL bare scan           5.02 ->  5.02      flat
 *
 * ⚠️ THE ORACLE IS A TWO-STEP SUB-PLAN, and `identity()` is the right disqualifier for the same
 * reason `optional-bucket-hop.test.ts` gives: `singleHopExistence` admits exactly one step, so
 * appending `identity()` sends the IDENTICAL question down the general path, changing the sub-plan's
 * LENGTH and nothing else. Gremlin stream order is a TinkerPop contract compared ORDERED by the
 * differential fuzzer, so every comparison here is element for element.
 *
 * ⚠️ WHY "DOES THE SUB-PLAN EMIT" AND "IS A BUCKET NON-EMPTY" ARE THE SAME QUESTION, which is the
 * whole correctness argument: `traverseToVertex` / `traverseToEdge` yield for EVERY adjacent edge
 * unconditionally — there is no per-edge filter in a bare adjacency step — so a non-empty bucket
 * always produces at least one traverser. Any widening of the gate to a step that can DROP a
 * traverser would break exactly this.
 */
const seed = (): {
  g: Graph;
  a: Vertex;
  b: Vertex;
  c: Vertex;
  d: Vertex;
  e: Vertex;
  f: Vertex;
} => {
  const g = new Graph();
  const mk = (id: string): Vertex => g.addVertex({ id, labels: ['P'], properties: { n: id } });

  // Each vertex separates one arm of the gate from every other.
  const a = mk('a'); // out-E only
  const b = mk('b'); // in-E only
  const c = mk('c'); // out-F only
  const d = mk('d'); // a SELF-LOOP on E: out and in both true off ONE edge
  const e = mk('e'); // isolated, never had an edge
  const f = mk('f'); // isolated via REMOVAL, a different path to the same state

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: c, to: a, labels: ['F'], properties: {} });
  g.addEdge({ id: 'e3', from: d, to: d, labels: ['E'], properties: {} });

  const gone = g.addEdge({ id: 'e4', from: f, to: a, labels: ['E'], properties: {} });

  g.removeEdge(gone);

  return { g, a, b, c, d, e, f };
};

describe('the single-hop existence gate', () => {
  test('admits every bare adjacency step, vertex- and edge-emitting alike', () => {
    expect(singleHopExistence(traversal(out('E')))).toEqual({ kind: 'out', labels: ['E'] });
    expect(singleHopExistence(traversal(in_('E')))).toEqual({ kind: 'in', labels: ['E'] });
    expect(singleHopExistence(traversal(both('E')))).toEqual({ kind: 'both', labels: ['E'] });

    // ⚠️ THE EDGE-EMITTING STEPS COLLAPSE ONTO THE VERTEX-EMITTING ONES: `outE(T)` and `out(T)` walk
    // the identical adjacency and differ only in WHAT they yield, which a yes/no cannot see.
    expect(singleHopExistence(traversal(outE('E')))).toEqual({ kind: 'out', labels: ['E'] });
    expect(singleHopExistence(traversal(inE('E')))).toEqual({ kind: 'in', labels: ['E'] });
    expect(singleHopExistence(traversal(bothE('E')))).toEqual({ kind: 'both', labels: ['E'] });

    // Untyped and multi-typed, both of which `soleTypeBucket` refuses and this admits.
    expect(singleHopExistence(traversal(out()))).toEqual({ kind: 'out', labels: [] });
    expect(singleHopExistence(traversal(out('E', 'F')))).toEqual({
      kind: 'out',
      labels: ['E', 'F'],
    });
  });

  test('refuses every other sub-plan shape', () => {
    // Two steps — the oracle's disqualifier, and the commonest real decline.
    expect(singleHopExistence(traversal(out('E'), identity()))).toBeUndefined();
    expect(singleHopExistence(traversal(out('E'), out('E')))).toBeUndefined();
    // A step that can DROP a traverser, which is what the equivalence rests on not happening.
    expect(singleHopExistence(traversal(has('n', 'a')))).toBeUndefined();
    expect(singleHopExistence(traversal(outE('E'), has('n', 'a')))).toBeUndefined();
    // Not an adjacency step at all.
    expect(singleHopExistence(traversal(values('n')))).toBeUndefined();
    expect(singleHopExistence(traversal(count()))).toBeUndefined();
    // No steps.
    expect(singleHopExistence(traversal())).toBeUndefined();
  });

  test('allHopExistence is all-or-nothing, and an EMPTY list falls through', () => {
    expect(allHopExistence([traversal(out('E')), traversal(in_('F'))])).toEqual([
      { kind: 'out', labels: ['E'] },
      { kind: 'in', labels: ['F'] },
    ]);

    // One unrecognized plan takes the whole step to the general path.
    expect(allHopExistence([traversal(out('E')), traversal(has('n', 'a'))])).toBeUndefined();

    // ⚠️ LOAD-BEARING, NOT A DON'T-CARE: `and()` keeps EVERY traverser (`[].every` is true) and
    // `or()` keeps NONE (`[].some` is false). An empty array here would send both to one loop.
    expect(allHopExistence([])).toBeUndefined();
  });

  test('hasAdjacency reads each bucket, and an emptied one is not a match', () => {
    const { a, b, c, d, e, f } = seed();

    expect(hasAdjacency(a, { kind: 'out', labels: ['E'] })).toBe(true);
    expect(hasAdjacency(a, { kind: 'in', labels: ['E'] })).toBe(false);
    expect(hasAdjacency(b, { kind: 'in', labels: ['E'] })).toBe(true);
    expect(hasAdjacency(c, { kind: 'out', labels: ['F'] })).toBe(true);
    expect(hasAdjacency(c, { kind: 'out', labels: ['E'] })).toBe(false);

    // A self-loop answers BOTH directions off one edge.
    expect(hasAdjacency(d, { kind: 'out', labels: ['E'] })).toBe(true);
    expect(hasAdjacency(d, { kind: 'in', labels: ['E'] })).toBe(true);

    // Untyped asks about every bucket; multi-typed about any of them.
    expect(hasAdjacency(c, { kind: 'out', labels: [] })).toBe(true);
    expect(hasAdjacency(c, { kind: 'out', labels: ['E', 'F'] })).toBe(true);
    expect(hasAdjacency(c, { kind: 'out', labels: ['E', 'G'] })).toBe(false);

    // Never had an edge, and had one removed — two routes to the same answer.
    expect(hasAdjacency(e, { kind: 'both', labels: [] })).toBe(false);
    expect(hasAdjacency(f, { kind: 'out', labels: ['E'] })).toBe(false);
    expect(hasAdjacency(f, { kind: 'both', labels: [] })).toBe(false);
  });
});

/**
 * Every answer below is checked against the SAME question down the general path, so a route that
 * silently stopped being taken would still have to be correct — and a route that is taken and wrong
 * fails here.
 */
describe('the fused filters answer what the general path answers', () => {
  const both2 = (
    fused: TraversalStep,
    generic: TraversalStep,
  ): [readonly unknown[], readonly unknown[]] => {
    const { g } = seed();

    return [
      toArray(traversal(V(), fused, values('n')), g),
      toArray(traversal(V(), generic, values('n')), g),
    ];
  };

  const agree = (fused: TraversalStep, generic: TraversalStep): void => {
    const [got, want] = both2(fused, generic);

    expect(got).toEqual(want);
  };

  test('where, across every direction and type shape', () => {
    agree(where(traversal(out('E'))), where(traversal(out('E'), identity())));
    agree(where(traversal(out('F'))), where(traversal(out('F'), identity())));
    agree(where(traversal(out())), where(traversal(out(), identity())));
    agree(where(traversal(in_('E'))), where(traversal(in_('E'), identity())));
    agree(where(traversal(both('E'))), where(traversal(both('E'), identity())));
    agree(where(traversal(both())), where(traversal(both(), identity())));
    agree(where(traversal(out('E', 'F'))), where(traversal(out('E', 'F'), identity())));
    agree(where(traversal(outE('E'))), where(traversal(outE('E'), identity())));
    agree(where(traversal(inE('E'))), where(traversal(inE('E'), identity())));
    agree(where(traversal(bothE('E'))), where(traversal(bothE('E'), identity())));
  });

  test('and the answers are the expected vertices, not just self-consistent', () => {
    const { g } = seed();

    // Spelled out, because "both paths agree" would also hold if both were wrong.
    expect(toArray(traversal(V(), where(traversal(out('E'))), values('n')), g)).toEqual(['a', 'd']);
    expect(toArray(traversal(V(), where(traversal(in_('E'))), values('n')), g)).toEqual(['b', 'd']);
    expect(toArray(traversal(V(), where(traversal(both('E'))), values('n')), g)).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(toArray(traversal(V(), where(traversal(out())), values('n')), g)).toEqual([
      'a',
      'c',
      'd',
    ]);
    expect(toArray(traversal(V(), not(traversal(out('E'))), values('n')), g)).toEqual([
      'b',
      'c',
      'e',
      'f',
    ]);
  });

  test('filter is the same step under another name', () => {
    agree(filter(traversal(out('E'))), filter(traversal(out('E'), identity())));
    agree(filter(traversal(both())), filter(traversal(both(), identity())));
  });

  test('not, which is the gate negated', () => {
    agree(not(traversal(out('E'))), not(traversal(out('E'), identity())));
    agree(not(traversal(out('F'))), not(traversal(out('F'), identity())));
    agree(not(traversal(both())), not(traversal(both(), identity())));
  });

  test('and / or at arity one, which route to the single-hop step', () => {
    agree(and(traversal(out('E'))), and(traversal(out('E'), identity())));
    agree(or(traversal(out('E'))), or(traversal(out('E'), identity())));
  });

  /**
   * ⚠️ ARITY TWO IS A DIFFERENT FUNCTION. `hopExistenceCombinedStep` routes arity ONE to
   * `hopExistenceStep` — `and(p)` and `or(p)` both mean exactly `p` — so only these cases reach the
   * combining loop. The split was made for speed (the one-iteration loop measured 36.6 ms against
   * the straight-line 20.9 on 200,000 vertices), which means the arity-1 tests above do NOT cover
   * the loop and these are the only ones that do.
   */
  test('and / or at arity two, which reach the combining loop', () => {
    agree(
      and(traversal(out('E')), traversal(in_('F'))),
      and(traversal(out('E'), identity()), traversal(in_('F'))),
    );
    agree(
      and(traversal(out('E')), traversal(out('F'))),
      and(traversal(out('E'), identity()), traversal(out('F'))),
    );
    agree(
      or(traversal(out('E')), traversal(out('F'))),
      or(traversal(out('E'), identity()), traversal(out('F'))),
    );
    agree(
      or(traversal(out('G')), traversal(out('H'))),
      or(traversal(out('G'), identity()), traversal(out('H'))),
    );

    const { g } = seed();

    // `a` is the only vertex with both an out-E and an in-F.
    expect(
      toArray(traversal(V(), and(traversal(out('E')), traversal(in_('F'))), values('n')), g),
    ).toEqual(['a']);
    // No vertex has both an out-E and an out-F.
    expect(
      toArray(traversal(V(), and(traversal(out('E')), traversal(out('F'))), values('n')), g),
    ).toEqual([]);
    expect(
      toArray(traversal(V(), or(traversal(out('E')), traversal(out('F'))), values('n')), g),
    ).toEqual(['a', 'c', 'd']);
  });

  test('a mixed and() falls through whole, rather than half-fusing', () => {
    agree(
      and(traversal(out('E')), traversal(has('n', 'a'))),
      and(traversal(out('E'), identity()), traversal(has('n', 'a'))),
    );

    const { g } = seed();

    expect(
      toArray(traversal(V(), and(traversal(out('E')), traversal(has('n', 'a'))), values('n')), g),
    ).toEqual(['a']);
  });

  /**
   * ⚠️ A NON-VERTEX TRAVERSER, which the fused step must treat exactly as the general path does and
   * NOT as an error or a pass. `traverseToVertex` `continue`s on a non-vertex, so the sub-plan emits
   * nothing: `where` drops the row and `not` KEEPS it. Reached by filtering after a projection,
   * which no other case here does.
   */
  test('a scalar traverser: where drops it, not keeps it', () => {
    const { g } = seed();

    expect(toArray(traversal(V(), values('n'), where(traversal(out('E')))), g)).toEqual([]);
    expect(toArray(traversal(V(), values('n'), where(traversal(out('E'), identity()))), g)).toEqual(
      [],
    );

    const kept = toArray(traversal(V(), values('n'), not(traversal(out('E')))), g);

    expect(kept).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(toArray(traversal(V(), values('n'), not(traversal(out('E'), identity()))), g)).toEqual(
      kept,
    );

    // And at arity two, which is the other function.
    expect(
      toArray(traversal(V(), values('n'), and(traversal(out('E')), traversal(out('F')))), g),
    ).toEqual([]);
    expect(
      toArray(traversal(V(), values('n'), or(traversal(out('E')), traversal(out('F')))), g),
    ).toEqual([]);
  });

  /**
   * ⚠️ A `null` IN THE STREAM, which is what makes the `isVertex` guard checked rather than merely
   * defensive. [[null-first-class-policy]]: null is a STORED, PRESENT value here, so `values(k)`
   * over a null-valued property puts `null` in the stream — and `null.adjFrom` throws where
   * `undefined.adjFrom` on a string merely reads undefined. Without the guard every other case in
   * this file still passes, so this is the only one that fails.
   */
  test('a null traverser value does not throw', () => {
    const g = new Graph();

    g.addVertex({ id: 'z', labels: ['P'], properties: { n: null } });

    expect(toArray(traversal(V(), values('n'), where(traversal(out('E')))), g)).toEqual([]);
    expect(toArray(traversal(V(), values('n'), not(traversal(out('E')))), g)).toEqual([null]);
    expect(
      toArray(traversal(V(), values('n'), and(traversal(out('E')), traversal(out('F')))), g),
    ).toEqual([]);
  });

  test('the count twin, which is the filter with no projection downstream', () => {
    const { g } = seed();

    expect(toArray(traversal(V(), where(traversal(out('E'))), count()), g)).toEqual([2]);
    expect(toArray(traversal(V(), where(traversal(out('E'), identity())), count()), g)).toEqual([
      2,
    ]);
    expect(toArray(traversal(V(), not(traversal(out('E'))), count()), g)).toEqual([4]);
  });
});
