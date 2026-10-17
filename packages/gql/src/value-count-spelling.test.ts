// `VALUE { MATCH … RETURN count(*) }` and `COUNT { MATCH … }` are two ISO spellings of ONE
// question, so they must cost the same — and in TypeScript they did not: the VALUE spelling
// built a `valueSubquery` node, which materializes the matches per outer row, where the COUNT
// spelling reaches the degree ladder. 525.5ms against 72.1 at 200,000 vertices, the same answer
// both ways (audit item 499). The parser now lowers the VALUE spelling to the same node.
//
// This file pins what the lowering may and may NOT swallow. The perf claim itself lives in
// `packages/native/spelling-probe.ts`, which flagged this group at 7.3x before the change and is
// silent after it.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });
  // `bare` has NO `n` at all, which is how `count(*)` and `count(x.n)` come apart.
  const bare = g.addVertex({ id: 'bare', labels: ['P'], properties: {} });

  g.addVertex({ id: 'lonely', labels: ['P'], properties: { n: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ax', from: a, to: bare, labels: ['T'], properties: {} });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const cs = (q: string): unknown[] => query(g, q);

describe('VALUE { … RETURN count(*) } is COUNT { … } (item 499)', () => {
  test('the two spellings answer identically, one hop and two', () => {
    for (const body of [
      '(u)-[:T]->(x)',
      '(u)-[:T]->(x:Q)',
      '(u)-[:T]->(x)-[:T]->(y)',
      '(u)<-[:T]-(x)',
      '(u)-[:NOPE]->(x)',
    ]) {
      expect(
        cs(`MATCH (u:P) RETURN u.n AS n, VALUE { MATCH ${body} RETURN count(*) } AS c`),
      ).toEqual(cs(`MATCH (u:P) RETURN u.n AS n, COUNT { MATCH ${body} } AS c`));
    }
  });

  test('the counts themselves are right, not merely equal to each other', () => {
    // `a` has three out-edges; `b` has one; `bare` and `lonely` have none.
    expect(
      cs('MATCH (u:P) RETURN u.n AS n, VALUE { MATCH (u)-[:T]->(x) RETURN count(*) } AS c'),
    ).toEqual([
      { n: 1, c: 3 },
      { n: 2, c: 1 },
      { n: null, c: 0 },
      { n: 9, c: 0 },
    ]);
  });

  test('a sub-WHERE is carried over, not dropped', () => {
    expect(
      cs(
        'MATCH (u:P) WHERE u.n = 1 RETURN VALUE { MATCH (u)-[:T]->(x) WHERE x.n = 2 RETURN count(*) } AS c',
      ),
    ).toEqual([{ c: 1 }]);
    expect(
      cs('MATCH (u:P) WHERE u.n = 1 RETURN COUNT { MATCH (u)-[:T]->(x) WHERE x.n = 2 } AS c'),
    ).toEqual([{ c: 1 }]);
  });

  // The three things the lowering must NOT swallow. Each is a different question from a degree,
  // so each is a case where rewriting the node would change the answer.
  test('count of an ARGUMENT is not count(*) — nulls do not count', () => {
    // `a` reaches b (n=2), c (n=3) and `bare` (no n): three rows, two non-null `n`.
    expect(
      cs('MATCH (u:P) WHERE u.n = 1 RETURN VALUE { MATCH (u)-[:T]->(x) RETURN count(x.n) } AS c'),
    ).toEqual([{ c: 2 }]);
    expect(
      cs('MATCH (u:P) WHERE u.n = 1 RETURN VALUE { MATCH (u)-[:T]->(x) RETURN count(*) } AS c'),
    ).toEqual([{ c: 3 }]);
  });

  test('a DISTINCT count is not a degree', () => {
    // Two of `a`'s three neighbours are `:P`-labelled in different ways but all three `n` values
    // differ except the missing one, so DISTINCT drops the null: 2, not 3.
    expect(
      cs(
        'MATCH (u:P) WHERE u.n = 1 RETURN VALUE { MATCH (u)-[:T]->(x) RETURN count(DISTINCT x.n) } AS c',
      ),
    ).toEqual([{ c: 2 }]);
  });

  test('a PATTERNLESS VALUE stays a scalar subquery', () => {
    // `VALUE { RETURN count(*) }` has nothing to count — it must not become a degree of nothing.
    expect(cs('MATCH (u:P) WHERE u.n = 1 RETURN VALUE { RETURN count(*) } AS c')).toEqual([
      { c: 1 },
    ]);
  });

  test('a non-count RETURN is untouched', () => {
    expect(
      cs('MATCH (u:P) WHERE u.n = 2 RETURN VALUE { MATCH (u)-[:T]->(x) RETURN x.n } AS c'),
    ).toEqual([{ c: 3 }]);
  });
});
