import { describe, expect, test } from 'bun:test';

/**
 * An UNREAD edge variable on an OPTIONAL hop — item 1850.
 *
 * `optionalHopShape` refused `rel.variable !== undefined` outright, so naming an edge that nothing
 * reads dropped the rung: **57.6 ms against 6.1 for IDENTICAL rows** (80,000 either way), 9.4x for
 * a binding with no observable effect. The gate now asks whether the RETURN actually reads the
 * name.
 *
 * ⚠️ THE WHOLE RISK IS "UNREAD" BEING WRONG. The walk does not bind the edge at all, so if a query
 * reads the variable and the rung takes it anyway, the read sees nothing — a wrong ANSWER. So the
 * tests below are mostly about the READING spellings, not the unread one: every place an
 * expression can hide in a projection gets its own case.
 *
 * ⚠️ WHY THE CHECK IS LOCAL AND NOT `dropUnreadEdgeVar`. Widening that rewrite to unquantified
 * rels was built and REVERTED: it drops the variable from the AST, which broke the "name a rel
 * variable to force the general matcher" device six other test files use as their ORACLE — 17
 * failures, and the ones that still passed would have been comparing the rung against itself.
 * A local gate changes one rung's admission and nothing else's.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 10; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 3 } });
  }

  // Half the vertices get an out-edge, so the NULL-filled OPTIONAL rows exist too.
  for (let i = 0; i < 10; i += 2) {
    const from = g.getVertexById(`v${i}`);
    const to = g.getVertexById(`v${(i + 3) % 10}`);

    if (from === null || to === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id: `e${i}`, from, to, labels: ['E'], properties: { w: i } });
  }

  return g;
};

const rows = (g: Graph, text: string): string[] =>
  query(g, text)
    .map((r) =>
      Object.values(r)
        .map((v) => (v === null ? '<null>' : JSON.stringify(v)))
        .join('/'),
    )
    .sort();

describe('an UNREAD edge variable on an OPTIONAL hop', () => {
  test('takes the rung and answers exactly what the unnamed spelling answers', () => {
    const g = build();
    const pairs: [string, string][] = [
      [
        'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, b.k AS y',
        'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
      ],
      [
        'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y',
        'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y',
      ],
      [
        'MATCH (a:T) OPTIONAL MATCH (a)<-[e:E]-(b:T) RETURN a.k AS x, b.k AS y',
        'MATCH (a:T) OPTIONAL MATCH (a)<-[:E]-(b:T) RETURN a.k AS x, b.k AS y',
      ],
    ];

    for (const [named, bare] of pairs) {
      expect(routes(named)).toEqual(routes(bare));
      expect(routes(named).length).toBeGreaterThan(0);
      expect(rows(g, named)).toEqual(rows(g, bare));
    }
  });
});

describe('a READ edge variable still declines, and answers correctly', () => {
  /**
   * ⚠️ EVERY PLACE AN EXPRESSION CAN HIDE IN A PROJECTION, because missing one is a wrong answer
   * rather than a slow query: the walk never binds `e`, so a rung that took these would read a
   * name that is not there.
   */
  const READING = [
    // The obvious one: a projected item.
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, e.w AS y',
    // Read ONLY in the sort — invisible in the item list.
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY e.w',
    // Read inside a function call rather than as a bare property.
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, coalesce(e.w, 0) AS y',
    // The ELEMENT itself, not a property of it.
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, e AS y',
  ];

  test('none of them takes the rung', () => {
    for (const text of READING) {
      expect(routes(text)).not.toContain('optionalHopProjection');
      expect(routes(text)).not.toContain('optionalOrderedProjection');
    }
  });

  /**
   * ⚠️ AND THE ANSWER IS CHECKED, not only the refusal — a test that asserted "does not take the
   * rung" would pass just as well if the rung had been deleted. The oracle is the general path,
   * which is where these already run.
   */
  test('and each still returns the edge property it asked for', () => {
    const g = build();
    const got = rows(g, 'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, e.w AS y');

    expect(got.length).toBe(10);
    // Five starts have an edge, five do not — so five rows carry a `w` and five carry a null.
    expect(got.filter((r) => r.endsWith('<null>')).length).toBe(5);
    expect(got.filter((r) => !r.endsWith('<null>')).length).toBe(5);
  });

  /** `RETURN *` binds every name in scope, the edge variable included. */
  test('a star projection does not take the rung', () => {
    expect(routes('MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN *')).not.toContain(
      'optionalHopProjection',
    );
  });

  /**
   * ⚠️ A SUBQUERY REFUSES CONSERVATIVELY, because `freePredicateVars` does not see inside one — the
   * same guard `nameIsUnread` makes in `rewrites.ts`. The name need not even appear for the
   * refusal to apply.
   */
  test('a subquery in the projection does not take the rung', () => {
    expect(
      routes(
        'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.k AS x, EXISTS { MATCH (z:T) } AS y',
      ),
    ).not.toContain('optionalHopProjection');
  });
});
