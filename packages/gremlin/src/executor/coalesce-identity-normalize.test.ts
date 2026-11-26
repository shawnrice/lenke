// `coalesce(X, identity())` normalized to `optional(X)` (item 1990).
//
// **THE REWRITE IS ANSWER-EQUIVALENT, so nothing else in this package can see a mutant of it.**
// Both forms emit the same rows in the same order — that is the whole justification — so the 2,425
// behavioural tests pass either way and only the ROUTE assertions below distinguish them
// ([[perf-gate-needs-its-own-test]]).
//
// WHY IT EXISTS: `optional` has dedicated fused rungs and `coalesce` has none, so the two
// spellings of one question cost 4.99x apart before this (218.23 ms against 43.72 for 800,001 rows).
// Item 1480 priced the family and called the blocker structural — "the fused walks are
// SOURCE-ANCHORED, so no sub-plan can reach them" — which was true of BOTH spellings when written;
// `optional` was then given its own rungs and nothing re-checked the claim for `coalesce`.
//
// `coalesce(identity(), X)` IS NOT `optional(X)` AND MUST NOT BE REWRITTEN. Arm 0 always
// produces, so that form is just `identity()` — it never reaches X at all. The gate tests
// `plans[1]`, and the route test below pins that asymmetry, because a gate reading `plans[0]` or
// `plans.some(...)` would pass every answer test on a fixture where X is non-empty everywhere.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { coalesce, identity, in_, out, toArray, traversal, V, values } from '../index.js';
import { normalizeCoalesceIdentity } from './index.js';

/** Step kinds after normalization — the route, read without timing anything. */
const routeOf = (plan: Parameters<typeof normalizeCoalesceIdentity>[0]): string =>
  normalizeCoalesceIdentity(plan)
    .steps.map((s) => s.kind)
    .join(',');

/*
 * A VERTEX WITH NO `E` EDGES IS THE WHOLE FIXTURE REQUIREMENT. `optional` and
 * `coalesce(X, identity())` differ from a bare hop ONLY on the rows X misses, so on a graph where
 * every vertex has an out-edge all three spellings agree for the wrong reason and a broken rewrite
 * passes. `e` is that vertex; `c` carries a SELF-LOOP and `a` a PARALLEL pair, so multiplicity is
 * exercised too.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const E = (id: string, from: string, to: string, label = 'E'): void => {
    g.addEdge({
      id,
      from: g.getVertexById(from)!,
      to: g.getVertexById(to)!,
      labels: [label],
      properties: {},
    });
  };

  E('e1', 'a', 'b');
  E('e2', 'a', 'b'); // PARALLEL — two rows, not one
  E('e3', 'b', 'c');
  E('e4', 'c', 'c'); // SELF-LOOP
  E('e5', 'd', 'a');
  E('e6', 'd', 'e', 'F'); // a different type, so `out('E')` misses it
  // `e` has no outgoing edge of any type — the arm-0-misses case.

  return g;
};

describe('normalizeCoalesceIdentity: the route', () => {
  // `traversal(...)` IS the plan — there is no `.plan` property on it.
  const t = (...steps: Parameters<typeof traversal>): ReturnType<typeof traversal> =>
    traversal(...steps);

  test('TAKES a two-arm coalesce whose second arm is exactly identity()', () => {
    expect(routeOf(t(V(), coalesce(out('E'), identity()), values('n')))).toBe('V,optional,values');
  });

  test('DECLINES three arms — that is not `optional`', () => {
    expect(routeOf(t(V(), coalesce(out('E'), in_('E'), identity()), values('n')))).toBe(
      'V,coalesce,values',
    );
  });

  test('DECLINES when the second arm is not identity', () => {
    expect(routeOf(t(V(), coalesce(out('E'), in_('E')), values('n')))).toBe('V,coalesce,values');
  });

  test('DECLINES `coalesce(identity(), X)` — the arms are ORDERED', () => {
    // Arm 0 always produces, so this form never reaches X and is NOT `optional(X)`. A gate reading
    // `plans[0]`, or `plans.some(isIdentity)`, would rewrite it and change the answer.
    expect(routeOf(t(V(), coalesce(identity(), out('E')), values('n')))).toBe('V,coalesce,values');
  });

  test('leaves a plan with no coalesce alone', () => {
    expect(routeOf(t(V(), out('E'), values('n')))).toBe('V,out,values');
  });
});

describe('normalizeCoalesceIdentity: the answers', () => {
  const g = build();
  const rows = (...steps: Parameters<typeof traversal>): unknown[] =>
    toArray(traversal(...steps), g);

  test('the rewritten form equals the hand-written `optional`, POSITIONALLY', () => {
    // Positional, not a multiset: Gremlin stream order is a contract the differential fuzzer
    // compares ORDERED for a single-type step, so a reordering rewrite would be wrong rather than
    // merely different — and a checksum could not see it (item 1955).
    const viaCoalesce = rows(V(), coalesce(out('E'), identity()), values('n'));

    expect(viaCoalesce).toEqual(rows(V(), out('E'), values('n')).concat(['e']));
  });

  test('the fallback row IS emitted for the vertex the hop misses', () => {
    const viaCoalesce = rows(V(), coalesce(out('E'), identity()), values('n'));
    const bareHop = rows(V(), out('E'), values('n'));

    // Exactly one extra row — `e`, which has no `E` edge. If the rewrite dropped the fallback this
    // would equal the bare hop, and every other assertion here would still pass.
    expect(viaCoalesce).toHaveLength(bareHop.length + 1);
    expect(viaCoalesce.at(-1)).toBe('e');
  });

  test('`coalesce(identity(), X)` still answers identity, not the hop', () => {
    // The shape the gate must refuse. Arm 0 produces for every vertex, so the answer is every
    // vertex's own `n` — five rows, not the hop's.
    expect(rows(V(), coalesce(identity(), out('E')), values('n'))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  test('a three-arm coalesce is unchanged and still correct', () => {
    // `out('E')` then `in_('E')` then identity: `e` has neither, so it falls to identity.
    const got = rows(V(), coalesce(out('E'), in_('E'), identity()), values('n'));

    expect(got).toContain('e');
    expect(got.length).toBeGreaterThan(rows(V(), out('E'), values('n')).length);
  });

  test('PARALLEL edges and a SELF-LOOP keep their multiplicity through the rewrite', () => {
    const got = rows(V(), coalesce(out('E'), identity()), values('n'));

    // `a` has two parallel edges to `b`, so `b` appears twice; `c`'s self-loop yields `c` once.
    expect(got.filter((x) => x === 'b')).toHaveLength(2);
    expect(got.filter((x) => x === 'c')).toHaveLength(2); // b->c and c->c
  });
});
