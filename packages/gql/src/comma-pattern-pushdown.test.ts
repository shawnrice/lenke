// Item 285. `pushWhereIntoNode` declined on `clause.patterns.length !== 1`, so the COMMA
// spelling of a multi-pattern question kept its `WHERE` as a clause filter while the
// `MATCH … MATCH …` spelling pushed it into the node — 15.6x apart on the same four rows.
//
// Every test here compares TWO SPELLINGS of one question, because that is the shape the bug
// class has in this repo: both spellings returned the correct answer, so only a comparison
// detects it. The tests that matter most are the ones where a push would be WRONG — a
// conjunct reading two of the clause's own patterns cannot be attributed to either, since
// `visitRemaining` chooses the intra-clause visit order at runtime and the other variable may
// still be unbound. Those assert the ANSWER, which a bad push changes.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** Two disjoint sets so a comma clause is a genuine product: A(k=1,2) and B(k=2,3). */
const g = (): Graph => {
  const graph = new Graph();

  for (const k of [1, 2]) {
    graph.addVertex({ labels: ['A'], properties: { k, n: `a${k}` } });
  }

  for (const k of [2, 3]) {
    graph.addVertex({ labels: ['B'], properties: { k, n: `b${k}` } });
  }

  return graph;
};

const rows = (q: string): string[] => [...query(g(), q)].map((r) => JSON.stringify(r)).sort();

/** The claim this item rests on: the two spellings of one question agree. */
const sameAnswer = (comma: string, matchMatch: string): void => {
  expect(rows(comma)).toEqual(rows(matchMatch));
};

describe('a one-sided conjunct is attributed to its pattern', () => {
  test('the comma spelling answers what the MATCH MATCH spelling answers', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE b.k = 2 RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE b.k = 2 RETURN a.n AS x, b.n AS y',
    );
  });

  test('and the rows are the ones the product actually has', () => {
    expect(rows('MATCH (a:A), (b:B) WHERE b.k = 2 RETURN a.n AS x, b.n AS y')).toEqual(
      [
        { x: 'a1', y: 'b2' },
        { x: 'a2', y: 'b2' },
      ]
        .map((r) => JSON.stringify(r))
        .sort(),
    );
  });

  test('an ordering comparison, not just an equality', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE b.k > 2 RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE b.k > 2 RETURN a.n AS x, b.n AS y',
    );
  });

  test('one conjunct per pattern, both pushed', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE a.k = 2 AND b.k = 3 RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE a.k = 2 AND b.k = 3 RETURN a.n AS x, b.n AS y',
    );
  });

  test('three patterns, a conjunct on the first and the last', () => {
    sameAnswer(
      'MATCH (a:A), (b:B), (c:A) WHERE a.k = 1 AND c.k = 2 RETURN a.n AS x, b.n AS y, c.n AS z',
      'MATCH (a:A) MATCH (b:B) MATCH (c:A) WHERE a.k = 1 AND c.k = 2 RETURN a.n AS x, b.n AS y, c.n AS z',
    );
  });
});

describe('a CORRELATED conjunct stays a clause filter', () => {
  // THE CORRECTNESS CASE. `b.k = a.k` reads two of the clause's own patterns. Pushed onto
  // either one, the other's variable is unbound whenever `visitRemaining` visits that pattern
  // first — the comparison is then UNKNOWN and the row disappears. Both rows below would be
  // lost, so the answer is the guard.
  test('a correlated equality keeps all its rows', () => {
    expect(rows('MATCH (a:A), (b:B) WHERE b.k = a.k RETURN a.n AS x, b.n AS y')).toEqual(
      [{ x: 'a2', y: 'b2' }].map((r) => JSON.stringify(r)).sort(),
    );
  });

  test('and agrees with the MATCH MATCH spelling', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE b.k = a.k RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE b.k = a.k RETURN a.n AS x, b.n AS y',
    );
  });

  test('a correlated ordering comparison keeps all its rows', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE b.k > a.k RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE b.k > a.k RETURN a.n AS x, b.n AS y',
    );
  });

  test('MIXED: the one-sided conjunct is pushed and the correlated one is not', () => {
    // If the push were applied to both, `b.k = a.k` would vanish and the answer would gain
    // the (a1, b3) row; if neither were pushed the answer would be the same but slow. So this
    // asserts the answer AND is the shape the optimization actually has to get right.
    expect(
      rows('MATCH (a:A), (b:B) WHERE b.k > 1 AND b.k = a.k RETURN a.n AS x, b.n AS y'),
    ).toEqual([{ x: 'a2', y: 'b2' }].map((r) => JSON.stringify(r)).sort());
  });
});

describe('what a pattern must be to receive a conjunct', () => {
  /** `p` has a string `st`, so `CAST(p.st AS INTEGER)` RAISES on it. */
  const hop = (): Graph => {
    const graph = new Graph();
    const p = graph.addVertex({ labels: ['P'], properties: { st: 'nope', n: 'p' } });
    const q = graph.addVertex({ labels: ['P'], properties: { st: '7', n: 'q' } });

    graph.addVertex({ labels: ['A'], properties: { n: 'a' } });
    graph.addEdge({ from: q, to: p, labels: ['E'], properties: {} });

    return graph;
  };

  // A HOP pattern is the `liftHopWhereToSeedFilter` case: a clause `WHERE` is evaluated once
  // per ROW and a node predicate once per VERTEX, so moving one onto a hop's start changes
  // WHICH QUERIES RAISE. `p` has no out-edge, so no row reaches the comparison and the clause
  // form answers without faulting; an inline predicate on the start would raise on it.
  test('a conjunct on a HOP pattern is not pushed, so the query still does not raise', () => {
    expect([
      ...query(
        hop(),
        'MATCH (a:A), (p:P)-[:E]->(r) WHERE CAST(p.st AS INTEGER) >= 1 RETURN r.n AS n',
      ),
    ]).toEqual([{ n: 'p' }]);
  });

  test('a conjunct on a bare node pattern IS pushed, and raises exactly as before', () => {
    // The single-pattern path already raises here; the comma spelling must agree rather than
    // acquiring a fault the other spelling does not have.
    const bad = 'MATCH (a:A), (p:P) WHERE CAST(p.st AS INTEGER) >= 1 RETURN p.n AS n';
    const twin = 'MATCH (a:A) MATCH (p:P) WHERE CAST(p.st AS INTEGER) >= 1 RETURN p.n AS n';

    let commaThrew = false;
    let twinThrew = false;

    try {
      query(hop(), bad);
    } catch {
      commaThrew = true;
    }

    try {
      query(hop(), twin);
    } catch {
      twinThrew = true;
    }

    expect(commaThrew).toBe(twinThrew);
  });

  test('a conjunct on a PATH-VARIABLE pattern is not pushed', () => {
    sameAnswer(
      'MATCH (a:A), p = (b:B) WHERE b.k = 2 RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH p = (b:B) WHERE b.k = 2 RETURN a.n AS x, b.n AS y',
    );
  });

  test('an existing inline predicate on the start is kept, not replaced', () => {
    // The merge is with `start.where`, and an inline `{k: 2}` does NOT land there — it lands
    // in `props`. So this spells the existing predicate as an inline `WHERE`, which is the
    // only spelling that populates the field the merge reads. (Written with `{k: 2}` first,
    // where mutation M6 — replace rather than conjoin — SURVIVED, because `start.where` was
    // undefined and the branch was never taken.)
    expect(
      rows('MATCH (a:A), (b:B WHERE b.k = 2) WHERE b.n = "b2" RETURN a.n AS x, b.n AS y'),
    ).toEqual(
      [
        { x: 'a1', y: 'b2' },
        { x: 'a2', y: 'b2' },
      ]
        .map((r) => JSON.stringify(r))
        .sort(),
    );
  });

  test('an existing inline predicate that the pushed one CONTRADICTS keeps both', () => {
    // The direction M6 breaks: replacing `start.where` with the pushed conjunct would answer
    // the b3 rows, because `b.k = 2` would be gone.
    expect(
      rows('MATCH (a:A), (b:B WHERE b.k = 2) WHERE b.n = "b3" RETURN a.n AS x, b.n AS y'),
    ).toEqual([]);
  });

  test('an inline PROPS predicate beside a pushed one keeps both', () => {
    expect(
      rows('MATCH (a:A {k: 1}), (b:B {k: 2}) WHERE b.n = "b2" RETURN a.n AS x, b.n AS y'),
    ).toEqual([{ x: 'a1', y: 'b2' }].map((r) => JSON.stringify(r)).sort());
  });

  test('a conjunct reading NO pattern variable stays a clause filter', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE 1 = 2 RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE 1 = 2 RETURN a.n AS x, b.n AS y',
    );
  });

  test('a conjunct containing a SUBQUERY stays a clause filter', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE EXISTS { MATCH (x:A) WHERE x.k = b.k } RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE EXISTS { MATCH (x:A) WHERE x.k = b.k } RETURN a.n AS x, b.n AS y',
    );
  });

  test('an OPTIONAL multi-pattern clause is untouched', () => {
    // No spelling twin exists for this one: splitting it into two `OPTIONAL MATCH` clauses is
    // a DIFFERENT query (the joint `WHERE` then applies to the second clause alone, and the
    // first clause's unmatched rows survive with nulls). So the rows are asserted directly —
    // `pushWhereIntoNode` declines on `clause.optional` before reaching this item's code, and
    // what that guard protects is the null-extension, not a filter position.
    expect(
      rows(
        'MATCH (a:A) OPTIONAL MATCH (b:B), (c:B) WHERE b.k = 2 RETURN a.n AS x, b.n AS y, c.n AS z',
      ),
    ).toEqual(
      [
        { x: 'a1', y: 'b2', z: 'b2' },
        { x: 'a1', y: 'b2', z: 'b3' },
        { x: 'a2', y: 'b2', z: 'b2' },
        { x: 'a2', y: 'b2', z: 'b3' },
      ]
        .map((r) => JSON.stringify(r))
        .sort(),
    );
  });

  test('an OR of two patterns is not split, and keeps its rows', () => {
    sameAnswer(
      'MATCH (a:A), (b:B) WHERE a.k = 1 OR b.k = 3 RETURN a.n AS x, b.n AS y',
      'MATCH (a:A) MATCH (b:B) WHERE a.k = 1 OR b.k = 3 RETURN a.n AS x, b.n AS y',
    );
  });

  test('an OUTER variable alongside one own variable is still pushed', () => {
    // `a` is bound by the PREVIOUS clause, so it is in the incoming binding whatever order
    // this clause's patterns are visited in — the reason the single-pattern path has never
    // restricted free variables.
    sameAnswer(
      'MATCH (a:A) MATCH (b:B), (c:B) WHERE b.k = a.k RETURN a.n AS x, b.n AS y, c.n AS z',
      'MATCH (a:A) MATCH (b:B) MATCH (c:B) WHERE b.k = a.k RETURN a.n AS x, b.n AS y, c.n AS z',
    );
  });
});
