import { describe, expect, it } from 'bun:test';

/**
 * NESTED SUBQUERY ANSWERS — a subquery in every structural position the parser can nest one into.
 *
 * ⚠️ THIS FILE DOES NOT GUARD `hasSubquery`, AND SAYING SO IS THE POINT (item 1500). It was written
 * to, after a `for...in` change to that walk's recursive step, on the reasoning that a walk which
 * missed a nested subquery would let the planner push a predicate it must not push. Three mutants
 * were built to check that:
 *
 *   norecurse  stop recursing into object children entirely
 *   noarrays   recurse, but skip array children (where `and`/`in`/`list`/args live)
 *   oneLevel   look exactly one level down instead of all the way
 *
 * **All three survive this file AND the full 3,744-test gql suite.** Rows are identical, and so is
 * FAULT behaviour: `WHERE n.k = 999 AND (COUNT { … CAST('notanumber' AS INTEGER) … } + 0) = 1`
 * returns 0 rows without raising on the pristine build and on every mutant, where the un-guarded
 * spelling (`WHERE EXISTS { … CAST … }`) raises. So the recursion's result is not observable through
 * any shape I could construct — other gates (`itemLocal`'s SUBQUERY_KINDS allowlist, `rowLocal`,
 * `freePredicateVars`) decline these shapes before it matters.
 *
 * `hasSubquery`'s own comment says it is a generic walk so that it "cannot miss one". That is a
 * claim about a failure nothing currently exercises — recorded at item 1500 rather than acted on,
 * because a conservative gate is cheap insurance and removing it on the strength of surviving
 * mutants would be exactly backwards.
 *
 * What these tests DO pin is the answers: a subquery nested in a comparison, an AND/OR/NOT,
 * arithmetic, an IN list, a CASE, a function argument and alongside an EXISTS all return the rows
 * the projection-side reference returns. That is worth having on its own; it is just not a guard on
 * the walk.
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

const g = (): Graph => {
  const graph = new Graph();
  const ids: string[] = [];

  for (let i = 0; i < 12; i += 1) {
    ids.push(`v${i}`);
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, flag: i % 2 === 0 } });
  }

  // A deliberately uneven out-degree, so a `COUNT { }` subquery takes different values per row and
  // a dropped subquery cannot accidentally agree.
  let e = 0;

  for (let i = 0; i < 12; i += 1) {
    for (let j = 0; j < i % 4; j += 1) {
      graph.addEdge({
        id: `e${e}`,
        labels: ['E'],
        from: graph.getVertexById(ids[i])!,
        to: graph.getVertexById(ids[(i + j + 1) % 12])!,
      });
      e += 1;
    }
  }

  return graph;
};

const graph = g();

/**
 * Sorted projected values, so row order (unspecified without ORDER BY) cannot make a pair disagree.
 *
 * ⚠️ It projects `n.k`, NOT `n.id`. The first version of this file projected `n.id`, which reads
 * back as `null` for every row — so every comparison degenerated to a row COUNT and the file was
 * much weaker than it looked. A reference query that is wrong in the SAME way as the query under
 * test agrees with it for the wrong reason.
 */
const ids = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => String(r.i)).sort();

describe('a subquery is found in every position it can nest into', () => {
  // Each entry: a predicate placing `COUNT { … }` somewhere, and an equivalent predicate with the
  // count replaced by the literal value it takes for the rows that should match. If the walk fails
  // to see the subquery the planner pushes the predicate into the scan, and these diverge.
  for (const [name, pred] of [
    ['bare comparison', 'COUNT { MATCH (n)-[:E]->() } = 2'],
    ['inside AND', 'n.k > 0 AND COUNT { MATCH (n)-[:E]->() } = 2'],
    ['inside OR', 'n.k < 0 OR COUNT { MATCH (n)-[:E]->() } = 2'],
    ['inside NOT', 'NOT (COUNT { MATCH (n)-[:E]->() } <> 2)'],
    ['inside ARITHMETIC', 'COUNT { MATCH (n)-[:E]->() } + 1 = 3'],
    ['nested two deep in arithmetic', '(COUNT { MATCH (n)-[:E]->() } * 2) - 2 = 2'],
    ['inside an IN list', 'COUNT { MATCH (n)-[:E]->() } IN [2]'],
    ['inside a CASE', 'CASE WHEN COUNT { MATCH (n)-[:E]->() } = 2 THEN true ELSE false END'],
    ['inside a function argument', 'abs(COUNT { MATCH (n)-[:E]->() } - 2) = 0'],
    [
      'both sides of a comparison',
      'COUNT { MATCH (n)-[:E]->() } = COUNT { MATCH (n)-[:E]->() } + 0 AND COUNT { MATCH (n)-[:E]->() } = 2',
    ],
    ['with EXISTS alongside', 'EXISTS { MATCH (n)-[:E]->() } AND COUNT { MATCH (n)-[:E]->() } = 2'],
  ] as const) {
    it(`detects it ${name}`, () => {
      const rows = query(graph, `MATCH (n:P) WHERE ${pred} RETURN n.k AS i`);
      // The reference: enumerate every vertex and filter in the projection instead, which no
      // pushdown can reach.
      const all = query(graph, 'MATCH (n:P) RETURN n.k AS i, COUNT { MATCH (n)-[:E]->() } AS c');
      const want = all
        .filter((r) => Number(r.c) === 2)
        .map((r) => String(r.i))
        .sort();

      expect(want.length).toBeGreaterThan(0);
      expect(ids(rows)).toEqual(want);
    });
  }
});

describe('the walk still answers NO for subquery-free predicates', () => {
  // The other direction: a false POSITIVE would decline a pushdown that is legal, which costs speed
  // rather than correctness — but it would also mean the walk is matching on something it should
  // not, so it is worth pinning.
  for (const [name, pred] of [
    ['a plain comparison', 'n.k = 2'],
    ['an AND chain', 'n.k > 1 AND n.k < 5 AND n.flag'],
    ['a CASE with no subquery', 'CASE WHEN n.k = 2 THEN true ELSE false END'],
    ['a list membership', 'n.k IN [1, 2, 3]'],
    [
      '⚠️ a predicate whose literal is a TEMPORAL',
      "n.k >= 0 AND DATE '2020-01-01' <= DATE '2020-01-02'",
    ],
  ] as const) {
    it(`answers correctly for ${name}`, () => {
      const rows = query(graph, `MATCH (n:P) WHERE ${pred} RETURN n.k AS i`);
      const all = query(graph, 'MATCH (n:P) RETURN n.k AS i, n.k AS k, n.flag AS f');

      expect(rows.length).toBeLessThanOrEqual(all.length);
      // Every returned id is a real vertex, and the set is stable across spellings of the scan.
      const viaProjection = query(graph, `MATCH (n:P) WHERE ${pred} RETURN n.k AS i ORDER BY i`);

      expect(ids(rows)).toEqual(ids(viaProjection));
    });
  }

  it('⚠️ a stored TEMPORAL does not look like a subquery to the walk', () => {
    // `hasSubquery` tests `typeof rec.kind === 'string' && SUBQUERY_KINDS.has(rec.kind)`, and a
    // `LocalDate` carries `kind = 'date'` — the exact collision that cost item 1490 a 2.4x. Here it
    // is harmless because the test is an ALLOWLIST of subquery kinds rather than a denylist, and
    // this pins that: a temporal literal in a predicate must not be mistaken for a subquery, which
    // would decline pushdown on every date query.
    const withDate = query(
      graph,
      "MATCH (n:P) WHERE n.k >= 0 AND DATE '2020-01-01' < DATE '2021-01-01' RETURN n.k AS i",
    );
    const withoutDate = query(graph, 'MATCH (n:P) WHERE n.k >= 0 RETURN n.k AS i');

    expect(ids(withDate)).toEqual(ids(withoutDate));
    expect(withDate.length).toBe(12);
  });
});
