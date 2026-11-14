import { describe, expect, test } from 'bun:test';

/**
 * `reachShortcut` must REFUSE a multi-element repetition unit — item 1873, a WRONG ANSWER fix.
 *
 * ⚠️⚠️ **THE SHAPE OF THE BUG.** `((x)-[:KNOWS]->(m)-[:LIKES]->(y)){1,2}(t)` parses as a SINGLE
 * segment whose hops beyond the first live in `unitRest`, so `detectReachableShortcut`'s
 * `segments.length !== 1` check passed it through — and the walk reads only `rel`/`node`, i.e. the
 * unit's FIRST hop. It then ran a one-hop BFS over `:KNOWS` where each repetition is really
 * `:KNOWS` THEN `:LIKES`, and returned the wrong rows:
 *
 *     MATCH ((x)-[:KNOWS]->(m)-[:LIKES]->(y)){1,2}(t) RETURN DISTINCT t.n
 *       before   1 row   [{"n":4}]
 *       native   3 rows  [{"n":1},{"n":2},{"n":4}]
 *
 * ⚠️ **IT WAS FOUND BY A TEST THAT WAS NOT IN MY GATE LOOP.** `packages/native`'s own suite holds
 * the cross-engine matrix that catches this (`pattern-family-matrix.test.ts`), and the per-tick
 * gate was `gql` + `gremlin` + the seven fuzzers — so two red tests sat there while every gate I
 * ran stayed green. The fuzzers did not catch it either: they compare GQL as multisets and this
 * shape's generated forms did not reach the multi-element unit with a DISTINCT endpoint.
 *
 * ⚠️ **AND HALF OF IT PREDATES THE CHANGE THAT EXPOSED IT.** Item 1848 widened
 * `reachQuantifierIsExact` from unbounded-only to bounded, which brought `{1,2}` into the rung and
 * into the matrix test's reach. But the UNBOUNDED spelling was already wrong at `main`: measured
 * there, `…(y))+(t) RETURN DISTINCT t.n` gave `[2,3]` against native's `[4,1]` — different SETS,
 * not merely a different order. So the refusal below fixes a pre-existing wrong answer as well as
 * the new instance of it.
 *
 * ⚠️ **THE SINGLE-ELEMENT GROUP IS STILL ADMITTED**, deliberately: `((x)-[:KNOWS]->(m)){1,2}(t)`
 * has an empty `unitRest` and IS one hop per repetition, which is exactly what the walk
 * implements. Its row below is what keeps the refusal scoped to the units that differ rather than
 * giving back the rung item 1848 measured at 36.56x.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

const takesReach = (src: string): boolean => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return typeof cl.reachShortcut === 'function';
};

/**
 * `n1 -KNOWS-> n2 -KNOWS-> n3`, `n2 -LIKES-> n4`, `n3 -LIKES-> n1`.
 *
 * ⚠️ THE TWO EDGE TYPES ALTERNATE SO A FIRST-HOP-ONLY WALK GIVES A DIFFERENT ANSWER. On a fixture
 * where every edge carried one type, a one-hop BFS over `:KNOWS` and the true `:KNOWS`-then-
 * `:LIKES` unit could coincide, and the bug would be invisible.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const n of [1, 2, 3, 4]) {
    g.addVertex({ id: `n${n}`, labels: ['P'], properties: { n } });
  }

  const edge = (id: string, from: string, to: string, label: string): void => {
    g.addEdge({
      id,
      from: g.getVertexById(from) as never,
      to: g.getVertexById(to) as never,
      labels: [label],
    });
  };

  edge('k1', 'n1', 'n2', 'KNOWS');
  edge('k2', 'n2', 'n3', 'KNOWS');
  edge('l1', 'n2', 'n4', 'LIKES');
  edge('l2', 'n3', 'n1', 'LIKES');

  return g;
};

/** As a SET — GQL row order is unspecified, so only the multiset is the answer. */
const setOf = (g: Graph, text: string): string =>
  JSON.stringify(
    query(g, text)
      .map((r) => String(r.n))
      .sort(),
  );

const MULTI = '((x)-[:KNOWS]->(m)-[:LIKES]->(y))';
const SINGLE = '((x)-[:KNOWS]->(m))';

describe('a multi-element repetition unit does not take the reach rung', () => {
  test('every quantifier spelling of the MULTI-element unit is refused', () => {
    for (const q of ['{1,2}', '{1,3}', '+', '*', '{2}']) {
      expect(takesReach(`MATCH ${MULTI}${q}(t) RETURN DISTINCT t.n AS n`)).toBe(false);
    }
  });

  test('the SINGLE-element unit still takes it — the refusal is scoped', () => {
    for (const q of ['{1,2}', '+', '*']) {
      expect(takesReach(`MATCH ${SINGLE}${q}(t) RETURN DISTINCT t.n AS n`)).toBe(true);
    }

    // And the plain var-length hop, which is the rung's original shape.
    expect(takesReach('MATCH (a:P)-[:KNOWS]->+(t) RETURN DISTINCT t.n AS n')).toBe(true);
  });

  /**
   * ⚠️ THE ANSWERS, which is what the route assertion above cannot tell you. A one-hop BFS over
   * `:KNOWS` reaches n2 and n3 from n1; the real unit `:KNOWS` then `:LIKES` reaches n4 (via n2)
   * and n1 (via n3). The two are disjoint here, so a wrong route cannot coincide.
   */
  test('the MULTI-element unit answers the unit, not its first hop', () => {
    const g = build();

    // One repetition: KNOWS then LIKES. From n1: n1->n2->n4. From n2: n2->n3->n1.
    expect(setOf(g, `MATCH ${MULTI}{1,1}(t) RETURN DISTINCT t.n AS n`)).toBe(
      JSON.stringify(['1', '4']),
    );

    // One or two repetitions adds n1->n2->n4 then nothing further (n4 has no KNOWS out-edge), and
    // n2->n3->n1 then n1->n2->n4 — so the reachable set is the same two endpoints.
    expect(setOf(g, `MATCH ${MULTI}{1,2}(t) RETURN DISTINCT t.n AS n`)).toBe(
      JSON.stringify(['1', '4']),
    );

    // ⚠️ AND IT IS NOT THE FIRST HOP'S ANSWER, stated explicitly: a `:KNOWS`-only walk of one or
    // two steps from every start reaches n2, n3 and n4 — which is what the bug returned a subset
    // of, and what this must never equal.
    expect(setOf(g, `MATCH ${SINGLE}{1,2}(t) RETURN DISTINCT t.n AS n`)).toBe(
      JSON.stringify(['2', '3']),
    );
  });
});
