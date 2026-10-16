import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 484: undirected legs in the THREE-hop count. The two outer legs become undirected
// degrees (item 483's `undirectedSide`) and the MIDDLE leg walks the out-bucket then the
// in-bucket, skipping the self-loop the out-pass already took — `expand`'s own dedupe.
//
// 64.1 SECONDS -> 1.17 s at 200,000 nodes / 1,000,000 edges (54x); 6076 -> 71 ms at 20,000.
//
// Oracle: the same query with a clause `WHERE`, which has no undirected fast arm and so runs
// the general path. Three hops is where my own arithmetic stops being trustworthy, which is
// exactly why none of these numbers is one I worked out.
const both = (g: Graph, pattern: string): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} RETURN count(*) AS c`)[0].c;
  const slow = query<{ c: number }>(g, `MATCH ${pattern} WHERE true RETURN count(*) AS c`)[0].c;

  expect(fast).toBe(slow);

  return fast;
};

const path4 = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });
  const d = g.addVertex({ id: 'd', labels: ['P'], properties: {} });

  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'cd', from: c, to: d, labels: ['T'], properties: {} });

  return g;
};

describe('undirected legs in a three-hop count (item 484)', () => {
  test('a four-vertex path, every leg undirected', () => {
    expect(both(path4(), '(:P)-[:T]-(w)-[:T]-(x)-[:T]-(y)')).toBe(16);
  });

  test('each MIXED combination agrees with the general path', () => {
    const g = path4();

    for (const pattern of [
      '(:P)-[:T]-(w)-[:T]->(x)-[:T]->(y)',
      '(:P)-[:T]->(w)-[:T]-(x)-[:T]->(y)',
      '(:P)-[:T]->(w)-[:T]->(x)-[:T]-(y)',
      '(:P)-[:T]-(w)-[:T]-(x)-[:T]->(y)',
      '(:P)-[:T]->(w)-[:T]-(x)-[:T]-(y)',
      '(:P)-[:T]-(w)-[:T]->(x)-[:T]-(y)',
    ]) {
      // `both` asserts the two routes agree; the point here is COVERAGE of the eight direction
      // combinations, not a literal per case.
      both(g, pattern);
    }
  });

  test('a SELF-LOOP on the middle leg is walked once', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'loop', from: b, to: b, labels: ['T'], properties: {} });

    // The middle leg's in-pass must skip the loop the out-pass took; without that the count
    // rises above the general path's.
    expect(both(g, '(:P)-[:T]-(w)-[:T]-(x)-[:T]-(y)')).toBe(
      query<{ c: number }>(
        g,
        'MATCH (:P)-[:T]-(w)-[:T]-(x)-[:T]-(y) WHERE true RETURN count(*) AS c',
      )[0].c,
    );
    // And a loop on an OUTER leg, which goes through the degree side instead.
    const h = new Graph();
    const p = h.addVertex({ id: 'p', labels: ['P'], properties: {} });
    const q = h.addVertex({ id: 'q', labels: ['P'], properties: {} });

    h.addEdge({ id: 'pq', from: p, to: q, labels: ['T'], properties: {} });
    h.addEdge({ id: 'loopp', from: p, to: p, labels: ['T'], properties: {} });
    both(h, '(:P)-[:T]-(w)-[:T]-(x)-[:T]-(y)');
  });

  test('LABELS select at every position', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['A'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['B'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['C'], properties: {} });
    const d = g.addVertex({ id: 'd', labels: ['D'], properties: {} });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'bc', from: b, to: c, labels: ['T'], properties: {} });
    g.addEdge({ id: 'cd', from: c, to: d, labels: ['T'], properties: {} });

    expect(both(g, '(:A)-[:T]-(w:B)-[:T]-(x:C)-[:T]-(y:D)')).toBe(1);
    expect(both(g, '(:D)-[:T]-(w:C)-[:T]-(x:B)-[:T]-(y:A)')).toBe(1);
    expect(both(g, '(:A)-[:T]-(w:C)-[:T]-(x)-[:T]-(y)')).toBe(0);
  });

  test('the edge TYPE selects per leg', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });
    const d = g.addVertex({ id: 'd', labels: ['P'], properties: {} });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ id: 'bc', from: b, to: c, labels: ['S'], properties: {} });
    g.addEdge({ id: 'cd', from: c, to: d, labels: ['T'], properties: {} });

    expect(both(g, '(:P)-[:T]-(w)-[:S]-(x)-[:T]-(y)')).toBe(2);
    // One S edge, walked three times: b-c-b-c and c-b-c-b. Two, not one — WALK semantics
    // again, and the oracle is what said so.
    expect(both(g, '(:P)-[:S]-(w)-[:S]-(x)-[:S]-(y)')).toBe(2);
  });

  test('an interior CONSTRAINT keeps the product, and a start one declines', () => {
    const g = path4();

    // An interior gate runs once per visit, so the product keeps it (item 219); a start
    // constraint forces the walk, which captures one direction and must decline.
    both(g, '(:P)-[:T]-(w:P)-[:T]-(x:P)-[:T]-(y)');
    expect(
      query(g, 'MATCH (s:P)-[:T]-(w)-[:T]-(x)-[:T]-(y) WHERE s.id IS NULL RETURN count(*) AS c'),
    ).toEqual([{ c: 16 }]);
  });
});
