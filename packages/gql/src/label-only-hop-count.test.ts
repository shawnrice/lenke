// Item 286. A one-hop `count(*)` whose only constraint is a LABEL on one end had no degree-sum
// rung: the unfiltered branch of `buildOneHopCount` went straight from the O(1) bucket size
// (both ends unconstrained) to a per-edge walk testing both endpoints' labels. So
// `MATCH (a:S)-[:E]->(b) RETURN count(*)` — four vertices with ZERO edges — scanned all 600,000
// edges to find none.
//
// EVERY TEST HERE COMPARES THE SHORTCUT AGAINST THE GENERAL PATH on the same question.
// `count(*)` routes to the shortcut; the same pattern returning a VALUE does not, so the row
// count of the second is the first's answer computed by code this change cannot reach. That is
// the only comparison that can catch a wrong count, because a count has no shape to inspect —
// and a wrong count is what a bad soundness guard produces (a two-type edge counted twice).
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Three vertex populations so a label can be vacuous, selective, or empty-of-edges, and a
 * two-type edge so the summation guard has something to be wrong about.
 *
 *   p0..p5   `P`, and p0/p3 also `Q`
 *   s0, s1   `S` — no edges at all, the shape that cost 7000x
 *   every vertex above is `V`, so `:V` IS vacuous
 */
const g = (): Graph => {
  const graph = new Graph();
  const p = [0, 1, 2, 3, 4, 5].map((i) =>
    graph.addVertex({
      labels: i % 3 === 0 ? ['P', 'Q', 'V'] : ['P', 'V'],
      properties: { n: `p${i}` },
    }),
  );

  for (const i of [0, 1]) {
    graph.addVertex({ labels: ['S', 'V'], properties: { n: `s${i}` } });
  }

  // A ring plus a chord, so degrees differ and no vertex has degree 0 among the P's.
  for (let i = 0; i < p.length; i++) {
    graph.addEdge({ from: p[i], to: p[(i + 1) % p.length], labels: ['E'], properties: {} });
  }

  graph.addEdge({ from: p[0], to: p[3], labels: ['E'], properties: {} });
  // A TWO-TYPE edge: it is ONE edge, and summing the `E` and `F` bucket sizes would count it
  // twice. This is what `multiTypeEdgeCount` guards.
  graph.addEdge({ from: p[1], to: p[4], labels: ['E', 'F'], properties: {} });
  graph.addEdge({ from: p[2], to: p[5], labels: ['F'], properties: {} });

  return graph;
};

const count = (q: string): number => Number(query(g(), q)[0]?.c ?? -1);

/**
 * The same question asked so the shortcut cannot answer it. Returning a VALUE builds a row per
 * match through the general matcher, so the row count is the independent answer.
 */
const viaGeneralPath = (pattern: string): number => query(g(), `${pattern} RETURN 1 AS one`).length;

const agree = (pattern: string): void => {
  expect(count(`${pattern} RETURN count(*) AS c`)).toBe(viaGeneralPath(pattern));
};

describe('a start label with the far end unconstrained', () => {
  test('out', () => {
    agree('MATCH (a:P)-[:E]->(b)');
  });

  test('in', () => {
    agree('MATCH (a:P)<-[:E]-(b)');
  });

  test('a SUBSET label — only every third vertex is a Q', () => {
    agree('MATCH (a:Q)-[:E]->(b)');
  });

  test('a label whose vertices have NO edges answers 0', () => {
    // The 7000x case. A degree sum over two vertices; the old path scanned every edge.
    expect(count('MATCH (a:S)-[:E]->(b) RETURN count(*) AS c')).toBe(0);
    agree('MATCH (a:S)-[:E]->(b)');
  });

  test('a VACUOUS label is elided and still agrees', () => {
    agree('MATCH (a:V)-[:E]->(b)');
  });

  test('a label no vertex carries answers 0', () => {
    expect(count('MATCH (a:Nope)-[:E]->(b) RETURN count(*) AS c')).toBe(0);
    agree('MATCH (a:Nope)-[:E]->(b)');
  });

  test('an untyped relationship over a labelled start', () => {
    agree('MATCH (a:P)-[]->(b)');
  });
});

describe('a far label with the start unconstrained', () => {
  test('out', () => {
    agree('MATCH (a)-[:E]->(b:P)');
  });

  test('in', () => {
    agree('MATCH (a)<-[:E]-(b:P)');
  });

  test('a subset far label', () => {
    agree('MATCH (a)-[:E]->(b:Q)');
  });

  test('an edgeless far label answers 0', () => {
    expect(count('MATCH (a)-[:E]->(b:S) RETURN count(*) AS c')).toBe(0);
    agree('MATCH (a)-[:E]->(b:S)');
  });
});

describe('the SUMMATION GUARD — a two-type edge is still ONE edge', () => {
  // THE WRONG-ANSWER CASE. Both walks sum per-type bucket sizes, which double-counts an edge
  // sitting in two of the summed buckets. `multiTypeEdgeCount !== 0` with more than one type
  // must decline to the per-edge walk, which dedupes. The fixture has exactly one such edge,
  // so a dropped guard answers one too many.
  test('a two-type rel over a labelled start', () => {
    agree('MATCH (a:P)-[:E|F]->(b)');
  });

  test('a two-type rel over a labelled far end', () => {
    agree('MATCH (a)-[:E|F]->(b:P)');
  });

  test('and the single-type spellings of the same pair are unaffected', () => {
    agree('MATCH (a:P)-[:E]->(b)');
    agree('MATCH (a:P)-[:F]->(b)');
  });
});

describe('what the rung must decline', () => {
  test('BOTH ends labelled — neither walk can apply the other end', () => {
    agree('MATCH (a:P)-[:E]->(b:Q)');
  });

  test('both ends labelled, the far one edgeless', () => {
    expect(count('MATCH (a:P)-[:E]->(b:S) RETURN count(*) AS c')).toBe(0);
    agree('MATCH (a:P)-[:E]->(b:S)');
  });

  test('an undirected rel', () => {
    agree('MATCH (a:P)-[:E]-(b)');
  });

  test('a clause WHERE on the start still agrees', () => {
    agree("MATCH (a:P)-[:E]->(b) WHERE a.n = 'p0'");
  });

  test('an inline constraint on the start still agrees', () => {
    agree("MATCH (a:P {n: 'p0'})-[:E]->(b)");
  });

  test('an inline constraint on the FAR end still agrees', () => {
    agree("MATCH (a:P)-[:E]->(b {n: 'p1'})");
  });

  test('a clause WHERE on the far end still agrees', () => {
    agree("MATCH (a:P)-[:E]->(b) WHERE b.n = 'p1'");
  });

  test('a constraint on BOTH ends still agrees', () => {
    agree("MATCH (a:P)-[:E]->(b) WHERE a.n = 'p0' AND b.n = 'p1'");
  });
});

describe('a multi-label vertex is counted once per edge, not once per label', () => {
  // p0 and p3 are both `P` and `Q`. A walk driven from the label bucket must not visit a
  // vertex twice because `:Q` names one of two labels it carries.
  test('the Q bucket and the general path agree on the degree sum', () => {
    agree('MATCH (a:Q)-[:E]->(b)');
    agree('MATCH (a)-[:E]->(b:Q)');
  });

  test('an empty graph answers 0 rather than faulting', () => {
    expect(query(new Graph(), 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')[0]?.c).toBe(0);
  });
});
