// `EXISTS { (x)-[:T]->(b:L) }` — a LABEL-ONLY endpoint with no sub-`WHERE`.
//
// `oneHopExists` has a free-endpoint arm (a bucket size read) and a general arm that calls
// `matchNode` per edge, which allocates a binding for an endpoint variable nothing reads. A
// label alone was enough to leave the cheap arm: 277.1ms at 200,000 vertices against 67.8 for
// the free arm (item 525). The new arm keeps `matchNode`'s other two parts verbatim — the
// label test and `consistent` — and drops only the allocation.
//
// `consistent` is the whole correctness question here: it is what makes a REPEATED endpoint
// variable mean identity rather than "any neighbour". These cases exist to pin that.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });
  const d = g.addVertex({ id: 'd', labels: ['R'], properties: { n: 4 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e3', from: d, to: d, labels: ['T'], properties: {} }); // a SELF-LOOP
  g.addEdge({ id: 'e4', from: b, to: d, labels: ['S'], properties: {} });

  return g;
};

const g = build();
const ids = (q: string): unknown[] =>
  (query(g, q) as Record<string, unknown>[]).map((r) => r.id).sort();

describe('EXISTS with a label-only endpoint (item 525)', () => {
  test('answers the label question', () => {
    // `a` reaches b (`:P,:Q`) and c (`:Q`); `d` reaches only itself (`:R`).
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b:Q) } RETURN x.n AS id')).toEqual([1]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b:R) } RETURN x.n AS id')).toEqual([4]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b:P) } RETURN x.n AS id')).toEqual([1]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b:NOPE) } RETURN x.n AS id')).toEqual([]);
  });

  test('a REPEATED endpoint variable is identity, not any neighbour', () => {
    // `(x)-[:T]->(x)` is a self-loop. Only `d` has one — and `a`, which has two `:T` edges to
    // OTHER vertices, must not answer true. Dropping `consistent` would make both true.
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(x) } RETURN x.n AS id')).toEqual([4]);
    // With a label on the repeated variable, the same, and the label must also hold.
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(x:R) } RETURN x.n AS id')).toEqual([4]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(x:Q) } RETURN x.n AS id')).toEqual([]);
  });

  test('an endpoint variable BOUND OUTSIDE is that vertex, not any neighbour', () => {
    // `y` is bound by the outer MATCH, so the question is whether THAT pair is connected.
    expect(
      ids('MATCH (x), (y) WHERE y.n = 3 AND EXISTS { (x)-[:T]->(y) } RETURN x.n AS id'),
    ).toEqual([1]);
    expect(
      ids('MATCH (x), (y) WHERE y.n = 4 AND EXISTS { (x)-[:T]->(y) } RETURN x.n AS id'),
    ).toEqual([4]);
  });

  test('the INCOMING direction', () => {
    expect(ids('MATCH (x) WHERE EXISTS { (x)<-[:T]-(b:P) } RETURN x.n AS id')).toEqual([2, 3]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)<-[:S]-(b:Q) } RETURN x.n AS id')).toEqual([4]);
  });

  test('an edge TYPE nothing carries', () => {
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:NOPE]->(b:Q) } RETURN x.n AS id')).toEqual([]);
  });

  test('the shapes the new arm REFUSES are unchanged', () => {
    // An inline property on the endpoint — `hasPredicate` is true, so `matchNode` still runs.
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b {n: 3}) } RETURN x.n AS id')).toEqual([1]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b {n: 9}) } RETURN x.n AS id')).toEqual([]);
    // A sub-`WHERE` — the endpoint has to be BOUND for the predicate to read it.
    expect(
      ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b:Q) WHERE b.n = 3 } RETURN x.n AS id'),
    ).toEqual([1]);
    expect(
      ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b:Q) WHERE b.n = 9 } RETURN x.n AS id'),
    ).toEqual([]);
    // And one that reads BOTH ends, which only the general binding can answer.
    expect(
      ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b) WHERE b.n > x.n } RETURN x.n AS id'),
    ).toEqual([1]);
  });

  test('an UNLABELLED endpoint still takes the free arm', () => {
    // The control the new arm cannot reach: no label, no pred, no WHERE is `shape.free`, which
    // returns from a bucket size before any edge is visited.
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:T]->(b) } RETURN x.n AS id')).toEqual([1, 4]);
    expect(ids('MATCH (x) WHERE EXISTS { (x)-[:S]->(b) } RETURN x.n AS id')).toEqual([2]);
  });
});
