import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

// Audit item 249. A plain hop's inline `WHERE` is LIFTED to the repetition's unit predicate,
// because it may reference the repetition's other variables (`-[e:R WHERE e.w > x.n]->` needs
// `x`, bound only at rep completion). But the matcher evaluates only the OUTERMOST unit's
// `where` — `hasWhere = unit.where !== undefined` over the unit it was handed — so a predicate
// lifted inside a NESTED sub-unit was carried by the compiler and then never evaluated.
//
// Settled by the same equivalence item 244 used, not by comparing engines: one outer repetition
// of an inner 1..1-hop group IS a flat 1..1-hop group, so an engine answering them differently
// is wrong about one of them. The unfiltered answer being identical to the "filtered" one is
// the tell.
//
// The fix: an edge-ONLY predicate needs no lifting, so it stays on the hop, where
// `expandFilteredArr` applies it during expansion — correct at any nesting depth and earlier
// than rep completion. An allowlist decides "edge-only", not `freePredicateVars`, which does
// not descend into a subquery and would call `EXISTS { … }` edge-only.
const chain = (): Graph => {
  const g = new Graph();
  const v: Record<string, Vertex> = {};

  for (const id of ['0', '1', '2', '3']) {
    v[id] = g.addVertex({ id, labels: ['N'], properties: { n: Number(id) } });
  }

  // 0 -(w5)-> 1 -(w5)-> 2 -(w1)-> 3. Only the LAST edge fails `w > 2`.
  g.addEdge({ id: 'a', from: v['0'], to: v['1'], labels: ['R'], properties: { w: 5 } });
  g.addEdge({ id: 'b', from: v['1'], to: v['2'], labels: ['R'], properties: { w: 5 } });
  g.addEdge({ id: 'c', from: v['2'], to: v['3'], labels: ['R'], properties: { w: 1 } });

  return g;
};

const count = (g: Graph, q: string): number => {
  const rows = query(g, q) as Array<Record<string, unknown>>;

  return rows[0].c as number;
};

describe('a per-hop WHERE inside a nested sub-unit', () => {
  // Unfiltered `{1,2}`: 1-rep 0->1, 1->2, 2->3 and 2-rep 0->1->2, 1->2->3 = 5.
  // With `w > 2` the 2->3 edge is out: 0->1, 1->2, 0->1->2 = 3.
  test('the flat and nested spellings of one group agree', () => {
    const g = chain();

    expect(count(g, 'MATCH (a:N)((x)-[e:R]->(y)){1,2} RETURN count(*) AS c')).toBe(5);
    expect(count(g, 'MATCH (a:N)((x)-[e:R WHERE e.w > 2]->(y)){1,2} RETURN count(*) AS c')).toBe(3);

    // Nested, inner {1,1} x outer {1,2} — the same question. Returned 5 before the fix: the
    // UNFILTERED answer, which is what a dropped predicate looks like.
    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,1}){1,2} RETURN count(*) AS c')).toBe(5);
    expect(
      count(g, 'MATCH (a:N)(((x)-[e:R WHERE e.w > 2]->(y)){1,1}){1,2} RETURN count(*) AS c'),
    ).toBe(3);

    // And inner {1,2} x outer {1,1}, the same question again.
    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,2}){1,1} RETURN count(*) AS c')).toBe(5);
    expect(
      count(g, 'MATCH (a:N)(((x)-[e:R WHERE e.w > 2]->(y)){1,2}){1,1} RETURN count(*) AS c'),
    ).toBe(3);
  });

  // The ENDPOINTS, because a wrong count can be right by coincidence while the row set is
  // wrong. Node 3 is reachable only across the `w = 1` edge, so its presence is the bug.
  test('the forbidden edge leads nowhere', () => {
    const g = chain();
    const ends = (q: string): unknown => query(g, q);

    expect(
      ends('MATCH (a:N)((x)-[e:R WHERE e.w > 2]->(y)){1,2} (z) RETURN z.n AS n ORDER BY n'),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 2 }]);
    expect(
      ends('MATCH (a:N)(((x)-[e:R WHERE e.w > 2]->(y)){1,1}){1,2} (z) RETURN z.n AS n ORDER BY n'),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 2 }]);
  });

  // The inline-property spelling must answer the same. It never went through the lift at all
  // (props live on the hop already), so this is the control that says the lift is what changed.
  test('the inline property spelling agrees, flat and nested', () => {
    const g = chain();

    expect(count(g, 'MATCH (a:N)((x)-[:R {w: 5}]->(y)){1,2} RETURN count(*) AS c')).toBe(3);
    expect(count(g, 'MATCH (a:N)(((x)-[:R {w: 5}]->(y)){1,1}){1,2} RETURN count(*) AS c')).toBe(3);
  });

  // A CROSS-VARIABLE predicate must still be LIFTED: `e.w > x.n` cannot be evaluated during
  // expansion, because `x` is bound only when the repetition completes. This is the case the
  // lift exists for, and the allowlist is what keeps it lifted — so it is the test that says
  // the fix narrowed the lift rather than removing it.
  test('a predicate reading another variable is still lifted', () => {
    const g = chain();
    // `e.w > x.n`: 0->1 (5 > 0) and 1->2 (5 > 1) pass; 2->3 (1 > 2) fails. So the same three
    // repetitions as `w > 2`, by a predicate that CANNOT be applied per hop.
    expect(count(g, 'MATCH (a:N)((x)-[e:R WHERE e.w > x.n]->(y)){1,2} RETURN count(*) AS c')).toBe(
      3,
    );
    // Flipping it the other way must change the answer, or the predicate is not being read.
    expect(count(g, 'MATCH (a:N)((x)-[e:R WHERE e.w < x.n]->(y)){1,2} RETURN count(*) AS c')).toBe(
      1,
    );
  });

  // A per-hop predicate ANDed with the group's own per-rep WHERE: one stays on the hop, the
  // other is lifted, and both must apply.
  test('an edge-only hop predicate and a per-rep WHERE both apply', () => {
    const g = chain();
    const hopOnly = count(g, 'MATCH (a:N)((x)-[e:R WHERE e.w > 2]->(y)){1,2} RETURN count(*) AS c');
    const repOnly = count(
      g,
      'MATCH (a:N)((x)-[e:R]->(y) WHERE x.n <> 1){1,2} RETURN count(*) AS c',
    );
    const both = count(
      g,
      'MATCH (a:N)((x)-[e:R WHERE e.w > 2]->(y) WHERE x.n <> 1){1,2} RETURN count(*) AS c',
    );

    expect(hopOnly).toBe(3);
    expect(repOnly).toBeLessThan(5);
    expect(both).toBeLessThan(hopOnly);
    expect(both).toBeLessThan(repOnly);
  });
});
