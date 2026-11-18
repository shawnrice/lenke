/*
 * Item 2203 — a `WITH` that projects nothing but the already-bound variables is dropped, so the `MATCH`
 * after it can reach the hop shortcuts its equivalent spelling already reaches.
 *
 * ```text
 *     row                        BEFORE              NEW
 *     WITH a hop   TARGET   252.01 / 257.18    6.55 / 6.74    ~38x
 *     NEXT form    TARGET   258.71 / 260.87    7.68 / 6.82    ~36x
 *     WITH DISTINCT a [ctl] 403.47 / 395.30  401.30 / 397.81  flat — the gate DECLINES
 *     plain hop       [ctl]   6.42 /   9.69    6.69 /   6.91  flat
 *     two MATCH       [ctl]  10.28 /   7.26    6.85 /   9.28  flat
 * ```
 *
 * 🔑 `NEXT` is the same mechanism: `parseNextChain` desugars each pre-`NEXT` `RETURN` into a `WITH`.
 *
 * ⚠️⚠️ **THE CORRECTNESS ARGUMENT IS ABOUT SCOPE, NOT ROWS.** A `WITH` NARROWS scope — `MATCH (a)-[:K]->(b)
 * WITH a …` drops `b` — so eliding one that drops a variable would leave it visible to later clauses. The
 * gate therefore fires only when the projected names cover EVERY bound variable. The test that pins this is
 * `a later reference to a DROPPED variable still fails`: it must keep throwing.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const g = (): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 12; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 4, age: i } });
  }

  for (let i = 0; i < 8; i += 1) {
    graph.addEdge({
      id: `e${i}`,
      from: graph.getVertexById(`v${i}`)!,
      to: graph.getVertexById(`v${i + 1}`)!,
      labels: ['K'],
      properties: {},
    });
  }

  return graph;
};

const rows = (graph: Graph, q: string): Record<string, unknown>[] => {
  const out = query(graph, q) as unknown as { rows?: Record<string, unknown>[] };

  return out.rows ?? (out as unknown as Record<string, unknown>[]);
};

const c = (graph: Graph, q: string): unknown => rows(graph, q)[0]?.c;

describe('a pass-through WITH is elided (item 2203)', () => {
  describe('🔑 the elided forms, each against the spelling without the WITH', () => {
    test('WITH a answers what the same query without it answers', () => {
      /* ⚠️ Pinned against the ORACLE spelling, so neither literal can drift alone. */
      const oracle = c(g(), 'MATCH (a:P) MATCH (a)-[:K]->(b) RETURN count(*) AS c');

      expect(c(g(), 'MATCH (a:P) WITH a MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(oracle);
      expect(oracle).toBe(8);
    });

    test('🔑 `WITH *` projects everything in scope, so it drops nothing', () => {
      expect(c(g(), 'MATCH (a:P) WITH * MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(8);
    });

    test('🔑 the NEXT spelling, which the parser desugars to this WITH', () => {
      expect(c(g(), 'MATCH (a:P) RETURN a NEXT MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(8);
    });

    test('a WITH naming SEVERAL bound variables is still a pass-through', () => {
      const q = 'MATCH (a:P)-[:K]->(b) WITH a, b MATCH (b)-[:K]->(d) RETURN count(*) AS c';
      const oracle = 'MATCH (a:P)-[:K]->(b) MATCH (b)-[:K]->(d) RETURN count(*) AS c';

      expect(c(g(), q)).toBe(c(g(), oracle));
    });
  });

  describe('⚠️⚠️ scope narrowing — the reason the gate compares SETS', () => {
    test('a WITH that DROPS a variable is left in place', () => {
      const q = 'MATCH (a:P)-[:K]->(b) WITH a MATCH (a)-[:K]->(d) RETURN count(*) AS c';

      expect(c(g(), q)).toBe(8);
    });

    test('🔑🔑 a later reference to a DROPPED variable STILL FAILS', () => {
      /*
       * 🔑 THE TEST THAT GUARDS THE WHOLE GATE. Eliding this `WITH` would leave `b` bound and the query
       * would SUCCEED — a silent semantic change no row-count assertion can see. ⚠️ A mutant that drops
       * the bound-set comparison is caught here and nowhere else.
       */
      expect(() =>
        rows(g(), 'MATCH (a:P)-[:K]->(b) WITH a MATCH (a)-[:K]->(d) RETURN b.k AS c'),
      ).toThrow();
    });
  });

  describe('⚠️ the declines, each for its own reason', () => {
    test('DISTINCT dedupes rows, so it is not a pass-through', () => {
      expect(c(g(), 'MATCH (a:P) WITH DISTINCT a MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(
        8,
      );
    });

    test('⚠️ ORDER BY + LIMIT selects rows — eliding it would CHANGE THE ANSWER', () => {
      /* 🔑 2, not 8: the limit keeps three `a`s and only two of them have an outgoing edge. */
      expect(
        c(g(), 'MATCH (a:P) WITH a ORDER BY a.k LIMIT 3 MATCH (a)-[:K]->(b) RETURN count(*) AS c'),
      ).toBe(2);
    });

    /*
     * ⚠️⚠️ **EVERY GUARD NEEDS A SHAPE THAT ISOLATES IT, AND THE FIRST VERSION OF THESE TESTS HAD NONE.**
     * A mutation round disabled `limit`, `skip` and `orderBy` ONE AT A TIME and all three SURVIVED — not
     * because they do nothing, but because every test query here combined `ORDER BY` *with* `LIMIT`, so
     * whichever guard was left standing still declined the clause. Disabling `orderBy` AND `limit`
     * together answers **8 where 2 is right** — a wrong answer, so they are load-bearing.
     *
     * 🔑 `LIMIT`/`SKIP` with NO `ORDER BY` is what separates them. (ISO-GQL allows it; the row set is then
     * unspecified, which is `order-is-unspecified` and fine — the COUNT is what this asserts.)
     */
    test('⚠️🔑 LIMIT ALONE, so the limit guard is the only one that can decline', () => {
      /* 3, not 8: three `a`s survive the limit. Elided, the limit would vanish entirely. */
      expect(c(g(), 'MATCH (a:P) WITH a LIMIT 3 MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(3);
    });

    test('⚠️🔑 SKIP ALONE, likewise', () => {
      /* 0, not 8: skipping 9 of 12 leaves three `a`s, none of which has an outgoing edge. */
      expect(c(g(), 'MATCH (a:P) WITH a SKIP 9 MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(0);
    });

    test('⚠️⚠️ a WITH carrying a WHERE filters the carried rows', () => {
      /*
       * 🔑🔑 THE GUARD THE FIRST VERSION OF THIS PASS MISSED ENTIRELY. A bare-looking `WITH a` can carry a
       * `WHERE`, and eliding it DROPS THE FILTER. Four existing tests caught it (`TCK WithWhere1/3` twice,
       * the bind-distinction test, the named-`CALL` YIELD test); this pins it here too.
       */
      const filtered = c(
        g(),
        'MATCH (a:P) WITH a WHERE a.k > 1 MATCH (a)-[:K]->(b) RETURN count(*) AS c',
      );
      const unfiltered = c(g(), 'MATCH (a:P) WITH a MATCH (a)-[:K]->(b) RETURN count(*) AS c');

      expect(filtered).not.toBe(unfiltered);
      expect(unfiltered).toBe(8);
      expect(filtered).toBe(4);
    });

    test('a non-var item with NO alias is not a pass-through either', () => {
      /*
       * 🔑 The alias guard cannot cover this one — there is no alias. Without the `kind !== 'var'` test
       * the clause would be elided and `a.k` would stop driving the next `MATCH`.
       */
      expect(c(g(), 'MATCH (a:P) WITH a.k MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(96);
    });

    test('an ALIAS renames a column, so the clause is not a no-op', () => {
      expect(c(g(), 'MATCH (a:P) WITH a AS z MATCH (z)-[:K]->(b) RETURN count(*) AS c')).toBe(8);
    });

    test('a COMPUTED item is not a bare variable', () => {
      expect(c(g(), 'MATCH (a:P) WITH a, a.k AS kk MATCH (a)-[:K]->(b) RETURN count(*) AS c')).toBe(
        8,
      );
    });

    test('an AGGREGATE collapses rows', () => {
      expect(c(g(), 'MATCH (a:P) WITH count(*) AS n RETURN n AS c')).toBe(12);
    });

    test('⚠️ a TRAILING WITH is never elided — nothing would carry the output', () => {
      expect(c(g(), 'MATCH (a:P) WITH a RETURN count(*) AS c')).toBe(12);
    });
  });

  /*
   * ⚠️⚠️ **TWO GUARDS ARE SOUND BUT NOT OBSERVABLE FROM A COUNT, and saying so is more useful than a test
   * that pretends otherwise.**
   *
   * - **`distinct`**: every fixture shape tried had already-unique keys, so `WITH DISTINCT b` and `WITH b`
   *   agree (7 and 7). The guard stays because `DISTINCT` dedupes rows BY DEFINITION; a fixture that
   *   exhibits it would need a repeated binding reaching the clause.
   * - **`orderBy` alone**: re-ordering rows cannot change a `count(*)`, and this rung's shapes are counts.
   *   Disabling it together with `limit` DOES produce a wrong answer (8 against 2), which is what pins the
   *   pair; `limit`/`skip` are pinned individually above.
   * - **the bound-set comparison**: removing it leaves `… WITH a … RETURN b.k` STILL throwing
   *   ``variable `b` is not defined``, so scope narrowing is enforced elsewhere — on the original clauses,
   *   not by this pass. The check stays as a soundness guard rather than being trusted as the enforcer.
   */
  test('⚠️ a WRITE between two asks is reflected', () => {
    const graph = g();
    const q = 'MATCH (a:P) WITH a MATCH (a)-[:K]->(b) RETURN count(*) AS c';

    expect(c(graph, q)).toBe(8);
    graph.addEdge({
      id: 'fresh',
      from: graph.getVertexById('v10')!,
      to: graph.getVertexById('v11')!,
      labels: ['K'],
      properties: {},
    });
    expect(c(graph, q)).toBe(9);
  });
});
