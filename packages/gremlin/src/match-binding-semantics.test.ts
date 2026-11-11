/**
 * ⚠️ **THIS FILE ASSERTED THE OPPOSITE UNTIL ITEM 1793, AND IT WAS WRONG.** Its claim was
 * `match()` COUNTS DISTINCT VARIABLE BINDINGS; A HOP CHAIN COUNTS PATHS — so two parallel edges
 * giving the same `(a, b)` pair were ONE solution. TinkerPop emits one traverser per TRAVERSAL
 * RESULT, so they are TWO, and this engine's own Rust side already answered that way.
 *
 * ASKED DIRECTLY, on the fixture below (`podman run -i docker.io/tinkerpop/gremlin-console:3.7.3`,
 * the harness this repo keeps for exactly this question):
 *
 * ```text
 *   a =T=> b -T-> c   (a -> b TWICE)         TinkerPop   lenke TS was   native
 *     match(a-T->b).count()                      3            2            3
 *     out(T).count()                             3            3            3
 *     match(a-T->b, b-T->c).count()              2            1            2
 *     out(T).out(T).count()                      2            2            2
 *     match(…).select('c').count()               2            1            2
 * ```
 *
 * ⚠️ **SO THE MATCH AND THE CHAIN AGREE ON EVERY ROW**, and the TS engine was the only one of the
 * three that disagreed. The cause was one block in `executor/match.ts`: when a pattern's end tag is
 * unbound, the solver collected the inner traversal's DISTINCT output values and bound each once.
 * Deduplicating there drops a solution per parallel edge.
 *
 * ⚠️ **WHAT ITEM 1655 CONCLUDED FROM THE WRONG PREMISE.** It measured
 * `match(a-T->b, b-T->c).count()` at **332.4 ms a call against the chain's 1.40 — 237x** (438.8
 * with a `select('c')` tail, 313x), built a planner rewrite flattening the match into the chain,
 * then REVERTED it as a wrong answer on the strength of the table above read the other way round.
 * The counts it called a semantic difference were a BUG, so that revert's reason is gone and the
 * 237x is a live equivalent-spelling gap again. It is NOT re-opened by this item — the rewrite also
 * has to survive the second objection below, which still stands on its own evidence.
 *
 * ⚠️ **AND THE FUZZERS COULD NOT HAVE CAUGHT THIS.** The engines diverged on a 3-vertex graph, so
 * nothing subtle was needed — `gremlin-fuzz` simply never builds PARALLEL EDGES, which is the same
 * blindness class as [[fuzzer-blind-to-one-column-group]]. A divergence of this size surviving
 * 20,000 generated queries is a statement about the generator, not about the engines.
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

describe('⚠️ a match SOLUTION is a traversal result, so parallel edges are separate solutions', () => {
  test('they agree when no edge is parallel — the case that hid the bug', () => {
    // This is the pair item 1655 verified on, and it cannot distinguish the two readings. An
    // answer invariant to the property under test cannot validate a claim about it, which is this
    // repo's oldest fixture rule (item 702) arriving at a SEMANTIC question rather than a
    // performance one.
    const g = chainOf(false);

    expect(toArray(traversal(V(), match(...twoPatterns()), count()), g)).toEqual([1]);
    expect(toArray(traversal(V(), out('T'), out('T'), count()), g)).toEqual([1]);
  });

  test('ONE parallel edge, two patterns — TinkerPop says 2 and so does the chain', () => {
    const g = chainOf(true);

    expect(toArray(traversal(V(), match(...twoPatterns()), count()), g)).toEqual([2]);
    expect(toArray(traversal(V(), out('T'), out('T'), count()), g)).toEqual([2]);
  });

  test('ONE hop, where the extra edge is the whole difference', () => {
    const g = chainOf(true);

    expect(toArray(traversal(V(), match(pipe(as_('a'), out('T'), as_('b'))), count()), g)).toEqual([
      3,
    ]);
    expect(toArray(traversal(V(), out('T'), count()), g)).toEqual([3]);
  });

  /**
   * ⚠️ A `select(tag)` tail reads a BINDING rather than the tag map the step emits, so it is the
   * independent check that the multiplicity is the SOLVER's and not an artefact of how the step's
   * output value is counted. It moved with the fix, from 1 to 2.
   */
  test('a select tail agrees, so the multiplicity is the solver own', () => {
    const g = chainOf(true);

    expect(toArray(traversal(V(), match(...twoPatterns()), select('c'), count()), g)).toEqual([2]);
  });

  /**
   * ⚠️ THE OBJECTION THAT STILL STANDS, and the reason this item does not re-open item 1655's
   * rewrite on its own: a `match` step's output VALUE is a tag map, not the chain's end element,
   * so even where the COUNTS agree the two spellings are not interchangeable mid-plan. A rewrite
   * would have to prove nothing downstream reads the step's value as an element.
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
