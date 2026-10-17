// `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*)` is a degree sum with a FLOOR: a
// left-outer hop yields one row per anchor either way, so the count is Σ max(degree, 1).
//
// Every other rung refuses `optional`, so this shape had no rung at all and fell to the general
// row pipeline — 710-858ms at 200,000 vertices against the native engine's 0.6 once item 509
// gave it the same arithmetic (item 510).
//
// The oracle throughout is a DECLINING TWIN: `count(*) + 0` is an aggregate EXPRESSION rather
// than a bare `count(*)`, so the rung refuses it and the general path answers instead. Same
// question, different route.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  // `lonely` is a `:P` with no edges at all — the floor is what counts it.
  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'bb', from: b, to: b, labels: ['S'], properties: {} });

  return g;
};

const g = build();
const one = (q: string): unknown => (query(g, q)[0] as Record<string, unknown>)?.c;

describe('count(*) over an OPTIONAL hop (item 510)', () => {
  const both = (body: string, want: number) => {
    const fast = `MATCH (a:P) OPTIONAL MATCH ${body} RETURN count(*) AS c`;
    const slow = `MATCH (a:P) OPTIONAL MATCH ${body} RETURN count(*) + 0 AS c`;

    expect(one(fast)).toBe(want);
    expect(one(slow)).toBe(want);
  };

  test('the floor counts an anchor with no match', () => {
    // Three `:P` anchors. `a` has two T out-edges; `b` and `lonely` have none, so 2 + 1 + 1.
    both('(a)-[:T]->(x)', 4);
    // By the S type only `b` matches: 1 + 1 + 1.
    both('(a)-[:S]->(x)', 3);
    // Untyped: a has 2, b has its S loop, lonely none — 2 + 1 + 1.
    both('(a)-[]->(x)', 4);
    // An unknown type matches nothing, so every anchor null-fills.
    both('(a)-[:NOPE]->(x)', 3);
  });

  test('direction and a landing LABEL select', () => {
    // In-edges: `b` has one (from a), `a` and `lonely` none — 1 + 1 + 1.
    both('(a)<-[:T]-(x)', 3);
    // Only `c` is `:Q`, reached once from `a`: 1 + 1 + 1.
    both('(a)-[:T]->(x:Q)', 3);
    // Both of a's T targets are not `:P`-only — `b` is, `c` is not: 1 + 1 + 1.
    both('(a)-[:T]->(x:P)', 3);
  });

  test('an UNLABELLED anchor walks every vertex', () => {
    const fast = 'MATCH (a) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*) AS c';
    const slow = 'MATCH (a) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*) + 0 AS c';

    // Four vertices: a gives 2, b, c and lonely give 1 each.
    expect(one(fast)).toBe(5);
    expect(one(slow)).toBe(5);
  });

  // What the rung must NOT take. Each is a different question, and the general path answers it.
  test('the shapes it declines still answer correctly', () => {
    // `both` needs the undirected walk's self-loop care, so it declines. The T type is what
    // DISTINGUISHES it: undirected gives a 2, b 1 and lonely its floor, for 4 — where reading
    // the direction flag as "not out" would count in-edges only and answer 3. The S spelling
    // happens to agree either way, so it cannot catch an admitted `both` on its own.
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[:T]-(x) RETURN count(*) AS c')).toBe(4);
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[:S]-(x) RETURN count(*) AS c')).toBe(3);
    // A rel VARIABLE is a value the query may read.
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[r:T]->(x) RETURN count(*) AS c')).toBe(4);
    // An inline property on the landing node decides both the match and the null-fill.
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x {k: 2}) RETURN count(*) AS c')).toBe(3);
    // A constrained ANCHOR is `buildNodeCount`'s tally, not a bucket walk.
    expect(one('MATCH (a:P {k: 1}) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*) AS c')).toBe(2);
    // A second hop in the optional pattern.
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x)-[:S]->(y) RETURN count(*) AS c')).toBe(3);
    // A GROUPED count is per key, not one row.
    expect(
      query(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN a.k AS k, count(*) AS c').length,
    ).toBe(3);
    // And `count(DISTINCT x)` counts endpoints, where a null-filled row has none.
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(DISTINCT x) AS c')).toBe(2);
  });

  test('SKIP and LIMIT over the one row', () => {
    expect(one('MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*) AS c LIMIT 1')).toBe(4);
    expect(
      query(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*) AS c LIMIT 0'),
    ).toEqual([]);
    expect(
      query(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*) AS c SKIP 1'),
    ).toEqual([]);
  });
});
