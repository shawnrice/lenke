/**
 * ⚠️ `match()` COUNTS DISTINCT VARIABLE BINDINGS; A HOP CHAIN COUNTS PATHS. They coincide only on a
 * graph with no PARALLEL edges of the matching types — and that is a property of the DATA, not of
 * the plan.
 *
 * ⚠️ WHY THIS TEST EXISTS (item 1655). `match(as(a).out(T).as(b), as(b).out(T).as(c)).count()`
 * measures **332.4 ms/call against the chained `out(T).out(T).count()`'s 1.40 — 237x** (and 438.8
 * with a `select('c')` tail, 313x), because the solver runs a two-pattern DFS where the chain has a
 * closed form. That looks exactly like the equivalent-spelling defect CLAUDE.md opens with, and a
 * planner rewrite flattening the chain was built and then REVERTED: it is a WRONG ANSWER.
 *
 * The verification that first "confirmed" the equivalence used a generated fixture with no parallel
 * edges, where both spellings answer 1750 and the rows are even ORDERED-equal. That is CLAUDE.md's
 * own trap — an answer invariant to the property you varied cannot validate the claim. One parallel
 * edge separates them:
 *
 * ```text
 *   a -T-> b -T-> c                    match 1   chain 1    agree
 *   a =T=> b -T-> c  (a->b twice)      match 1   chain 2    DIVERGE
 * ```
 *
 * So the 237x is not a defect to close; the two spellings answer different questions. This test is
 * the guard against anyone (including a later me) reading that ratio as a lever again.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { toArray } from './executor.js';
import { V, as_, count, match, out, pipe, select, traversal } from './index.js';

/** `a -T-> b -T-> c`, with `a -T-> b` duplicated when `parallel`. */
const chainOf = (parallel: boolean): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['P'], properties: {} });
  }

  const v = (id: string): Vertex => g.getVertexById(id) as Vertex;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['T'], properties: {} });

  if (parallel) {
    g.addEdge({ id: 'e1b', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  }

  g.addEdge({ id: 'e2', from: v('b'), to: v('c'), labels: ['T'], properties: {} });

  return g;
};

const twoPatterns = () => [pipe(as_('a'), out('T'), as_('b')), pipe(as_('b'), out('T'), as_('c'))];

describe('⚠️ match counts BINDINGS, a chain counts PATHS', () => {
  test('they agree when no edge is parallel', () => {
    const g = chainOf(false);

    expect(toArray(traversal(V(), match(...twoPatterns()), count()), g)).toEqual([1]);
    expect(toArray(traversal(V(), out('T'), out('T'), count()), g)).toEqual([1]);
  });

  test('ONE parallel edge separates them — the chain counts the extra path', () => {
    const g = chainOf(true);

    expect(toArray(traversal(V(), match(...twoPatterns()), count()), g)).toEqual([1]);
    expect(toArray(traversal(V(), out('T'), out('T'), count()), g)).toEqual([2]);
  });

  test('and the same split shows on ONE hop', () => {
    const g = chainOf(true);

    expect(toArray(traversal(V(), match(pipe(as_('a'), out('T'), as_('b'))), count()), g)).toEqual([
      2,
    ]);
    expect(toArray(traversal(V(), out('T'), count()), g)).toEqual([3]);
  });

  /**
   * ⚠️ AND THE COUNT IS THE SOLVER'S OWN, not an artefact of reading the match step's value. A
   * `select(tag)` tail reads a BINDING rather than the tag-map the step emits, and agrees.
   */
  test('a select tail agrees with the bare count, so the divergence is the semantics', () => {
    const g = chainOf(true);

    expect(toArray(traversal(V(), match(...twoPatterns()), select('c'), count()), g)).toEqual([1]);
  });

  /**
   * ⚠️ THE OTHER HALF OF WHY THE REWRITE CANNOT BE GATED: a `match` step's output VALUE is a tag
   * map, not the chain's end element, so even where the counts agree the spellings are not
   * interchangeable mid-plan.
   */
  test('the match step emits a tag map, not the end element', () => {
    const g = chainOf(false);
    const viaMatch = toArray(traversal(V(), match(...twoPatterns())), g);
    const viaChain = toArray(traversal(V(), as_('a'), out('T'), as_('b'), out('T'), as_('c')), g);

    expect(viaMatch).toHaveLength(1);
    expect(viaChain).toHaveLength(1);
    expect((viaChain[0] as Vertex).id).toBe('c');
    expect((viaMatch[0] as { id?: unknown }).id).toBeUndefined();
  });
});
