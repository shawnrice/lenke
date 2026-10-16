import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 492: a correlated one-hop `EXISTS` reads the vertex's own adjacency BOX instead of
// hashing its id into the graph's map, and answers an UNCONSTRAINED endpoint from a bucket SIZE
// rather than by iterating edges. 87.8 -> 68.8 ms at 200,000 nodes over 1,000,000 edges.
//
// The oracle is the same question asked another way: a hop count, or the `COUNT { … } > 0`
// spelling, which goes through a different path.
const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b' } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 'c' } });

  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 'lonely' } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: { w: 1 } });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['S'], properties: { w: 2 } });

  return g;
};

const keys = (g: Graph, q: string): string[] => query<{ k: string }>(g, q).map((r) => r.k);

describe('the one-hop EXISTS degree path (item 492)', () => {
  test('DIRECTION selects: out-edges and in-edges are different questions', () => {
    const g = build();

    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)<-[:T]-(x) } RETURN n.k AS k')).toEqual([
      'b',
    ]);
  });

  test('the edge TYPE selects', () => {
    const g = build();

    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:S]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:NOPE]->(x) } RETURN n.k AS k')).toEqual(
      [],
    );
    // Untyped: any edge at all.
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
  });

  test('a far LABEL, a far CONSTRAINT and a sub-WHERE each still apply', () => {
    const g = build();

    // These leave the `free` shortcut and visit edges, which is the branch the size read skips.
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:S]->(x:Q) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:S]->(x:P) } RETURN n.k AS k')).toEqual(
      [],
    );
    expect(
      keys(g, "MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x {k: 'b'}) } RETURN n.k AS k"),
    ).toEqual(['a']);
    expect(
      keys(g, "MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) WHERE x.k = 'zzz' } RETURN n.k AS k"),
    ).toEqual([]);
  });

  test('a rel VARIABLE declines the degree path — a sub-WHERE can read it', () => {
    const g = build();

    // The shape refuses a named rel, and this is what that guard protects: the degree probe
    // binds only the far node, so a sub-`WHERE` reading `r` would be evaluated with `r`
    // unbound. `w = 1` holds for the `T` edge and not the `S` one, so a path that ignored the
    // predicate would answer differently.
    expect(
      keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[r:T]->(x) WHERE r.w = 1 } RETURN n.k AS k'),
    ).toEqual(['a']);
    expect(
      keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[r:T]->(x) WHERE r.w = 99 } RETURN n.k AS k'),
    ).toEqual([]);
    // And with no predicate on it, a named rel is just a name — same answer either way.
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[r:T]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
  });

  test('a zero-degree vertex is FALSE, and agrees with the count spelling', () => {
    const g = build();

    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual(
      keys(g, 'MATCH (n:P) WHERE COUNT { MATCH (n)-[:T]->(x) } > 0 RETURN n.k AS k'),
    );
    // `lonely` has no edges at all, so its adjacency box does not exist — the branch that
    // returns FALSE before any bucket is read.
    expect(keys(g, 'MATCH (n:P) WHERE NOT EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual(
      ['b', 'lonely'],
    );
  });

  test('removing the only edge of a type makes EXISTS false again', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b' } });
    const e = g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });

    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    // `deIndexEdgeLabel` deletes the per-type entry when it empties, so this passes whether the
    // shortcut reads a SIZE or asks `has` — the mutant swapping them survives, and that is
    // recorded at the call site rather than implied by this test's name.
    g.removeEdge(e);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual([]);
  });

  test('a SELF-LOOP satisfies EXISTS in both directions', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });

    g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)<-[:T]-(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
  });

  test('a multi-TYPE edge counts for each of its types', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b' } });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['T', 'S'], properties: {} });
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:S]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
    expect(keys(g, 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:T|S]->(x) } RETURN n.k AS k')).toEqual([
      'a',
    ]);
  });
});
