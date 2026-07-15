import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { parseQuery, query } from './index.js';

// The TinkerPop "modern" graph.
const modern = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, name: string) =>
    g.addVertex({ id, labels: [label], properties: { name } });
  const marko = v('marko', 'Person', 'marko');
  const vadas = v('vadas', 'Person', 'vadas');
  const josh = v('josh', 'Person', 'josh');
  const peter = v('peter', 'Person', 'peter');
  const lop = v('lop', 'Software', 'lop');
  const ripple = v('ripple', 'Software', 'ripple');
  g.addEdge({ from: marko, to: vadas, labels: ['KNOWS'], properties: {} });
  g.addEdge({ from: marko, to: josh, labels: ['KNOWS'], properties: {} });
  g.addEdge({ from: marko, to: lop, labels: ['CREATED'], properties: {} });
  g.addEdge({ from: josh, to: ripple, labels: ['CREATED'], properties: {} });
  g.addEdge({ from: josh, to: lop, labels: ['CREATED'], properties: {} });
  g.addEdge({ from: peter, to: lop, labels: ['CREATED'], properties: {} });

  return g;
};

describe('named procedure CALL', () => {
  test('CALL pagerank YIELD — lop (most in-edges) is the top score', () => {
    const rows = query(
      modern(),
      'CALL pagerank() YIELD node, score RETURN node ORDER BY score DESC, node LIMIT 1',
    );
    expect(rows).toEqual([{ node: 'lop' }]);
  });

  test('CALL degree — YIELD-less binds node + degree; one row per vertex', () => {
    const rows = query(modern(), 'CALL degree() RETURN node, degree');
    expect(rows).toHaveLength(6);
  });

  test('YIELD aliasing + ISO WITH … WHERE filtering', () => {
    const rows = query(
      modern(),
      'CALL degree() YIELD node AS v, degree AS d WITH v, d WHERE d >= 3 RETURN v ORDER BY v',
    );
    expect(rows).toEqual([{ v: 'marko' }]); // marko has out-degree 3
  });

  test('config writeProperty mutates the graph', () => {
    const g = modern();
    query(g, "CALL degree({writeProperty: 'deg'}) YIELD node RETURN node");
    const read = query(g, "MATCH (n) WHERE n.name = 'marko' RETURN n.deg AS d");
    expect(read).toEqual([{ d: 3 }]);
  });

  test('unknown procedure faults; inline-subquery CALL is rejected at parse', () => {
    expect(() => query(modern(), 'CALL bogus() YIELD x RETURN x')).toThrow();
    expect(() => parseQuery('CALL { MATCH (n) RETURN n }')).toThrow();
    expect(() => parseQuery('CALL (a) { MATCH (n) RETURN n }')).toThrow();
  });
});
