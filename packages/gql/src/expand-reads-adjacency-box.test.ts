import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * `expand` reads the vertex's CACHED adjacency box rather than hashing its id into the graph's map
 * (item 1618) — 1.14x on a two-hop projection, 1.19x on its filtered twin, 1.08x on a one-hop one.
 *
 * `Vertex.adjFrom`/`adjTo` memoize the same `Map` object the graph holds, and `adjacency-box.test.ts`
 * in `@lenke/core` states the purpose: "every consumer that already holds the vertex object stops
 * hashing (audit items 162, 321)". Those items priced the three ways over 200,000 vertices — a
 * string key at **59.7 ns**, a `Map` keyed on the vertex object 30.5, a `WeakMap` 43.8, a cached
 * reference **16.1**. The Gremlin engine has read the box for ages; this is the GQL side adopting it.
 *
 * ⚠️ WHAT THIS FILE IS FOR: a cache over graph-owned state is wrong only on the SECOND read, so a
 * test that builds a graph and queries it once cannot see any of the four ways it fails.
 * `adjacency-box.test.ts` covers those four at the `@lenke/core` level by reading the box directly.
 * This file covers them THROUGH A GQL QUERY, because the GQL matcher is now a consumer of that
 * contract and a core-level test says nothing about whether `expand` reads the box correctly.
 *
 * It also pins the two things the change must not alter: `both` de-duplicating a self-loop, and
 * O(1) lookup BY ID (`getVertexById` is untouched — the box is the same object the id-keyed map
 * returns).
 */
const vertex = (g: Graph, id: string): Vertex => g.getVertexById(id) as Vertex;

describe('`expand` through the cached adjacency box', () => {
  test('a ZERO-DEGREE vertex picks up its first edge — the absence must not be cached', () => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    // Query BEFORE any edge exists, which is the read that could cache `undefined`.
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 0 }]);

    g.addEdge({
      id: 'e',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });

    // A cache that had stored the absence would still answer 0 here.
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN y.id AS id')).toEqual([{ id: 'b' }]);
  });

  test('a box read once tracks LATER edges on the same vertex', () => {
    const g = new Graph();

    for (const id of ['a', 'b', 'c']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    g.addEdge({
      id: 'e1',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });
    expect(query(g, "MATCH (x:N {id: 'a'})-[:E]->(y:N) RETURN count(*) AS c")).toEqual([{ c: 1 }]);

    g.addEdge({
      id: 'e2',
      from: vertex(g, 'a'),
      to: vertex(g, 'c'),
      labels: ['E'],
      properties: {},
    });
    // The box is the SAME Map the graph mutates, so the second edge must be visible without any
    // invalidation step.
    expect(query(g, "MATCH (x:N {id: 'a'})-[:E]->(y:N) RETURN y.id AS id ORDER BY id")).toEqual([
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  test('a NEW edge TYPE on a vertex whose box was already read', () => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    g.addEdge({
      id: 'e1',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });
    expect(query(g, 'MATCH (x:N)-[:F]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 0 }]);

    g.addEdge({
      id: 'e2',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['F'],
      properties: {},
    });
    // A per-TYPE bucket that did not exist when the box was first read.
    expect(query(g, 'MATCH (x:N)-[:F]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('a DELETED edge disappears from a box that was already read', () => {
    const g = new Graph();

    for (const id of ['a', 'b', 'c']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    for (const [i, to] of ['b', 'c'].entries()) {
      g.addEdge({
        id: `e${i}`,
        from: vertex(g, 'a'),
        to: vertex(g, to),
        labels: ['E'],
        properties: {},
      });
    }

    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 2 }]);

    // ⚠️ `removeEdge` takes the EDGE, not its id (`removeVertex` takes either). Passing the id
    // throws inside the graph rather than returning null, which is how this slip surfaced.
    g.removeEdge(g.getEdgeById('e0')!);

    // The removal mutates the same Map, so a read-through box sees it. This is the direction a
    // stale cache fails SILENTLY — an extra row, not a missing one.
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN y.id AS id')).toEqual([{ id: 'c' }]);
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 1 }]);

    g.removeEdge(g.getEdgeById('e1')!);
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 0 }]);
  });

  test('the IN direction, which reads the other box', () => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    expect(query(g, 'MATCH (x:N)<-[:E]-(y:N) RETURN count(*) AS c')).toEqual([{ c: 0 }]);

    g.addEdge({
      id: 'e',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });

    expect(query(g, 'MATCH (x:N)<-[:E]-(y:N) RETURN x.id AS x, y.id AS y')).toEqual([
      { x: 'b', y: 'a' },
    ]);
  });

  test('⚠️ `both` still de-duplicates a SELF-LOOP, which is indexed in both boxes', () => {
    /**
     * A self-loop sits under `adjFrom` AND `adjTo` for the same vertex, so an undirected walk would
     * yield it twice. `expand` drops the duplicate on the in-pass, and that logic is untouched by
     * reading the box instead of the map — but it is the one place where swapping the SOURCE of the
     * two sets could have changed which edges collide.
     */
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['N'], properties: { id: 'a' } });
    g.addVertex({ id: 'b', labels: ['N'], properties: { id: 'b' } });
    g.addEdge({
      id: 'loop',
      from: vertex(g, 'a'),
      to: vertex(g, 'a'),
      labels: ['E'],
      properties: {},
    });
    g.addEdge({
      id: 'e',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });

    // From `a`: the self-loop ONCE plus `b`. Directed `in` keeps the loop, so that is 1.
    expect(query(g, "MATCH (x:N {id: 'a'})-[:E]-(y:N) RETURN y.id AS id ORDER BY id")).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(query(g, "MATCH (x:N {id: 'a'})<-[:E]-(y:N) RETURN count(*) AS c")).toEqual([{ c: 1 }]);
  });

  test('a MULTI-TYPE label expression, which takes the slow arm and dedupes across buckets', () => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    // One edge carrying BOTH types, so the per-bucket dedupe is load-bearing: it appears in the `E`
    // bucket and in the `F` bucket and must be emitted once.
    g.addEdge({
      id: 'e',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E', 'F'],
      properties: {},
    });

    expect(query(g, 'MATCH (x:N)-[:E|F]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('⚠️ a plain DELETE refuses a vertex with ONLY IN-edges', () => {
    /**
     * `hasIncidentEdges` reads BOTH boxes, and the mutant that dropped `adjTo` SURVIVED item 1618's
     * mutation pass across the whole `gql` and `core` suites — nothing deleted a vertex whose edges
     * all point AT it. That is a silent wrong answer, not a slow path: a plain `DELETE` would orphan
     * the relationships that `DETACH DELETE` exists to remove.
     *
     * Both directions are asserted, because a test on the out-edge side alone is what left the hole.
     */
    const build = (): Graph => {
      const g = new Graph();

      for (const id of ['src', 'sink']) {
        g.addVertex({ id, labels: ['N'], properties: { id } });
      }

      g.addEdge({
        id: 'e',
        from: vertex(g, 'src'),
        to: vertex(g, 'sink'),
        labels: ['E'],
        properties: {},
      });

      return g;
    };

    // `sink` has ONLY an in-edge. A plain DELETE must refuse it.
    expect(() => query(build(), "MATCH (n:N {id: 'sink'}) DELETE n")).toThrow();
    // `src` has only an out-edge — the direction a test would cover by accident.
    expect(() => query(build(), "MATCH (n:N {id: 'src'}) DELETE n")).toThrow();

    // And DETACH removes either, which is what says the refusal above is the guard and not a
    // general inability to delete.
    const a = build();

    expect(query(a, "MATCH (n:N {id: 'sink'}) DETACH DELETE n RETURN count(*) AS c")).toEqual([
      { c: 1 },
    ]);
    expect(query(a, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 0 }]);

    const b = build();

    expect(query(b, "MATCH (n:N {id: 'src'}) DETACH DELETE n RETURN count(*) AS c")).toEqual([
      { c: 1 },
    ]);
  });

  test('O(1) lookup BY ID is untouched — the box is the same object that map returns', () => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    g.addEdge({
      id: 'e',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });

    expect(g.getVertexById('a')?.id).toBe('a');
    expect(g.getEdgeById('e')?.id).toBe('e');
    // Asserted as IDENTITY, not equality: a copy of the box would still pass a deep comparison and
    // would then go stale on the next write.
    expect(vertex(g, 'a').adjFrom).toBe(g.edgesFromByLabel.get('a'));
    expect(vertex(g, 'b').adjTo).toBe(g.edgesToByLabel.get('b'));
  });

  test('a vertex REMOVED and re-added reads the live maps', () => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['N'], properties: { id } });
    }

    g.addEdge({
      id: 'e',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 1 }]);

    g.removeVertex('a');
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 0 }]);

    g.addVertex({ id: 'a', labels: ['N'], properties: { id: 'a' } });
    g.addEdge({
      id: 'e2',
      from: vertex(g, 'a'),
      to: vertex(g, 'b'),
      labels: ['E'],
      properties: {},
    });
    // The re-added vertex is a NEW object, so this is really about the graph's maps — but it is the
    // fourth of the four ways the cache can fail and the cheapest place to pin it.
    expect(query(g, 'MATCH (x:N)-[:E]->(y:N) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });
});
