import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The fused hop projection now admits the START variable in projected items, binding it once
// per outer vertex (audit item 160). Refusing it cost 3.5-4.7x on four shapes, including the
// very ordinary unfiltered `MATCH (u:L)-[:E]->(v) RETURN u.name` — 20.0ms against 5.7ms for the
// same query projecting `v.name`, with no semantic difference between them.
//
// Projecting the START is where a hop's DUPLICATES live: one row per EDGE, so a vertex with
// three out-edges appears three times. A fixture of 1:1 edges cannot tell a correct walk from
// one that deduplicates or that binds the wrong vertex, so the degrees here are uneven.
const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { name: 'a', k: 1 } });
  const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { name: 'b', k: 2 } });
  const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { name: 'c', k: 2 } });
  const d = graph.addVertex({ id: 'd', labels: ['P'], properties: { name: 'd', k: 3 } });

  // a has THREE out-edges, b has one, c and d none.
  graph.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
  graph.addEdge({ from: a, to: c, labels: ['E'], properties: {} });
  graph.addEdge({ from: a, to: d, labels: ['E'], properties: {} });
  graph.addEdge({ from: b, to: d, labels: ['E'], properties: {} });

  return graph;
};

const got = (q: string): string[] =>
  (query(g(), q) as Record<string, unknown>[]).map((r) => JSON.stringify(r)).sort();

describe('the start may be projected', () => {
  test('the start alone, unfiltered — one row per EDGE', () => {
    // `a` three times for its three out-edges, `b` once. A walk that bound the far end here, or
    // that deduplicated, would answer differently — which a 1:1 fixture could not show.
    expect(got('MATCH (u:P)-[:E]->(v) RETURN u.name AS n')).toEqual([
      '{"n":"a"}',
      '{"n":"a"}',
      '{"n":"a"}',
      '{"n":"b"}',
    ]);
  });

  test('BOTH ends projected', () => {
    // Keys in PROJECTION order, not alphabetical: column order is observable bytes here (see
    // `column-order.test.ts`), and writing them alphabetically is what made this fail first.
    expect(got('MATCH (u:P)-[:E]->(v) RETURN u.name AS s, v.name AS f')).toEqual([
      '{"s":"a","f":"b"}',
      '{"s":"a","f":"c"}',
      '{"s":"a","f":"d"}',
      '{"s":"b","f":"d"}',
    ]);
  });

  test('the start under a FAR clause filter', () => {
    // `v.k = 2` keeps a->b and a->c, so `a` twice and nothing else.
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 RETURN u.name AS n')).toEqual([
      '{"n":"a"}',
      '{"n":"a"}',
    ]);
  });

  test('both ends under a far clause filter', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 RETURN u.name AS s, v.name AS f')).toEqual([
      '{"s":"a","f":"b"}',
      '{"s":"a","f":"c"}',
    ]);
  });

  test('the start under a far INLINE constraint', () => {
    expect(got('MATCH (u:P)-[:E]->(v {k: 3}) RETURN u.name AS n')).toEqual([
      '{"n":"a"}',
      '{"n":"b"}',
    ]);
  });

  test('the start under a NEAR filter, which the seed pre-filter owns', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE u.k = 1 RETURN u.name AS n')).toEqual([
      '{"n":"a"}',
      '{"n":"a"}',
      '{"n":"a"}',
    ]);
  });

  test('an EXPRESSION over the start', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 RETURN u.k + 10 AS n')).toEqual([
      '{"n":11}',
      '{"n":11}',
    ]);
  });

  test('an expression mixing both ends', () => {
    // a(1)->b(2) and a(1)->c(2) are both 3; a(1)->d(3) is 4; b(2)->d(3) is 5. Written as
    // 3/4/4/5 first, which simply had `c.k` wrong.
    expect(got('MATCH (u:P)-[:E]->(v) RETURN u.k + v.k AS n')).toEqual([
      '{"n":3}',
      '{"n":3}',
      '{"n":4}',
      '{"n":5}',
    ]);
  });

  test('the same start column twice', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 3 RETURN u.name AS a, u.name AS b')).toEqual([
      '{"a":"a","b":"a"}',
      '{"a":"b","b":"b"}',
    ]);
  });

  test('a start LABEL narrows the walk', () => {
    const graph = new Graph();
    const x = graph.addVertex({ id: 'x', labels: ['P', 'Q'], properties: { name: 'x' } });
    const y = graph.addVertex({ id: 'y', labels: ['P'], properties: { name: 'y' } });
    const z = graph.addVertex({ id: 'z', labels: ['P'], properties: { name: 'z' } });

    graph.addEdge({ from: x, to: z, labels: ['E'], properties: {} });
    graph.addEdge({ from: y, to: z, labels: ['E'], properties: {} });

    expect(query(graph, 'MATCH (u:Q)-[:E]->(v) RETURN u.name AS n')).toEqual([{ n: 'x' }]);
  });

  test('the INCOMING direction', () => {
    // `d` has two in-edges, `b` and `c` one each.
    expect(got('MATCH (u:P)<-[:E]-(v) RETURN u.name AS n')).toEqual([
      '{"n":"b"}',
      '{"n":"c"}',
      '{"n":"d"}',
      '{"n":"d"}',
    ]);
  });

  test('a vertex with NO edges contributes nothing', () => {
    // `c` and `d` have no out-edges, so neither appears when the start is projected.
    const rows = got('MATCH (u:P)-[:E]->(v) RETURN u.name AS n');

    expect(rows.filter((r) => r.includes('"c"'))).toEqual([]);
    expect(rows.filter((r) => r.includes('"d"'))).toEqual([]);
  });
});

describe('shapes that still decline, and still answer', () => {
  test('an item reading a name that is NEITHER endpoint', () => {
    // `z` is bound by an earlier clause, so the fused walk cannot serve it. It must decline and
    // still answer — one row per (z, edge) pair.
    expect(got("MATCH (z:P {name: 'a'}) MATCH (u:P)-[:E]->(v) RETURN z.name AS n")).toHaveLength(4);
  });

  test('an item reading the REL variable', () => {
    // A named relationship is refused earlier; the answer must still be right.
    expect(got('MATCH (u:P)-[r:E]->(v) WHERE v.k = 3 RETURN u.name AS n')).toEqual([
      '{"n":"a"}',
      '{"n":"b"}',
    ]);
  });

  test('DISTINCT over the start keeps its own path', () => {
    expect(got('MATCH (u:P)-[:E]->(v) RETURN DISTINCT u.name AS n')).toEqual([
      '{"n":"a"}',
      '{"n":"b"}',
    ]);
  });

  test('ORDER BY over the start', () => {
    expect(query(g(), 'MATCH (u:P)-[:E]->(v) RETURN u.name AS n ORDER BY n DESC')).toEqual([
      { n: 'b' },
      { n: 'a' },
      { n: 'a' },
      { n: 'a' },
    ]);
  });

  test('a count over the hop is unaffected', () => {
    expect(query(g(), 'MATCH (u:P)-[:E]->(v) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });
});
