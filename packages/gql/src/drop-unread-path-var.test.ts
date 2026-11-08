import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Clause } from './ast.js';
import { dropUnreadPathVar } from './executor/rewrites.js';
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

  test('⚠️ a clause whose reads are BARE STRINGS refuses — a second MATCH joins on `p`', () => {
    // Item 1569 widened the pass past `[match, return]`, and this is the hazard that decided its
    // shape: a MATCH pattern's `pathVar` / `node.variable` / `rel.variable` are bare strings, so a
    // second MATCH naming `p` READS it with no `var` node anywhere for an expression walk to find.
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->(b:P) MATCH p = (c:P)-[:E]->(d:P) RETURN count(*) AS c'),
    ).toBe('p');
  });

  test('SET and REMOVE refuse — `SetItem`/`RemoveItem` name the variable as a string', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) SET a.k = 1 RETURN count(*) AS c')).toBe('p');
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) REMOVE a.k RETURN count(*) AS c')).toBe('p');
  });

  test('an inline CALL refuses — its `scope` is a string[] of outer names', () => {
    expect(
      pathVarOf(
        'MATCH p = (a:P)-[:E]->(b:P) CALL (a) { MATCH (a)-[:E]->(z) RETURN 1 AS u } RETURN count(*) AS c',
      ),
    ).toBe('p');
  });

  test('a tail clause REBINDING the name refuses', () => {
    // `LET p = 1` shadows the pattern's binding, which probably makes dropping it safe — but the
    // pass refuses rather than reason about shadowing.
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) LET p = 1 RETURN count(*) AS c')).toBe('p');
  });

  test('WITH * refuses, like RETURN *', () => {
    expect(pathVarOf('MATCH p = (a:P)-[:E]->(b:P) WITH * RETURN count(*) AS c')).toBe('p');
  });

  test('`p` read in a LET expression refuses', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) LET n = size(nodes(p)) RETURN count(*) AS c'),
    ).toBe('p');
  });
});

describe('item 1569: the tail may be any allowlisted clauses, not just RETURN', () => {
  // The `[match, return]` restriction cost 83x on the measured shape: one `LET` between the two
  // re-exposed the whole var-length cost (869.6 ms against 10.5).
  test('a LET in between no longer blocks the drop', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) LET w = 1 RETURN count(*) AS c'),
    ).toBeUndefined();
  });

  test('FILTER in between', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) FILTER a.n > 0 RETURN count(*) AS c'),
    ).toBeUndefined();
  });

  test('WITH in between', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) WITH a.n AS x RETURN count(*) AS c'),
    ).toBeUndefined();
  });

  test('ORDER BY as a statement in between', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) ORDER BY a.n LIMIT 10 RETURN count(*) AS c'),
    ).toBeUndefined();
  });

  // ⚠️ ONE TEST PER READER POSITION `tailReads` COLLECTS. Each of these kills a mutant that forgets
  // that one slot, and nothing else in the suite reaches them — a forgotten slot is a WRONG ANSWER
  // (the binding is dropped while something still reads it), not a lost optimization.
  test('`p` read in a FILTER refuses', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) FILTER size(nodes(p)) > 2 RETURN count(*) AS c'),
    ).toBe('p');
  });

  test('`p` PROJECTED through a WITH and then filtered refuses', () => {
    // ⚠️ THIS TEST WAS FIRST WRITTEN TO COVER `with.where` AND DOES NOT. It reads `pp`, the
    // projected alias, so what refuses is the projection ITEM (`p AS pp`) — the `WHERE` never sees
    // the pre-WITH `p` at all. Kept under an honest name because the shape is still worth pinning.
    expect(
      pathVarOf(
        'MATCH p = (a:P)-[:E]->{1,2}(b:P) WITH a.n AS x, p AS pp WHERE size(nodes(pp)) > 2 RETURN count(*) AS c',
      ),
    ).toBe('p');
  });

  test('⚠️ WITH NARROWS SCOPE, which is why a `with.where` mutant survives', () => {
    // `tailReads` collects `with.where`, and removing that collection survives the whole suite.
    // The reason is not a coverage gap: a `WITH`'s `WHERE` is evaluated AFTER the projection, so it
    // can only name projected aliases — referencing a pre-WITH variable RAISES. Any `WHERE` that
    // does reach `p` therefore required `p` to be projected first, which the item check catches.
    //
    // This pins that scope rule, so the collection becomes load-bearing — rather than silently
    // redundant — if the engine ever stopped narrowing.
    const graph = g();

    expect(() =>
      query(
        graph,
        'MATCH p = (a:P)-[:E]->(b:P) WITH a.n AS x WHERE size(nodes(p)) > 1 RETURN count(*) AS c',
      ),
    ).toThrow('variable `p` is not defined');

    // And the same for an ordinary variable, so the rule is about WITH and not about paths.
    expect(() =>
      query(graph, 'MATCH (a:P)-[:E]->(b:P) WITH 1 AS x WHERE a.n > -1 RETURN count(*) AS c'),
    ).toThrow('variable `a` is not defined');
  });

  test('`p` read in a WITH projection item refuses', () => {
    expect(
      pathVarOf('MATCH p = (a:P)-[:E]->{1,2}(b:P) WITH size(nodes(p)) AS n RETURN count(*) AS c'),
    ).toBe('p');
  });

  test('`p` read in a statement ORDER BY refuses', () => {
    expect(
      pathVarOf(
        'MATCH p = (a:P)-[:E]->{1,2}(b:P) ORDER BY size(nodes(p)) LIMIT 5 RETURN count(*) AS c',
      ),
    ).toBe('p');
  });

  test('the answer is unchanged with a LET in the tail', () => {
    expect(query(g(), 'MATCH p = (a:P)-[:E]->{1,2}(b:P) LET w = 1 RETURN count(*) AS c')).toEqual([
      { c: 3 },
    ]);
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
