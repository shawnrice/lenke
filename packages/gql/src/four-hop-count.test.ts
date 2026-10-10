// Item 290. The multi-segment count family handled 1, 2 and 3 segments and returned `null` for
// four, so a 4-hop `count(*)` fell to the general matcher — which builds a binding per PATH. At
// 50,000 nodes of degree 5 the family read 0.00 / 13.67 / 77.56ms for 1-3 hops and **36,082ms**
// for four: a x420 step where the degree predicts x6, and 1154ns a path against the 3-hop
// shortcut's 13.7ns.
//
// EVERY TEST HERE COMPARES THE SHORTCUT AGAINST AN INDEPENDENT ENUMERATION. `count(*)` routes to
// the degree product; the same pattern returning a value builds one row per path through the
// general matcher, so its row count is the answer computed by code this change cannot reach.
// That is the only comparison available for a count — it has no shape to inspect, and a degree
// product that multiplies the wrong factors returns a plausible number.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * A deliberately LOPSIDED graph, so a wrong factor shows up as a wrong number.
 *
 * With a uniform degree every mis-pairing of factors gives the same product, which is how a
 * degree-product bug hides. Here in-degrees and out-degrees differ per node and by edge type.
 */
const g = (): Graph => {
  const graph = new Graph();
  const n = [0, 1, 2, 3, 4, 5].map((i) =>
    graph.addVertex({ labels: i % 2 === 0 ? ['P', 'Even'] : ['P'], properties: { k: i } }),
  );

  // An uneven `E` web: node 0 has 3 out-edges, node 1 has 2, nodes 2-4 one each, node 5 none.
  const e = (from: number, to: number, label = 'E'): void => {
    graph.addEdge({ from: n[from], to: n[to], labels: [label], properties: {} });
  };

  e(0, 1);
  e(0, 2);
  e(0, 3);
  e(1, 2);
  e(1, 4);
  e(2, 3);
  e(3, 4);
  e(4, 0);
  // A second type, so a multi-type rel and a type filter have something to distinguish.
  e(2, 5, 'F');
  e(5, 0, 'F');
  e(3, 0, 'F');

  return graph;
};

const count = (q: string): number => Number(query(g(), q)[0]?.c);

/** The same pattern enumerated — one row per path, through code the shortcut cannot reach. */
const enumerated = (pattern: string): number => query(g(), `${pattern} RETURN 1 AS one`).length;

const agree = (pattern: string): void => {
  expect(count(`${pattern} RETURN count(*) AS c`)).toBe(enumerated(pattern));
};

describe('an unfiltered four-segment count equals the enumeration', () => {
  test('all forward, one type', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });

  test('and the answer is non-trivial, so the comparison means something', () => {
    expect(enumerated('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)')).toBeGreaterThan(3);
  });

  test('no start label', () => {
    agree('MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });

  test('a label on the END, which the product reaches only as a degree', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x:Even)');
  });

  test('a label on each INTERIOR position', () => {
    agree('MATCH (a:P)-[:E]->(b:Even)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c:Even)-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d:Even)-[:E]->(x)');
  });

  test('a label on EVERY position at once', () => {
    agree('MATCH (a:Even)-[:E]->(b:Even)-[:E]->(c:Even)-[:E]->(d:Even)-[:E]->(x:Even)');
  });

  test('a label that no vertex carries answers 0', () => {
    expect(
      count('MATCH (a:Nope)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x) RETURN count(*) AS c'),
    ).toBe(0);
    agree('MATCH (a:Nope)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });
});

describe('directions — each leg independently', () => {
  // The walk hoists the `a` side from `b`'s REVERSE index and takes `x` from `d`'s FORWARD one,
  // and the two interior legs pick their own index. Each flag is a separate variable, so each
  // arrow is flipped on its own: a single `toAOut`/`mid1Out`/`mid2Out`/`fromXOut` read backwards
  // gives a plausible number on a uniform graph and a wrong one here.
  test('first leg reversed', () => {
    agree('MATCH (a:P)<-[:E]-(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });

  test('second leg reversed', () => {
    agree('MATCH (a:P)-[:E]->(b)<-[:E]-(c)-[:E]->(d)-[:E]->(x)');
  });

  test('third leg reversed', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)<-[:E]-(d)-[:E]->(x)');
  });

  test('fourth leg reversed', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)<-[:E]-(x)');
  });

  test('all four reversed', () => {
    agree('MATCH (a:P)<-[:E]-(b)<-[:E]-(c)<-[:E]-(d)<-[:E]-(x)');
  });

  test('alternating', () => {
    agree('MATCH (a:P)-[:E]->(b)<-[:E]-(c)-[:E]->(d)<-[:E]-(x)');
  });
});

describe('relationship types', () => {
  test('a different type on each leg', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:F]->(c)-[:E]->(d)-[:F]->(x)');
  });

  test('a MULTI-type leg', () => {
    agree('MATCH (a:P)-[:E|F]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E|F]->(x)');
  });

  test('an UNTYPED leg', () => {
    agree('MATCH (a:P)-[]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[]->(c)-[]->(d)-[]->(x)');
  });

  test('a type no edge carries answers 0', () => {
    expect(
      count('MATCH (a:P)-[:NOPE]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x) RETURN count(*) AS c'),
    ).toBe(0);
    agree('MATCH (a:P)-[:NOPE]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });
});

describe('what the arm must DECLINE, still answering correctly', () => {
  test('an INLINE constraint at each position', () => {
    agree('MATCH (a:P {k: 0})-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c)-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 3})-[:E]->(d)-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d {k: 4})-[:E]->(x)');
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x {k: 0})');
  });

  test('an inline WHERE at an interior position', () => {
    agree('MATCH (a:P)-[:E]->(b WHERE b.k = 2)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });

  test('a clause WHERE', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x) WHERE b.k = 2');
  });

  test('a SHARED node variable — a self-join the product cannot express', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(a)');
  });

  test('a BOUND relationship variable', () => {
    agree('MATCH (a:P)-[r:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });

  test('an UNDIRECTED leg', () => {
    agree('MATCH (a:P)-[:E]-(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)');
  });

  test('FIVE segments still decline and still answer', () => {
    agree('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)-[:E]->(y)');
  });
});

describe('degenerate graphs', () => {
  const FOUR = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)';
  /** The four-hop count over an arbitrary graph, so each degenerate fixture reads as one line. */
  const countIn = (graph: Graph): number =>
    Number(query(graph, `${FOUR} RETURN count(*) AS c`)[0]?.c);

  test('an empty graph answers 0', () => {
    expect(countIn(new Graph())).toBe(0);
  });

  test('a graph with nodes but no edges answers 0', () => {
    const bare = new Graph();
    bare.addVertex({ labels: ['P'], properties: { k: 1 } });
    bare.addVertex({ labels: ['P'], properties: { k: 2 } });

    expect(countIn(bare)).toBe(0);
  });

  test('a single self-loop', () => {
    // Four hops around ONE vertex: every leg is the same edge, so the answer is 1 — and a walk
    // that double-counted a self-loop's two endpoints would say more.
    const loop = new Graph();
    const v = loop.addVertex({ labels: ['P'], properties: { k: 1 } });
    loop.addEdge({ from: v, to: v, labels: ['E'], properties: {} });

    expect(countIn(loop)).toBe(query(loop, `${FOUR} RETURN 1 AS one`).length);
  });
});
