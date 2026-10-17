// FOUR clause-list rewrites now run on every query, in a fixed order:
//
//   1. `inlineTrailingLet`      — a trailing `LET`/`WITH` renaming folded into the RETURN (512, 516)
//   2. `inlineCorrelatedCall`   — a correlated `CALL (v) { MATCH … RETURN … }` to its MATCH (513)
//   3. `fuseAnchorThenHop`      — two MATCH clauses sharing a variable into one pattern (505, 507)
//
// Each was tested alone. Their COMPOSITION is a surface of its own: a rewrite can expose a shape
// the next one accepts, so the order is load-bearing and the combinations are what no single
// item covered. Every case here is asked twice — composed, and written directly — and the two
// must agree as a multiset.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: { w: 7 } });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: { w: 8 } });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['S'], properties: { w: 9 } });

  return g;
};

const g = build();
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();

describe('the clause rewrites compose (item 517)', () => {
  const same = (composed: string, direct: string) => {
    expect(bag(composed)).toEqual(bag(direct));
    expect(bag(composed).length).toBeGreaterThan(0);
  };

  test('FUSION then LET: two MATCH clauses, then a renaming', () => {
    same(
      'MATCH (a:P) MATCH (a)-[:T]->(x) LET k = x.k RETURN k',
      'MATCH (a:P)-[:T]->(x) RETURN x.k AS k',
    );
    same(
      'MATCH (a:P) MATCH (a)-[:T]->(x) WITH x.k AS k RETURN k',
      'MATCH (a:P)-[:T]->(x) RETURN x.k AS k',
    );
  });

  test('CALL then FUSION: the rewritten MATCH is fused into the one before it', () => {
    same(
      'MATCH (a:P) CALL (a) { MATCH (a)-[:T]->(x) RETURN x } RETURN a.k AS a, x.k AS x',
      'MATCH (a:P)-[:T]->(x) RETURN a.k AS a, x.k AS x',
    );
    // And the count, which only the fused form can shortcut.
    same(
      'MATCH (a:P) CALL (a) { MATCH (a)-[:T]->(x) RETURN x } RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->(x) RETURN count(*) AS c',
    );
  });

  test('CALL then FUSION then LET: all three in one query', () => {
    same(
      'MATCH (a:P) CALL (a) { MATCH (a)-[:T]->(x) RETURN x } LET k = x.k RETURN k',
      'MATCH (a:P)-[:T]->(x) RETURN x.k AS k',
    );
    same(
      'MATCH (a:P) CALL (a) { MATCH (a)-[:T]->(x) RETURN x } WITH x.k AS k RETURN k',
      'MATCH (a:P)-[:T]->(x) RETURN x.k AS k',
    );
  });

  test('a CALL whose body is itself two clauses fuses inside the body first', () => {
    same(
      'MATCH (a:P) CALL (a) { MATCH (a)-[:T]->(x)-[:S]->(y) RETURN x, y } RETURN y.k AS y',
      'MATCH (a:P)-[:T]->(x)-[:S]->(y) RETURN y.k AS y',
    );
  });

  test('THREE MATCH clauses then a WITH', () => {
    same(
      'MATCH (a:P) MATCH (a)-[:T]->(x) MATCH (x)-[:S]->(y) WITH y.k AS k RETURN k',
      'MATCH (a:P)-[:T]->(x)-[:S]->(y) RETURN y.k AS k',
    );
  });

  test('a rewrite must not expose a shape the SELF-JOIN gate should refuse', () => {
    // Item 506: a repeated node variable is answered by the general matcher, and fusion is what
    // can produce one — `MATCH (a:P) MATCH (a)-[:T]->(a)` fuses into `(a:P)-[:T]->(a)`, which
    // every hop rung answers WRONGLY. The gate runs on the REWRITTEN list, so it still catches
    // it: one self-loop here is zero, and the two spellings agree.
    expect(bag('MATCH (a:P) MATCH (a)-[:T]->(a) RETURN count(*) AS c')).toEqual(
      bag('MATCH (a:P)-[:T]->(a) RETURN count(*) AS c'),
    );
    expect(bag('MATCH (a:P) MATCH (a)-[:T]->(a) RETURN count(*) AS c')).toEqual([
      JSON.stringify({ c: 0 }),
    ]);
  });

  test('OPTIONAL after a fusion keeps its rung and its null-fill', () => {
    // Items 510/511's rungs read a THREE-clause shape whose middle is optional. A fusion before
    // it must leave that shape intact.
    same(
      'MATCH (a:P) MATCH (a)-[:T]->(x) OPTIONAL MATCH (x)-[:S]->(y) RETURN x.k AS x, y.k AS y',
      'MATCH (a:P)-[:T]->(x) OPTIONAL MATCH (x)-[:S]->(y) RETURN x.k AS x, y.k AS y',
    );
  });

  test('a constant FOR after a fusion still multiplies the count', () => {
    same(
      'MATCH (a:P) MATCH (a)-[:T]->(x) FOR i IN [1, 2] RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->(x) FOR i IN [1, 2] RETURN count(*) AS c',
    );
    expect(bag('MATCH (a:P) MATCH (a)-[:T]->(x) FOR i IN [1, 2] RETURN count(*) AS c')).toEqual([
      JSON.stringify({ c: 4 }),
    ]);
  });

  test('a rel variable read after a fusion is still bound', () => {
    same(
      'MATCH (a:P) MATCH (a)-[r:T]->(x) LET w = r.w RETURN w',
      'MATCH (a:P)-[r:T]->(x) RETURN r.w AS w',
    );
  });
});
