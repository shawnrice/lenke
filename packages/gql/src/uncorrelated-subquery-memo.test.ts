// An UNCORRELATED subquery has the same answer for every outer row, and the TS engine re-ran it
// for each one: `COUNT { MATCH (:Person)-[:KNOWS]->(b) }` cost 4,102.8ms at 2,000 vertices and
// 18,620.2 at 4,000 — quadratic, because the body walks a fixture that grows with the row count
// — and did not finish in nine minutes at 200,000 (audit items 502, 503).
//
// It is now evaluated once per plan invocation. Every test here is about WHEN that is allowed:
// the memo is keyed on the execution epoch, and a correlated body or a writing query must not
// take it. The perf claim lives in the audit; these are the answers.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3 } });

  g.addVertex({ id: 'q1', labels: ['Q'], properties: { n: 10 } });
  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: b, to: c, labels: ['T'], properties: {} });

  return g;
};

describe('an uncorrelated subquery is evaluated once a run (item 503)', () => {
  test('every row gets the same, correct answer', () => {
    const g = build();

    expect(query(g, 'MATCH (u:P) RETURN u.n AS n, COUNT { MATCH (x:P) } AS c ORDER BY n')).toEqual([
      { n: 1, c: 3 },
      { n: 2, c: 3 },
      { n: 3, c: 3 },
    ]);
    // The other two subquery forms take the same wrapper.
    expect(query(g, 'MATCH (u:P) WHERE EXISTS { MATCH (z:Q) } RETURN u.n AS n ORDER BY n')).toEqual(
      [{ n: 1 }, { n: 2 }, { n: 3 }],
    );
    expect(query(g, 'MATCH (u:P) WHERE EXISTS { MATCH (z:NOPE) } RETURN u.n AS n')).toEqual([]);
    expect(
      query(g, 'MATCH (u:P) RETURN u.n AS n, VALUE { MATCH (z:Q) RETURN z.n } AS v ORDER BY n'),
    ).toEqual([
      { n: 1, v: 10 },
      { n: 2, v: 10 },
      { n: 3, v: 10 },
    ]);
  });

  test('a CORRELATED body is still per row — the anchor is a pattern variable, not a free one', () => {
    const g = build();

    // This is the shape that broke 90 tests when the admission test was `freePredicateVars`
    // alone: `u` is bound OUTSIDE, but inside the subquery it reads as one of the body's own
    // pattern variables, so an "no free variables" test calls this uncorrelated. It is not.
    expect(
      query(g, 'MATCH (u:P) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x) } AS c ORDER BY n'),
    ).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
    // Correlation through a sub-WHERE rather than through the pattern.
    expect(
      query(
        g,
        'MATCH (u:P) RETURN u.n AS n, COUNT { MATCH (x:P) WHERE x.n = u.n } AS c ORDER BY n',
      ),
    ).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 1 },
      { n: 3, c: 1 },
    ]);
  });

  test('a WRITING query sees the write, and memoizing is switched off for it either way', () => {
    const g = build();

    // Three `P` rows, each inserting an `X`. Clauses run one at a time, so all three INSERTs
    // land BEFORE the projection is evaluated and every row reads 3 — which is what the engine
    // answered before this change too, verified against the pristine build.
    //
    // So this does NOT distinguish the write guard, and nothing available does: within one run
    // the graph is already stable by the time the subquery is evaluated. The guard
    // (`memoUncorrelated = !queryHasWrite(query)`) is kept as defensive, its mutant survives,
    // and that is recorded rather than implied by a test name.
    const rows = query<{ c: number }>(
      g,
      'MATCH (u:P) INSERT (:X) RETURN COUNT { MATCH (x:X) } AS c',
    );

    expect(rows.map((r) => r.c)).toEqual([3, 3, 3]);
  });

  test('a second run of the SAME cached plan sees a MUTATED graph', () => {
    const g = build();
    const q = 'MATCH (u:P) WHERE u.n = 1 RETURN COUNT { MATCH (x:P) } AS c';

    expect(query(g, q)).toEqual([{ c: 3 }]);
    g.addVertex({ id: 'd', labels: ['P'], properties: { n: 4 } });
    // `execute` caches the compiled plan by statement, so the memo lives in a closure that
    // SURVIVES this call. Keyed on the execution epoch, which is bumped per invocation, it must
    // not be served again here.
    expect(query(g, q)).toEqual([{ c: 4 }]);
    g.addVertex({ id: 'e', labels: ['P'], properties: { n: 5 } });
    expect(query(g, q)).toEqual([{ c: 5 }]);
  });

  test('a $param body is memoized, and the memo does not cross a param change', () => {
    const g = build();
    const q = 'MATCH (u:P) WHERE u.n = 1 RETURN COUNT { MATCH (x:P) WHERE x.n > $lo } AS c';

    // A param is not a variable, so the body is uncorrelated and memoizable — but params are
    // per RUN, so a different binding must produce a different answer.
    expect(query(g, q, { lo: 0 })).toEqual([{ c: 3 }]);
    expect(query(g, q, { lo: 2 })).toEqual([{ c: 1 }]);
    expect(query(g, q, { lo: 99 })).toEqual([{ c: 0 }]);
  });

  test('an uncorrelated body inside a correlated one still answers per row', () => {
    const g = build();

    // The OUTER count is correlated (`u`), the inner one is not. Nesting must not let the outer
    // take the memo.
    expect(
      query(
        g,
        'MATCH (u:P) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x) } + COUNT { MATCH (z:Q) } AS c ORDER BY n',
      ),
    ).toEqual([
      { n: 1, c: 2 },
      { n: 2, c: 2 },
      { n: 3, c: 1 },
    ]);
  });
});
