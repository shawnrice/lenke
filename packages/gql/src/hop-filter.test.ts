import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The fused hop projection now CARRIES a far-end filter instead of declining it — both the
// clause `WHERE` and the far node's own inline constraint (audit item 159). Declining made a
// FILTERED hop 3x the cost of the same hop UNFILTERED, and once the clause form was carried it
// left the inline spelling of the same question 5x behind, which is the gap this repo is named
// after.
//
// THE ORACLE IS INDEPENDENT: every filtered result is compared against the UNFILTERED rows
// filtered in JS. That does not rely on either engine's filtering being right, and it is what
// makes these tests more than a restatement of the implementation.
const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, tag: 'x' } });
  const b = graph.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { k: 2, tag: 'y' } });
  const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { k: 2, tag: 'x' } });
  const d = graph.addVertex({ id: 'd', labels: ['P'], properties: { k: 3, tag: 'y' } });

  graph.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
  graph.addEdge({ from: a, to: c, labels: ['E'], properties: {} });
  graph.addEdge({ from: b, to: d, labels: ['E'], properties: {} });
  graph.addEdge({ from: c, to: d, labels: ['E'], properties: {} });

  return graph;
};

/** The unfiltered hop's rows, kept where `keep` holds — the oracle. */
const oracle = (keep: (r: { n: unknown }) => boolean): string[] =>
  (query(g(), 'MATCH (u:P)-[:E]->(v) RETURN v.k AS n') as { n: unknown }[])
    .filter(keep)
    .map((r) => JSON.stringify(r))
    .sort();

const got = (q: string): string[] =>
  (query(g(), q) as Record<string, unknown>[]).map((r) => JSON.stringify(r)).sort();

describe('a far-end filter is carried and matches the oracle', () => {
  test('a clause WHERE on the far end', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 RETURN v.k AS n')).toEqual(
      oracle((r) => r.n === 2),
    );
  });

  test('a clause WHERE matching nothing', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 99 RETURN v.k AS n')).toEqual([]);
  });

  test('a clause WHERE matching everything', () => {
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k >= 0 RETURN v.k AS n')).toEqual(oracle(() => true));
  });

  test('an inline PROPERTY on the far end', () => {
    expect(got('MATCH (u:P)-[:E]->(v {k: 2}) RETURN v.k AS n')).toEqual(oracle((r) => r.n === 2));
  });

  test('an inline WHERE on the far end', () => {
    expect(got('MATCH (u:P)-[:E]->(v WHERE v.k = 2) RETURN v.k AS n')).toEqual(
      oracle((r) => r.n === 2),
    );
  });

  test('the THREE spellings of one question agree', () => {
    // This is the property the repo is named after, and the reason the inline form had to be
    // carried too: making only the clause form fast would have widened the gap, not closed it.
    const clause = got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 RETURN v.k AS n');
    const inlineProp = got('MATCH (u:P)-[:E]->(v {k: 2}) RETURN v.k AS n');
    const inlineWhere = got('MATCH (u:P)-[:E]->(v WHERE v.k = 2) RETURN v.k AS n');

    expect(inlineProp).toEqual(clause);
    expect(inlineWhere).toEqual(clause);
  });

  test('a far LABEL beside a far filter', () => {
    // Only `b` carries `:Q`, and its k is 2.
    expect(got('MATCH (u:P)-[:E]->(v:Q) WHERE v.k = 2 RETURN v.k AS n')).toEqual(['{"n":2}']);
    expect(got('MATCH (u:P)-[:E]->(v:Q) WHERE v.k = 3 RETURN v.k AS n')).toEqual([]);
  });

  test('an inline property AND a clause WHERE together', () => {
    expect(got("MATCH (u:P)-[:E]->(v {tag: 'y'}) WHERE v.k = 2 RETURN v.k AS n")).toEqual([
      '{"n":2}',
    ]);
  });

  test('a $param in an inline property resolves per execution', () => {
    const graph = g();

    expect(
      query(graph, 'MATCH (u:P)-[:E]->(v {k: $want}) RETURN v.k AS n', { want: 3 }),
    ).toHaveLength(2);
    expect(query(graph, 'MATCH (u:P)-[:E]->(v {k: $want}) RETURN v.k AS n', { want: 99 })).toEqual(
      [],
    );
  });

  test('a clause WHERE reading BOTH ends is carried', () => {
    // It reads the far end, so it qualifies; the start is bound per vertex for it. The oracle
    // here needs BOTH columns, and a projection reading `u` declines the fast path — so this
    // compares the fast path against the general one, filtered in JS. (Written first as
    // `oracle(...).slice(0, 1)`, which was simply the wrong count: two edges leave `a`.)
    const both = (
      query(g(), 'MATCH (u:P)-[:E]->(v) RETURN u.k AS uk, v.k AS vk') as {
        uk: number;
        vk: number;
      }[]
    )
      .filter((r) => r.vk === 2 && r.uk === 1)
      .map((r) => JSON.stringify({ n: r.vk }))
      .sort();

    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 AND u.k = 1 RETURN v.k AS n')).toEqual(both);
    expect(both).toHaveLength(2);
  });

  test('the INCOMING direction', () => {
    expect(got('MATCH (u:P)<-[:E]-(v) WHERE v.k = 1 RETURN v.k AS n')).toEqual([
      '{"n":1}',
      '{"n":1}',
    ]);
  });
});

describe('shapes that must decline, and still answer', () => {
  test('a clause WHERE reading only the START declines to the seed pre-filter', () => {
    // Item 154's pre-filter evaluates such a predicate once per start VERTEX and skips the
    // expansion; carrying it here would evaluate it per EDGE. The boundary is a measured
    // choice, and the ANSWER must be identical either way.
    expect(got('MATCH (u:P)-[:E]->(v) WHERE u.k = 1 RETURN v.k AS n')).toEqual([
      '{"n":2}',
      '{"n":2}',
    ]);
  });

  test('a CORRELATED inline property declines', () => {
    // `(v {k: u.k})` needs the start bound to evaluate the VALUE, which is the correlation
    // problem of items 121-123. It must decline and still answer: no edge here joins two
    // vertices with equal k.
    expect(got('MATCH (u:P)-[:E]->(v {k: u.k}) RETURN v.k AS n')).toEqual([]);
  });

  test('a correlated inline property that DOES match', () => {
    const graph = new Graph();
    const x = graph.addVertex({ id: 'x', labels: ['P'], properties: { k: 7 } });
    const y = graph.addVertex({ id: 'y', labels: ['P'], properties: { k: 7 } });

    graph.addEdge({ from: x, to: y, labels: ['E'], properties: {} });

    expect(query(graph, 'MATCH (u:P)-[:E]->(v {k: u.k}) RETURN v.k AS n')).toEqual([{ n: 7 }]);
  });

  test('an inline WHERE on the far end reading the START declines', () => {
    expect(got('MATCH (u:P)-[:E]->(v WHERE v.k = u.k) RETURN v.k AS n')).toEqual([]);
  });

  test('a projection reading the START declines and still answers', () => {
    // The projection guard allows only the far variable, so this takes the general path.
    expect(got('MATCH (u:P)-[:E]->(v) WHERE v.k = 2 RETURN u.k AS n')).toEqual([
      '{"n":1}',
      '{"n":1}',
    ]);
  });
});

describe('a carried filter faults exactly where the general path does', () => {
  // Items 139/142: a fast path may not evaluate an expression on an element the general path
  // never reaches, nor skip one it does. The carried predicate runs once per row after both
  // endpoints are bound — the general path's own point — so the faulting rows are the same.
  const faulting = (): Graph => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { st: '1' } });
    const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { st: 'zzz' } });

    graph.addEdge({ from: a, to: b, labels: ['E'], properties: {} });

    return graph;
  };

  test('a faulting far predicate raises', () => {
    expect(() =>
      query(faulting(), 'MATCH (u:P)-[:E]->(v) WHERE CAST(v.st AS INTEGER) > 0 RETURN v.st AS n'),
    ).toThrow();
  });

  test('a faulting predicate on a far end NO edge reaches does not raise', () => {
    // `b` is the only landing node and it faults; make the only edge land on a clean node
    // instead, leaving the faulting vertex unreached. The general path never evaluates it, so
    // neither may the fast path.
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { st: '1' } });

    graph.addVertex({ id: 'bad', labels: ['P'], properties: { st: 'zzz' } });
    graph.addEdge({ from: a, to: a, labels: ['E'], properties: {} });

    expect(
      query(graph, 'MATCH (u:P)-[:E]->(v) WHERE CAST(v.st AS INTEGER) > 0 RETURN v.st AS n'),
    ).toEqual([{ n: '1' }]);
  });
});
