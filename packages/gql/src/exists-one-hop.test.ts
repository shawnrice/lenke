import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `EXISTS { (a)-[:T]->(b) }` from a bound `a` now walks the adjacency directly and returns at
// the first accepted endpoint, instead of running the whole matcher to take one `next()`
// (audit item 155). `existsReachable` already did this for the QUANTIFIED spellings (`->+`,
// `->*`) and declined a plain hop, which is the commonest shape there is.
//
// The fast path has to agree with the general one on every endpoint constraint, so each
// constraint gets a test where it CHANGES the answer: a label that excludes some neighbours,
// inline props, an endpoint predicate, and the subquery's own WHERE. A fixture where every
// neighbour qualifies cannot tell a working endpoint test from a missing one.
const g = (): Graph => {
  const graph = new Graph();
  // `id` is carried as a PROPERTY as well as the external id, because a GQL query reads
  // properties and the external id is not `u.id`.
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { id: 'a', k: 1 } });
  const b = graph.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { id: 'b', k: 2 } });
  const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { id: 'c', k: 3 } });
  const lonely = graph.addVertex({
    id: 'lonely',
    labels: ['P'],
    properties: { id: 'lonely', k: 4 },
  });

  // a -E-> b, a -E-> c, b -F-> c. `lonely` has nothing.
  graph.addEdge({ from: a, to: b, labels: ['E'], properties: { w: 10 } });
  graph.addEdge({ from: a, to: c, labels: ['E'], properties: { w: 20 } });
  graph.addEdge({ from: b, to: c, labels: ['F'], properties: { w: 30 } });

  void lonely;

  return graph;
};

const ids = (q: string): string[] => (query(g(), q) as { n: string }[]).map((r) => r.n).sort();

describe('a one-hop EXISTS agrees with the general path', () => {
  test('an unconstrained endpoint', () => {
    // a has two E out-edges, b has none (its only out-edge is F).
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->() } RETURN u.id AS n')).toEqual(['a']);
  });

  test('an untyped edge', () => {
    // No type filter: a and b both have an out-edge.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[]->() } RETURN u.id AS n')).toEqual(['a', 'b']);
  });

  test('the INCOMING direction', () => {
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)<-[:E]-() } RETURN u.id AS n')).toEqual(['b', 'c']);
  });

  test('NOT EXISTS is the complement', () => {
    expect(ids('MATCH (u:P) WHERE NOT EXISTS { (u)-[:E]->() } RETURN u.id AS n')).toEqual([
      'b',
      'c',
      'lonely',
    ]);
  });

  test('a vertex with NO edges at all', () => {
    expect(ids('MATCH (u:P) WHERE NOT EXISTS { (u)-[]->() } RETURN u.id AS n')).toEqual([
      'c',
      'lonely',
    ]);
  });

  test('an endpoint LABEL excludes neighbours', () => {
    // Only b carries :Q, so `a` qualifies via a->b but nothing else does. Without the label
    // test every neighbour would qualify and `a` would still be the answer — so the NEGATIVE
    // case is the one that matters, and it is the `:Z` row below.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x:Q) } RETURN u.id AS n')).toEqual(['a']);
  });

  test('an endpoint label matching NOTHING', () => {
    // The row that fails if the endpoint test is skipped: `:Z` is on no vertex, so no outer
    // vertex qualifies — but `a` has E-edges, so a fast path that answered "any edge" says `a`.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x:Z) } RETURN u.id AS n')).toEqual([]);
  });

  test('endpoint INLINE PROPS are applied', () => {
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x {k: 3}) } RETURN u.id AS n')).toEqual([
      'a',
    ]);
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x {k: 99}) } RETURN u.id AS n')).toEqual([]);
  });

  test("the endpoint's inline PREDICATE is applied", () => {
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x WHERE x.k > 2) } RETURN u.id AS n'),
    ).toEqual(['a']);
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x WHERE x.k > 90) } RETURN u.id AS n'),
    ).toEqual([]);
  });

  test("the subquery's own WHERE is applied", () => {
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x) WHERE x.k = 2 } RETURN u.id AS n'),
    ).toEqual(['a']);
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x) WHERE x.k = 42 } RETURN u.id AS n'),
    ).toEqual([]);
  });

  test('the subquery WHERE may read the OUTER binding', () => {
    // `u.k` comes from outside the subquery. Only a (k=1) has an E-neighbour whose k exceeds
    // it by one... a->b is k=2, so a qualifies; nothing else does.
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(x) WHERE x.k = u.k + 1 } RETURN u.id AS n'),
    ).toEqual(['a']);
  });
});

describe('shapes the fast path must decline', () => {
  // Each of these is refused by a guard, and each must still answer correctly through the
  // general path. A guard that wrongly ACCEPTED one of them would give a wrong answer here.
  test('an edge VARIABLE (the WHERE can read it)', () => {
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[r:E]->(x) WHERE r.w = 20 } RETURN u.id AS n'),
    ).toEqual(['a']);
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[r:E]->(x) WHERE r.w = 99 } RETURN u.id AS n'),
    ).toEqual([]);
  });

  test('an edge inline PROPERTY', () => {
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E {w: 10}]->(x) } RETURN u.id AS n')).toEqual([
      'a',
    ]);
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E {w: 77}]->(x) } RETURN u.id AS n')).toEqual([]);
  });

  test('an UNDIRECTED hop', () => {
    // `both` is refused; undirected existence is the union of the two directions.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]-(x) } RETURN u.id AS n')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('a QUANTIFIED hop still goes through the reachability path', () => {
    // `existsReachable` owns this one; the new path must not intercept it.
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->+(x WHERE x.k = 3) } RETURN u.id AS n'),
    ).toEqual(['a']);
  });

  test('a TWO-hop subquery', () => {
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->()-[:F]->() } RETURN u.id AS n')).toEqual([
      'a',
    ]);
  });

  test('a two-PATTERN subquery', () => {
    // Two comma-separated patterns, so `sub.patterns.length !== 1` declines.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u)-[:E]->(), (z:Q) } RETURN u.id AS n')).toEqual(['a']);
  });

  test('a subquery whose start is NOT the outer variable', () => {
    // Nothing binds `w` from outside, so the start is unbound and the guard declines. The
    // subquery is then an existence test over the whole graph: true for every outer row.
    expect(ids('MATCH (u:P) WHERE EXISTS { (w:P)-[:E]->() } RETURN u.id AS n')).toEqual([
      'a',
      'b',
      'c',
      'lonely',
    ]);
  });
});

describe('COUNT and VALUE subqueries are untouched', () => {
  test('COUNT still counts every match, not just the first', () => {
    // The fast path answers EXISTENCE. If it were ever wired into COUNT, this would be 1.
    expect(query(g(), "MATCH (u:P {id: 'a'}) RETURN COUNT { (u)-[:E]->() } AS c")).toEqual([
      { c: 2 },
    ]);
  });

  test('COUNT with a zero answer', () => {
    expect(query(g(), "MATCH (u:P {id: 'lonely'}) RETURN COUNT { (u)-[:E]->() } AS c")).toEqual([
      { c: 0 },
    ]);
  });
});

describe('the subquery start node keeps its own constraints', () => {
  // The fast path tests the ENDPOINT, never the start — the start is already bound, so its
  // constraints are the guard's business. Dropping that guard leaves every other test here
  // green, so these are the ones with teeth for it.
  test('inline PROPS on the already-bound start are applied', () => {
    // `u` is bound to each P in turn; `(u {k: 1})` additionally demands k = 1, which only `a`
    // satisfies — and `a` is also the only one with an E-edge, so the NEGATIVE spelling below
    // is what actually discriminates.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u {k: 1})-[:E]->() } RETURN u.id AS n')).toEqual(['a']);
  });

  test('inline props on the start that NOTHING satisfies', () => {
    // Without the start test, `a` still has an E-edge and would wrongly qualify.
    expect(ids('MATCH (u:P) WHERE EXISTS { (u {k: 99})-[:E]->() } RETURN u.id AS n')).toEqual([]);
  });

  test('a PREDICATE on the already-bound start is applied', () => {
    expect(
      ids('MATCH (u:P) WHERE EXISTS { (u WHERE u.k > 90)-[:E]->() } RETURN u.id AS n'),
    ).toEqual([]);
    expect(ids('MATCH (u:P) WHERE EXISTS { (u WHERE u.k < 2)-[:E]->() } RETURN u.id AS n')).toEqual(
      ['a'],
    );
  });
});
