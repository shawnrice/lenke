/*
 * Item 2225 — a MID-pattern, raise-free clause `WHERE` is evaluated in the two-hop walk's MIDDLE loop,
 * one test per middle vertex instead of one per complete row.
 *
 * ```text
 *     NODES=80000             before     after    speedup
 *     b.k = 5    (1%)          264.7      83.4     3.17x
 *     b.k < 10  (10%)          283.3     116.3     2.44x
 *     b.k >= 0 (100%)          393.0     399.6     flat   <- nothing to prune, as it should be
 *
 *     controls at 20k          TRAILING c.k = 5  33.5 ms (unchanged)
 *                              START    a.k = 5   7.5 ms (unchanged)
 * ```
 *
 * ⚠️⚠️ **THE CORRECTNESS ARGUMENT IS ABOUT *WHEN* A PREDICATE RUNS, NOT WHAT IT ANSWERS.** The general
 * matcher evaluates a clause `WHERE` once per COMPLETE match, so a start that yields no row must never
 * evaluate it — items 139-145 pinned that with five tests, and `hop2-projection.ts`'s own note defers the
 * push-down for exactly this reason.
 *
 * 🔑 Both halves of that argument survive for a **mid-only, raise-free** conjunct:
 *
 *   - it cannot read the FAR variable, so its value is already decided once the middle is bound — moving
 *     it earlier changes how OFTEN it runs, never WHAT it answers;
 *   - it cannot RAISE, so evaluating it on a middle whose second hop is empty — where the deep gate would
 *     never have run — has no observable effect.
 *
 * ⚠️ Both conditions are tested below, and a predicate failing EITHER must keep the old placement.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * 12 `P` vertices in a chain, `k = i % 4`, plus a DEAD-END middle whose second hop is empty — the shape
 * that makes "evaluated earlier than before" observable if the predicate could fault.
 */
const g = (): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 12; i += 1) {
    graph.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 4, n: i } });
  }

  /* u0->u1->u2 … u10->u11; u11 has NO outgoing edge, so it is a middle with an empty second hop. */
  for (let i = 0; i < 11; i += 1) {
    graph.addEdge({
      id: `e${i}`,
      from: graph.getVertexById(`u${i}`)!,
      to: graph.getVertexById(`u${i + 1}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return graph;
};

const rows = (graph: Graph, q: string): Record<string, unknown>[] => {
  const out = query(graph, q) as unknown as { rows?: Record<string, unknown>[] };

  return out.rows ?? (out as unknown as Record<string, unknown>[]);
};

const ks = (graph: Graph, q: string): unknown[] => rows(graph, q).map((r) => r.k);

const H2 = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) ';

describe('the mid-conjunct push-down (item 2225)', () => {
  describe('🔑 the answer is unchanged, pinned against the UNFILTERED spelling', () => {
    test('a mid filter keeps exactly the rows whose middle matches', () => {
      /*
       * ⚠️ DERIVED, not a literal: take the unfiltered two-hop rows and keep those whose MIDDLE has k=1.
       * `b` is `u1,u2,…,u10`, so the middles with `k = 1` are u1, u5, u9 — and each contributes one row.
       */
      const all = rows(g(), `${H2}RETURN b.k AS bk, c.k AS k`);
      const want = all.filter((r) => r.bk === 1).map((r) => r.k);

      expect(ks(g(), `${H2}WHERE b.k = 1 RETURN c.k AS k`).sort()).toEqual(want.sort());
      expect(want.length).toBe(3);
    });

    test('an AND of two mid conjuncts still pushes', () => {
      const got = ks(g(), `${H2}WHERE b.k = 1 AND b.n > 4 RETURN c.k AS k`);
      const all = rows(g(), `${H2}RETURN b.k AS bk, b.n AS bn, c.k AS k`);

      expect(got.sort()).toEqual(
        all
          .filter((r) => r.bk === 1 && (r.bn as number) > 4)
          .map((r) => r.k)
          .sort(),
      );
    });

    test('🔑 a PARENTHESISED spelling pushes identically — `flattenAnd` is why', () => {
      expect(ks(g(), `${H2}WHERE (b.k = 1) AND (b.n > 4) RETURN c.k AS k`).sort()).toEqual(
        ks(g(), `${H2}WHERE b.k = 1 AND b.n > 4 RETURN c.k AS k`).sort(),
      );
    });
  });

  describe('⚠️⚠️ the declines — each is a correctness bound, not caution', () => {
    test('a predicate reading the FAR variable must NOT push, and still answers right', () => {
      const all = rows(g(), `${H2}RETURN c.k AS k`);

      expect(ks(g(), `${H2}WHERE c.k = 1 RETURN c.k AS k`)).toEqual(
        all.filter((r) => r.k === 1).map((r) => r.k),
      );
    });

    test('a predicate reading BOTH middle and far must not push', () => {
      const all = rows(g(), `${H2}RETURN b.k AS bk, c.k AS k`);

      expect(ks(g(), `${H2}WHERE b.k = 1 AND c.k = 2 RETURN c.k AS k`).sort()).toEqual(
        all
          .filter((r) => r.bk === 1 && r.k === 2)
          .map((r) => r.k)
          .sort(),
      );
    });

    test('🔑🔑 a RAISING predicate keeps its placement AND still raises', () => {
      /*
       * 🔑 ARITHMETIC is the raising case — `a.k / 0` throws `E_INVALID_VALUE`, which is exactly why the
       * operand test is `cannotRaise`/`param` and not "is a comparison". ⚠️ If this ever stops throwing,
       * the push-down's whole gate needs revisiting, so the test asserts the THROW rather than a count.
       */
      expect(() => rows(g(), `${H2}WHERE b.n / 0 = 1 RETURN c.k AS k`)).toThrow();
    });

    test('🔑🔑🔑 RAISE PARITY: a predicate that faults ONLY on a DEAD-END middle must NOT raise', () => {
      /*
       * ⚠️⚠️ **THIS IS THE TEST THE WHOLE GATE RESTS ON, and the first version of this file lacked it.** A
       * mutation round showed `raise-free check removed` SURVIVING, because every raising middle in the
       * other fixtures has a non-empty second hop — so the predicate throws either way and the test cannot
       * tell placement apart.
       *
       * 🔑 `b.n / (b.k - 3)` faults ONLY at `b.k === 3`, and `u3` is a middle with NO outgoing edge. So:
       *
       *   - correct behaviour: the general path never completes a match through `u3`, so the predicate is
       *     never evaluated there and the query ANSWERS (0 rows);
       *   - a wrongly-pushed predicate evaluates at the middle and THROWS — a raise where the general path
       *     raises none, which is exactly items 139-145's parity.
       *
       * ⚠️ The one-hop sibling below proves the predicate really does fault, so a passing two-hop case is
       * not simply a predicate that never raises.
       */
      const chain = (): Graph => {
        const graph = new Graph();

        for (let i = 0; i < 4; i += 1) {
          graph.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i, n: i + 1 } });
        }

        for (let i = 0; i < 3; i += 1) {
          graph.addEdge({
            id: `e${i}`,
            from: graph.getVertexById(`u${i}`)!,
            to: graph.getVertexById(`u${i + 1}`)!,
            labels: ['E'],
            properties: {},
          });
        }

        return graph;
      };

      expect(rows(chain(), `${H2}WHERE b.n / (b.k - 3) = 1 RETURN c.k AS k`)).toHaveLength(0);
      /* The SAME predicate where the faulting vertex IS a complete match: it must still raise. */
      expect(() =>
        rows(chain(), 'MATCH (a:P)-[:E]->(b:P) WHERE b.n / (b.k - 3) = 1 RETURN b.k AS k'),
      ).toThrow();
    });

    test('⚠️ a NULL comparison is UNKNOWN and must be dropped like FALSE', () => {
      /* 🔑 A missing property compares UNKNOWN; a clause `WHERE` keeps only definite TRUE. */
      expect(rows(g(), `${H2}WHERE b.missing = 1 RETURN c.k AS k`)).toHaveLength(0);
    });

    test('⚠️ a middle with an EMPTY second hop cannot change the answer', () => {
      /*
       * 🔑 `u11` is a middle with no outgoing edge. The deep gate would never have evaluated for it; the
       * mid gate does. That is only sound because the predicate cannot fault — and the row count must be
       * identical either way, which is what this pins.
       */
      const withDeadEnd = ks(g(), `${H2}WHERE b.k = 3 RETURN c.k AS k`);
      const graph = g();

      /* Give u11 an outgoing edge, so it is no longer a dead end, and the dead-end rows reappear. */
      graph.addEdge({
        id: 'tail',
        from: graph.getVertexById('u11')!,
        to: graph.getVertexById('u0')!,
        labels: ['E'],
        properties: {},
      });

      expect(ks(graph, `${H2}WHERE b.k = 3 RETURN c.k AS k`).length).toBe(withDeadEnd.length + 1);
    });
  });

  test('⚠️ a WRITE between two asks is reflected', () => {
    const graph = g();
    const q = `${H2}WHERE b.k = 1 RETURN c.k AS k`;
    const before = ks(graph, q).length;

    graph.addEdge({
      id: 'fresh',
      from: graph.getVertexById('u1')!,
      to: graph.getVertexById('u0')!,
      labels: ['E'],
      properties: {},
    });

    expect(ks(graph, q).length).toBe(before + 1);
  });
});
