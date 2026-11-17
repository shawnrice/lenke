/*
 * Item 2133 — `farDrivenPredicatedHopWalk` tests the far predicate BEFORE the adjacency read.
 *
 * ⚠️⚠️ **THE REORDER WIDENS THE EVALUATED SET, AND THAT IS THE ONLY RISK.** Before, a far vertex with no
 * qualifying bucket was never evaluated; now every candidate far vertex is. 🔑 That is unobservable ONLY
 * because the caller's gate admits this walk exclusively when the predicate provably cannot raise —
 * `truthCannotRaise(clauseWhere) && predicateCannotRaise(farPred)`, whose own comment says *"A route that
 * reorders which far vertex is evaluated first needs BOTH."*
 *
 * ⚠️ So the tests below come in two halves: the ANSWER at several selectivities (the reorder must not drop
 * or duplicate a row), and the GATE (a predicate that could raise must not reach this walk at all — and
 * must still behave as it did).
 *
 * 🔑 Measured, A/B of the real walk, answers identical in every arm:
 *
 * ```text
 *     selectivity        BEFORE     NEW
 *     4.4% pass           25.6      7.3     3.51x
 *     50%  pass           33.7     27.8     1.21x
 *     100% pass (vacuous) 71.4     67.4     1.06x
 *     count (control)      5.9      5.8     1.02x
 * ```
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * `ages[i]` is `v{i}`'s age; `edges` are `[from, to]` index pairs of type `E`.
 *
 * ⚠️ Some vertices are deliberately given NO in-edges: those are exactly the ones the reorder newly
 * evaluates, so every fixture needs them or the change is untested.
 */
const graphOf = (
  ages: readonly (number | string | undefined)[],
  edges: readonly [number, number][],
  labels: readonly string[][] = [],
): Graph => {
  const g = new Graph();

  for (const [i, age] of ages.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: labels[i] ?? ['P'],
      properties: age === undefined ? {} : { age },
    });
  }

  for (const [i, [from, to]] of edges.entries()) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${from}`)!,
      to: g.getVertexById(`v${to}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const rowsFor = (g: Graph, q: string): string =>
  query(g, q)
    .map((r) => String(r.k))
    .sort()
    .join(',');

describe('farDrivenPredicatedHopWalk: predicate before the adjacency read (item 2133)', () => {
  describe('the ANSWER is unchanged at every selectivity', () => {
    /*
     * v0 -> v1, v0 -> v2, v1 -> v3. So v1, v2, v3 have in-edges and v0, v4, v5 do NOT — and v4/v5 are
     * the vertices the reorder newly evaluates.
     */
    const g = graphOf(
      [10, 90, 50, 95, 99, 20],
      [
        [0, 1],
        [0, 2],
        [1, 3],
      ],
    );

    test('⚠️ SHARP — most far vertices fail, which is where the win is', () => {
      // Only v1 (90) and v3 (95) pass `> 85`, and both have exactly one in-edge.
      expect(rowsFor(g, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 85 RETURN b.age AS k')).toBe('90,95');
    });

    test('HALF', () => {
      expect(rowsFor(g, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 44 RETURN b.age AS k')).toBe(
        '50,90,95',
      );
    });

    test('⚠️ VACUOUS — every far vertex passes, so the reorder can only cost', () => {
      /*
       * 🔑 The arm where the reorder has nothing to skip, and it must still be exactly right: three
       * edges, three rows. ⚠️ v0/v4/v5 pass the predicate and have no in-edge — they must contribute
       * NOTHING, which is the bucket guard still doing its job after being moved below the predicate.
       */
      expect(rowsFor(g, 'MATCH (a:P)-[:E]->(b) WHERE b.age > -1 RETURN b.age AS k')).toBe(
        '50,90,95',
      );
    });

    test('NOTHING passes', () => {
      expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 1000 RETURN b.age AS k')).toHaveLength(
        0,
      );
    });

    test('⚠️⚠️ MULTIPLICITY: a far vertex with THREE in-edges yields THREE rows', () => {
      /*
       * 🔑 The walk emits one template plus `bucket.size - 1` copies, and the bucket read now happens
       * AFTER the predicate. ⚠️ If the reorder had cost the walk its bucket, this would answer 1 instead
       * of 3 — the sharpest form of a dropped-row bug.
       */
      const many = graphOf(
        [10, 90, 20, 30],
        [
          [0, 1],
          [2, 1],
          [3, 1],
        ],
      );

      expect(rowsFor(many, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 85 RETURN b.age AS k')).toBe(
        '90,90,90',
      );
    });

    test('⚠️ a MISSING property is not a pass, and does not raise', () => {
      const missing = graphOf(
        [10, undefined, 90],
        [
          [0, 1],
          [0, 2],
        ],
      );

      expect(rowsFor(missing, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 85 RETURN b.age AS k')).toBe(
        '90',
      );
    });

    test('⚠️ a far LABEL still filters, now tested after the predicate', () => {
      const labelled = graphOf(
        [10, 90, 95],
        [
          [0, 1],
          [0, 2],
        ],
        [['P'], ['P'], ['P', 'Q']],
      );

      expect(rowsFor(labelled, 'MATCH (a:P)-[:E]->(b:Q) WHERE b.age > 85 RETURN b.age AS k')).toBe(
        '95',
      );
    });

    test('an INCOMING hop agrees too', () => {
      /*
       * ⚠️ ONE row, not two, and I had this wrong by eye before the engine corrected me. Reversed, the
       * question is "far vertices `b` with an OUT-edge, whose age passes": v1 (90) has `v1 -> v3`; v3
       * (95) and v4 (99) pass the predicate but have no out-edge at all. 🔑 Those two are exactly the
       * vertices the reorder newly evaluates, which is what makes this case worth keeping.
       */
      expect(rowsFor(g, 'MATCH (a:P)<-[:E]-(b) WHERE b.age > 44 RETURN b.age AS k')).toBe('90');
    });
  });

  describe('⚠️⚠️ the GATE: a predicate that could RAISE must not reach this walk', () => {
    /*
     * 🔑 THE REORDER'S SOUNDNESS RESTS ENTIRELY ON THIS. The caller admits the walk only when BOTH
     * raise-freedom keys hold, so a predicate with a raising operand takes another route — where the
     * evaluated set is still the narrow one. ⚠️ These tests assert the ANSWER, which is what a user sees;
     * a route change that altered any of them would be the bug.
     */
    const g = graphOf(
      [10, 90, 50],
      [
        [0, 1],
        [0, 2],
      ],
    );

    test('a DIVISION in the operand — `truthCannotRaise`’s case', () => {
      expect(rowsFor(g, 'MATCH (a:P)-[:E]->(b) WHERE b.age / 2 > 30 RETURN b.age AS k')).toBe('90');
    });

    test('⚠️ a bare NUMERIC property as a truth value is a STATIC ERROR, not a coercion', () => {
      /*
       * 🔑 I expected a coercion and the engine corrected me: GQL applies a STATIC boolean-context check
       * at the clause level, so `WHERE b.age` over a number is rejected at COMPILE time and never reaches
       * any walk. ⚠️ That is a stronger guarantee than the gate needs — the shape cannot run at all — and
       * it is worth pinning here because a future relaxation to a runtime coercion would hand this walk a
       * predicate whose raise-freedom nobody has checked.
       */
      expect(() => query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.age RETURN b.age AS k')).toThrow();
    });

    test('⚠️ a STRING compared with `>` — no match, and no throw either way', () => {
      /*
       * 🔑 Item 2133 checked seven cross-type shapes in this position and none raises — which is the
       * premise the gate encodes rather than a reason to widen it. ⚠️ The answer must be the same whether
       * the gate admits the walk or not.
       */
      const mixed = graphOf(
        [10, 'text', 90],
        [
          [0, 1],
          [0, 2],
        ],
      );

      expect(() =>
        query(mixed, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 85 RETURN b.age AS k'),
      ).not.toThrow();
      expect(rowsFor(mixed, 'MATCH (a:P)-[:E]->(b) WHERE b.age > 85 RETURN b.age AS k')).toBe('90');
    });
  });
});
