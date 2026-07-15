import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

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

  test('unknown procedure faults', () => {
    expect(() => query(modern(), 'CALL bogus() YIELD x RETURN x')).toThrow();
  });
});

describe('inline subquery CALL', () => {
  test('correlated subquery — lateral join, merges nested RETURN columns', () => {
    // For each person, count how many things they created.
    const rows = query(
      modern(),
      `MATCH (p:Person)
       CALL (p) {
         MATCH (p)-[:CREATED]->(w)
         RETURN count(w) AS created
       }
       RETURN p.name AS name, created ORDER BY name`,
    );
    expect(rows).toEqual([
      { name: 'josh', created: 2 },
      { name: 'marko', created: 1 },
      { name: 'peter', created: 1 },
      { name: 'vadas', created: 0 },
    ]);
  });

  test('row duplication — a subquery returning N rows fans the outer row out', () => {
    const rows = query(
      modern(),
      `MATCH (p:Person {name: 'marko'})
       CALL (p) { MATCH (p)-[:KNOWS]->(f) RETURN f.name AS friend }
       RETURN friend ORDER BY friend`,
    );
    expect(rows).toEqual([{ friend: 'josh' }, { friend: 'vadas' }]);
  });

  test('non-OPTIONAL empty subquery drops the outer row; OPTIONAL keeps it', () => {
    // vadas created nothing → dropped without OPTIONAL.
    const dropped = query(
      modern(),
      `MATCH (p:Person)
       CALL (p) { MATCH (p)-[:CREATED]->(w) RETURN w.name AS thing }
       RETURN p.name AS name ORDER BY name`,
    );
    expect(dropped.map((r) => r.name)).toEqual(['josh', 'josh', 'marko', 'peter']);

    // OPTIONAL keeps vadas, with the nested column null-filled.
    const kept = query(
      modern(),
      `MATCH (p:Person)
       OPTIONAL CALL (p) { MATCH (p)-[:CREATED]->(w) RETURN w.name AS thing }
       RETURN p.name AS name, thing ORDER BY name, thing`,
    );
    expect(kept.some((r) => r.name === 'vadas' && r.thing === null)).toBe(true);
  });

  test('scope isolation — an unscoped outer var is not visible to the subquery', () => {
    // `p` is not imported, so the inner MATCH (p) is a fresh unbound pattern
    // matching every vertex — not the outer marko.
    const rows = query(
      modern(),
      `MATCH (p:Person {name: 'marko'})
       CALL () { MATCH (n) RETURN count(n) AS total }
       RETURN total`,
    );
    expect(rows).toEqual([{ total: 6 }]); // all 6 vertices, not just marko's
  });
});
