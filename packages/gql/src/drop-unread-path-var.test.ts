import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Clause } from './ast.js';
import { dropUnreadPathVar } from './executor.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * Item 1567: `MATCH p = … RETURN <no mention of p>` drops the path variable. **72.6x** on
 * `MATCH p = (a:P)-[:E]->{1,2}(b:P) RETURN count(*)` — 878.0 ms to 12.1, converging with the
 * spelling that never bound `p`.
 *
 * ⚠️ THE COST IS NOT THE `Path` OBJECTS. Five gates refuse outright on `pathVar !== undefined`,
 * `orient` among them, so binding a path variable nobody reads falls off the entire fast-path
 * ladder onto the general matcher.
 *
 * ⚠️ AND THE REWRITE IS ANSWER-EQUIVALENT, so the 3,923-test suite cannot see a mutant in it —
 * `perf-gate-needs-its-own-test`. Hence two kinds of test here: the TRANSFORMATION directly (does
 * the `pathVar` survive?), and ANSWERS for each refusal, where `p` being read makes the difference
 * observable.
 */
const clausesOf = (q: string): readonly Clause[] => {
  const stmt = parse(q);
  const [part] = (stmt as unknown as { parts: { clauses?: readonly Clause[] }[] }).parts;
  const clauses = part?.clauses;

  if (clauses === undefined) {
    throw new Error(`no clause list parsed from: ${q}`);
  }

  return clauses;
};

/** The path variable left on the (single) pattern of the first clause, if any. */
const pathVarOf = (q: string): string | undefined => {
  const [m] = dropUnreadPathVar(clausesOf(q));
  const { patterns } = m as unknown as { patterns?: { pathVar?: string }[] };

  return patterns?.[0]?.pathVar;
};

const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 0 } });
  const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });
  const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { n: 2 } });

  graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
  graph.addEdge({ id: 'e2', from: b, to: c, labels: ['E'] });

  return graph;
};

describe('the path variable is dropped when nothing reads it', () => {
  test('a count projection does not read it', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c')).toBeUndefined();
  });

  test('a projection of other variables does not read it', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) RETURN a.n AS x, b.n AS y')).toBeUndefined();
  });

  test('ANY SHORTEST too', () => {
    expect(
      pathVarOf('MATCH p = ANY SHORTEST (a:P)-[:E]->+(b:P) WHERE a.n = 0 RETURN count(*) AS c'),
    ).toBeUndefined();
  });

  test('the answer is unchanged by the drop', () => {
    // Two one-hop paths plus one two-hop path.
    expect(query(g(), 'MATCH p = (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(query(g(), 'MATCH (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });
});

describe('⚠️ the refusals, each of which a mutant removes', () => {
  test('the projection READS it', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) RETURN p AS pp')).toBe('p');
  });

  test('a function over it reads it', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) RETURN count(nodes(p)) AS c')).toBe('p');
  });

  test('the clause WHERE reads it', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) WHERE size(nodes(p)) > 2 RETURN count(*) AS c'),
    ).toBe('p');
  });

  test('ORDER BY reads it', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) RETURN a.n AS x ORDER BY size(nodes(p))')).toBe(
      'p',
    );
  });

  test('⚠️ RETURN * binds EVERY variable in scope, `p` included', () => {
    // `Projection.star` is the guard no other test covers: a star projection must keep the path
    // variable, because dropping it would remove a column from the result.
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) RETURN *')).toBe('p');
  });

  test('a SUBQUERY anywhere downstream refuses — it can reference an outer variable', () => {
    // `freePredicateVars` does not see inside a subquery, so the rewrite cannot prove `p` unread.
    expect(
      pathVarOf(
        'MATCH p = (a:P)-[:E]->(b:P) RETURN count(*) AS c, COUNT { MATCH (a)-[:E]->(z) } AS q',
      ),
    ).toBe('p');
  });

  test('more than two clauses refuses — deliberately narrow', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) LET w = 1 RETURN count(*) AS c')).toBe('p');
  });
});

describe('answers for the shapes that keep the path variable', () => {
  test('RETURN * still carries a path column', () => {
    const rows = query(g(), 'MATCH p = (a:P)-[:E]->(b:P) RETURN *');

    expect(rows.length).toBe(2);
    // The star projection binds `p`, so the column must be there — this is what the `star` guard
    // protects, and it is answer-observable rather than a route assertion.
    expect(Object.keys(rows[0] ?? {})).toContain('p');
  });

  test('reading the path still works and gives the right lengths', () => {
    const rows = query(
      g(),
      'MATCH p = (a:P)-[:E]->{1,2}(b:P) RETURN size(nodes(p)) AS len ORDER BY len',
    );

    // Two 1-hop paths (2 nodes) and one 2-hop path (3 nodes).
    expect(rows.map((r) => r.len)).toEqual([2, 2, 3]);
  });
});
