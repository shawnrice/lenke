/*
 * Item 2087 — `MATCH <chain> RETURN count(*)` off the level recurrence.
 *
 * ⚠️⚠️ **TWO THINGS CAN GO WRONG HERE AND NEITHER IS THE ROUTE.**
 *
 * 1. THE COUNT. `count(*)` over a chain is the number of PATHS, which is `sum(u)` after the
 *    recurrence — but only if every label mask is applied. A rung that dropped an intermediate label
 *    would OVER-count, and at the default FANOUT=1 it would still be right: with out-degree 1 there
 *    is no branching, so `n·f^k` is `n` whatever the masks do. CLAUDE.md spends a section on exactly
 *    this ("harmless at FANOUT=1, wrong at every higher fanout"), so every count below is asserted at
 *    a BRANCHING fanout as well.
 * 2. THE EXECUTION-TIME DECLINE. The rung sits ABOVE `countShortcut` and must hand back the
 *    all-vacuous case, which that rung answers more cheaply. A decline that never fires is a silent
 *    1.5x regression on the vacuous path; one that always fires is the 4.90x left on the table.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../index.js';
import { chainLabelsAllVacuous } from './chain-fold-levels.js';

/**
 * `n` vertices labelled `:P`, each with `fanout` DISTINCT out-edges, plus optional extras.
 *
 * ⚠️ THE TARGET SPLITS ON THE REPEAT INDEX (`hop`), which is what makes the fanout real. The form
 * `(i * a + b) % n` is invariant under `i -> i + n`, so a generator looping `i` over `n * fanout`
 * sends all of one vertex's edges to the SAME target — out-degree looks right and the graph is
 * functional. Six fixtures in this repo had that bug.
 */
const chainGraph = (n: number, fanout: number, extras: readonly string[] = []): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 5 } });
  }

  for (const [j, label] of extras.entries()) {
    g.addVertex({ id: `x${j}`, labels: [label], properties: { k: 0 } });
  }

  for (let hop = 0; hop < fanout; hop += 1) {
    for (let i = 0; i < n; i += 1) {
      g.addEdge({
        id: `e${hop}_${i}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % n}`)!,
        labels: ['E'],
        properties: {},
      });
    }
  }

  return g;
};

/** The distinct out-targets per source — the fixture's own statistic, not its answer. */
const branches = (g: Graph): number => {
  let min = Infinity;

  for (const v of g.vertices) {
    if (!v.labels.has('P')) {
      continue;
    }

    const seen = new Set<string>();

    // ⚠️ `outEdges` DOES NOT EXIST on `Vertex`; the adjacency is `adjFrom`, a Map of label -> Set.
    // Checked against the prototype rather than assumed, after the first spelling threw.
    for (const byLabel of v.adjFrom?.values() ?? []) {
      for (const e of byLabel) {
        seen.add(e.to.id);
      }
    }

    min = Math.min(min, seen.size);
  }

  return min;
};

const countOf = (g: Graph, q: string): unknown => (query(g, q)[0] as Record<string, unknown>).c;

describe('chain count(*) via the level recurrence (item 2087)', () => {
  test('⚠️ THE FIXTURE BRANCHES — asserted before any count is trusted', () => {
    // 🔑 Without this, every `n·f²` below is true by construction and validates nothing.
    expect(branches(chainGraph(50, 3))).toBe(3);
    expect(branches(chainGraph(50, 4))).toBe(4);
  });

  test('a two-hop count(*) is n·f², at THREE fanouts', () => {
    for (const f of [1, 2, 3]) {
      const g = chainGraph(60, f, ['Q']);

      expect(countOf(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c')).toBe(
        60 * f * f,
      );
    }
  });

  test('a three-hop count(*) is n·f³, at a BRANCHING fanout', () => {
    const g = chainGraph(60, 3, ['Q']);

    expect(countOf(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN count(*) AS c')).toBe(
      60 * 27,
    );
  });

  test('⚠️⚠️ AN INTERMEDIATE LABEL FILTERS, and FANOUT=1 could not see it', () => {
    /*
     * 🔑 THE ONE WAY THIS RUNG COULD OVER-COUNT. `b:Q` is carried by NO `v` vertex, so every path is
     * killed at the middle node and the answer is 0. A rung that ignored `level.label` would return
     * the unfiltered `n·f²`. ⚠️ At FANOUT=1 both a correct and an over-counting rung return a number
     * of the same ORDER, so the branching fanout is what makes the 0 unmistakable.
     */
    const g = chainGraph(60, 3, ['Q']);

    expect(countOf(g, 'MATCH (a:P)-[:E]->(b:Q)-[:E]->(c:P) RETURN count(*) AS c')).toBe(0);
  });

  test('⚠️ a START label filters too — the seed mask, not a level mask', () => {
    const g = chainGraph(60, 3, ['Q']);

    expect(countOf(g, 'MATCH (a:Q)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c')).toBe(0);
  });

  test("⚠️ a FAR label filters — the last level's mask", () => {
    const g = chainGraph(60, 3, ['Q']);

    expect(countOf(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:Q) RETURN count(*) AS c')).toBe(0);
  });

  test('⚠️⚠️ IT AGREES WITH THE PER-EDGE PATH, which `LIMIT` forces', () => {
    /*
     * ⚠️ THE ORACLE. A `LIMIT` declines this rung by its own gate (see the note there on `LIMIT 0`),
     * so the same query with a vacuous `LIMIT` is answered by the general machinery — a second route
     * to the same number, which is the only check that does not restate this rung's arithmetic.
     */
    const g = chainGraph(60, 3, ['Q']);
    const q = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c';

    // ⚠️ `g` HERE ALREADY CARRIES `Q`, so the un-limited arm really is this rung and the limited
    // arm really is the general path — the two routes, not one route twice.
    expect(countOf(g, q)).toBe(countOf(g, `${q} LIMIT 10`));
  });

  test('⚠️⚠️ `LIMIT 0` YIELDS NO ROWS — the reason the gate refuses paging', () => {
    /*
     * 🔑 This rung returns its one row unconditionally, so admitting `LIMIT 0` would be a WRONG
     * ANSWER rather than a slow one. The gate refuses it and the general path answers — asserted
     * here, because a gate that stopped refusing would change this from 0 rows to 1.
     */
    /*
     * ⚠️⚠️ **`['Q']` IS LOAD-BEARING AND ITS ABSENCE MADE THIS TEST VACUOUS.** Written without an
     * off-label vertex, `:P` is carried by every vertex, the rung DECLINES at execution time, and the
     * general path answers `[]` whatever the gate says — so a mutant admitting `LIMIT` SURVIVED this
     * assertion. With `Q` present the rung is the one answering, and admitting `LIMIT` returns
     * `[{ c: 540 }]` for `LIMIT 0`: measured, not assumed.
     *
     * 🔑 Same shape as item 2085's "every label-writing test reads FIRST": a test must force the
     * branch it is written for, and a fixture that routes around it looks identical when passing.
     */
    const g = chainGraph(60, 3, ['Q']);

    expect(
      query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c LIMIT 0'),
    ).toStrictEqual([]);
  });

  test('⚠️ THE ALL-VACUOUS CASE IS HANDED BACK, and still answers correctly', () => {
    /*
     * 🔑 THE EXECUTION-TIME DECLINE. With no off-label vertex, `:P` is carried by EVERY vertex, so
     * `countShortcut`'s unfiltered CSR arm answers (12.57 ms/rep against this rung's ~20) and this
     * rung returns `undefined`. The ANSWER is what a test can see; the route is measured, not
     * asserted — but a decline that broke would show up as a wrong number here if the two routes ever
     * disagreed, which is why it is asserted at a branching fanout too.
     */
    for (const f of [1, 3]) {
      const g = chainGraph(60, f); // NO extras — every vertex is `:P`, so the label is vacuous.

      expect(countOf(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c')).toBe(
        60 * f * f,
      );
    }
  });

  /*
   * ⚠️⚠️ THE ROUTE PREDICATE, TESTED DIRECTLY. Five mutants against the execution-time decline all
   * SURVIVED the tests above, because both routes return the same count — a route choice is
   * answer-equivalent by construction, so only a unit test of the predicate itself has teeth.
   */
  test('a TWO-ITEM grouped count declines — but `items.length` is what catches it', () => {
    const g = chainGraph(60, 3, ['Q']);
    const rows = query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k, count(*) AS n');

    // Five distinct `k` values, each with its own tally — not one row of 540.
    expect(rows).toHaveLength(5);
    expect(rows.reduce((t, r) => t + Number((r as Record<string, unknown>).n), 0)).toBe(540);
  });

  test('⚠️⚠️ A ONE-ITEM `GROUP BY` DECLINES — the shape the `groupKeys` guard exists for', () => {
    /*
     * 🔑 A MUTANT ADMITTING `groupKeys` SURVIVED TWO EARLIER ATTEMPTS AT THIS TEST, and each failure
     * was instructive:
     *
     *   - `RETURN c.k AS k, count(*)` — TWO projection items, so `items.length !== 1` declines first
     *     and the `groupKeys` check never runs.
     *   - `LET k = c.k … GROUP BY k` — ISO-GQL groups by a BOUND NAME, and the `LET` makes it THREE
     *     clauses, so `clauses.length !== 2` declines first instead.
     *
     * 🔑 `GROUP BY <pattern variable>` is the shape that reaches it: two clauses, ONE projection item,
     * and a non-empty group key. Admitting it would collapse every group into a single total.
     */
    const g = chainGraph(60, 3, ['Q']);
    const rows = query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS n GROUP BY c');

    // One row per distinct far vertex reached, summing to the same 540 paths.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.reduce((t, r) => t + Number((r as Record<string, unknown>).n), 0)).toBe(540);
  });

  test("⚠️ `SKIP 1` YIELDS NO ROWS — the paging refusal's other half", () => {
    /*
     * ⚠️ A separate mutant from `LIMIT`, and it survived until this test existed: this rung returns one
     * row, so `SKIP 1` must yield none. The fixture carries `Q` so the rung is the one answering.
     */
    const g = chainGraph(60, 3, ['Q']);

    expect(
      query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c SKIP 1'),
    ).toStrictEqual([]);
  });

  describe('the vacuity predicate (the execution-time decline)', () => {
    const levelsOf = (...labels: (string | undefined)[]): { label: string | undefined }[] =>
      labels.map((label) => ({ label }));

    test('🔑 ALL VACUOUS → true, so `countShortcut` keeps the query', () => {
      // No off-label vertex: every vertex is `:P`, so `:P` elides.
      const g = chainGraph(40, 2);

      expect(chainLabelsAllVacuous(g, 'P', levelsOf('P', 'P'))).toBe(true);
    });

    test('⚠️ a NON-VACUOUS START → false', () => {
      const g = chainGraph(40, 2, ['Q']);

      expect(chainLabelsAllVacuous(g, 'P', levelsOf('P', 'P'))).toBe(false);
    });

    test('⚠️⚠️ a non-vacuous label on ONE LEVEL ONLY → false', () => {
      /*
       * 🔑 THE MUTANT THIS EXISTS FOR. Dropping `levels.every(...)` leaves the start test alone, so a
       * query whose START label is vacuous and whose LEVEL label is not would wrongly be handed back
       * to the per-edge tally. `Q` is carried by one vertex, so a level asking for it filters hard.
       */
      const g = chainGraph(40, 2, ['Q']);

      expect(chainLabelsAllVacuous(g, undefined, levelsOf('Q'))).toBe(false);
      expect(chainLabelsAllVacuous(g, undefined, levelsOf(undefined, 'Q'))).toBe(false);
    });

    test('⚠️ an ABSENT label counts as vacuous — there is nothing to filter', () => {
      const g = chainGraph(40, 2, ['Q']);

      expect(chainLabelsAllVacuous(g, undefined, levelsOf(undefined, undefined))).toBe(true);
    });

    test('⚠️ a label NO vertex carries is NOT vacuous — it filters everything', () => {
      /*
       * ⚠️ `vacuousLabel` is an EXACT equality (the bucket size against `vertexCount`), so a label
       * with an EMPTY bucket is not vacuous — correctly, since eliding it would turn "no rows" into
       * "every row". The sharpest case for a predicate that tested "bucket is missing".
       */
      const g = chainGraph(40, 2);

      expect(chainLabelsAllVacuous(g, 'NOBODY', levelsOf('P'))).toBe(false);
    });
  });

  test('an UNLABELLED chain counts the same, by whichever route takes it', () => {
    const g = chainGraph(60, 3, ['Q']);

    // `x0` is isolated, so it contributes no paths whether it is label-matched or not.
    expect(countOf(g, 'MATCH (a)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c')).toBe(60 * 9);
  });
});
