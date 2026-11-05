import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from './executor.js';
import { optionalSingleHop } from './executor/optional-hop.js';
import { V, both, count, has, hasLabel, inject, optional, out, pipe, values } from './steps.js';
import { traversal } from './traversal.js';

/**
 * Item 1483 fuses `optional(<one vertex step>)` into a single loop — no per-traverser input array,
 * no sub-plan dispatch, no materialized output. 1.26x, 3/3.
 *
 * ⚠️ THE FUSION IS LAZY WHERE `optionalStep` IS EAGER, and that is only safe because a vertex step
 * has no side effects. Item 1480 declined the same change for the general case for exactly that
 * reason, and `sideeffect-in-branch.test.ts` exists because the ordering is observable. So the gate
 * is narrow on purpose, and most of these tests are about what it REFUSES.
 *
 * ⚠️ AND IT MUST MATCH `optionalStep` EXACTLY on the shapes it does claim — including the
 * easy-to-miss one: a NON-VERTEX traverser passes through, because `traverseToVertex` is lenient and
 * yields nothing for a non-vertex, which makes `optionalStep` take its empty branch.
 */

/** a -> b, a -> c; b is a sink; d is isolated. */
const chain = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addVertex({ id: 'd', labels: ['P'], properties: { k: 4 } });
  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['F'] });

  return g;
};

const ids = (g: Graph, plan: Parameters<typeof run>[0]): unknown[] =>
  [...run(plan, g)].map((v) => (typeof v === 'object' && v !== null && 'id' in v ? v.id : v));

describe('the fused optional answers what optionalStep answered', () => {
  test('a vertex WITH matching edges emits the far endpoints, not itself', () => {
    // a has one E edge (to b); b, c, d have none, so they pass through as themselves.
    expect(ids(chain(), traversal(V(), optional(pipe(out('E')))))).toEqual(['b', 'b', 'c', 'd']);
  });

  test('a vertex with NO matching edge emits itself', () => {
    expect(ids(chain(), traversal(V(), hasLabel('Q'), optional(pipe(out('E')))))).toEqual(['c']);
  });

  test('an isolated vertex emits itself', () => {
    expect(ids(chain(), traversal(V(), has('k', 4), optional(pipe(out('E')))))).toEqual(['d']);
  });

  /**
   * ⚠️ THE NON-VERTEX BRANCH IS UNREACHABLE THROUGH THE PUBLIC API, and this test records that
   * rather than asserting a behaviour the engine never produces. A STATIC frontier-type check
   * rejects the plan before execution ("out() moves from a vertex, but the frontier is a scalar"),
   * so `optional(out(E))` can never see a scalar traverser by this route.
   *
   * The branch is kept anyway, and mirrors the general path exactly: `traverseToVertex` is lenient
   * and yields nothing for a non-vertex, which makes `optionalStep` take its empty branch and emit
   * the traverser. If a future shape delivers a mixed frontier past that check, the two routes agree.
   * Same reasoning as item 1482's unreachable `tracksPath` guard.
   */
  test('a scalar frontier is rejected statically, so the non-vertex branch is defensive', () => {
    let message = '';

    try {
      ids(chain(), traversal(inject(7), optional(pipe(out('E')))));
    } catch (err) {
      ({ message } = err as Error);
    }

    expect(message).toMatch(/frontier is a scalar/);
  });

  test('a multi-label hop walks both buckets', () => {
    expect(ids(chain(), traversal(V(), has('k', 1), optional(pipe(out('E', 'F')))))).toEqual([
      'b',
      'c',
    ]);
  });

  test('both() sees the edge from either side', () => {
    expect(ids(chain(), traversal(V(), has('k', 2), optional(pipe(both('E')))))).toEqual(['a']);
  });

  test('a downstream step sees the fused output', () => {
    expect([
      ...run(traversal(V(), optional(pipe(out('E'))), values('k'), count()), chain()),
    ]).toEqual([4]);
  });
});

describe('the gate REFUSES every other sub-plan shape', () => {
  const refuses = (plan: Parameters<typeof optionalSingleHop>[0]): void => {
    expect(optionalSingleHop(plan)).toBeUndefined();
  };

  test('a multi-step sub-plan', () => {
    refuses(traversal(out('E'), out('E')));
  });

  test('a filter', () => {
    refuses(traversal(hasLabel('P')));
  });

  test('a barrier — count() inside optional is per-traverser and must stay so', () => {
    refuses(traversal(count()));
  });

  test('a hop FOLLOWED by anything', () => {
    refuses(traversal(out('E'), values('k')));
  });

  test('an empty sub-plan', () => {
    refuses(traversal());
  });

  test('…and a single vertex step is ACCEPTED, so the refusals above mean something', () => {
    expect(optionalSingleHop(traversal(out('E')))).toEqual({ kind: 'out', labels: ['E'] });
  });
});

describe('a barrier inside optional still behaves per traverser', () => {
  test('optional(count()) counts EACH traverser', () => {
    // Falls through to optionalStep. Fusing it would count the whole stream once.
    expect([...run(traversal(V(), optional(pipe(count()))), chain())]).toEqual([1, 1, 1, 1]);
  });

  test('optional(out(E), count()) is a per-traverser degree', () => {
    expect([...run(traversal(V(), optional(pipe(out('E'), count()))), chain())]).toEqual([
      1, 0, 0, 0,
    ]);
  });
});
