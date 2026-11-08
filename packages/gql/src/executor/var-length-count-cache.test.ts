// The CSR behind a bounded var-length count is cached ACROSS queries, keyed on
// `graph.topologyVersion` plus the direction and edge types the query names (item 1676).
//
// ⚠️ EVERY TEST HERE IS AN INVALIDATION TEST, AND THE SUITE THAT ALREADY EXISTED CANNOT BE. A cache
// that never invalidates returns the right answer for every read-only query ever written, so the
// 4,254 tests in this package all passed on the first build of this cache and would have passed on
// one with no invalidation at all. The failure mode is "query, write, query", and it needs its own
// file.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../index.js';

const countOf = (g: Graph, q: string): number => Number(query(g, q)[0].c);

const CHAIN2 = 'MATCH (x:P)-[:E]->{1,2}(y:P) RETURN count(*) AS c';

/** `a -> b -> c`, so a `{1,2}` walk counts 2 one-hops plus 1 two-hop = 3. */
const chain = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3 } });

  g.addEdge({ id: 'e-ab', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e-bc', from: b, to: c, labels: ['E'], properties: {} });

  return g;
};

describe('a write between two identical queries', () => {
  test('an added edge is seen by the second query', () => {
    const g = chain();

    expect(countOf(g, CHAIN2)).toBe(3);

    const a = g.getVertexById('a')!;
    const c = g.getVertexById('c')!;

    // `c -> a` closes the triangle: 3 one-hops, and 3 two-hops (a->b->c, b->c->a, c->a->b).
    g.addEdge({ id: 'e-ca', from: c, to: a, labels: ['E'], properties: {} });

    expect(countOf(g, CHAIN2)).toBe(6);
  });

  test('a removed edge is seen by the second query', () => {
    const g = chain();

    expect(countOf(g, CHAIN2)).toBe(3);

    g.removeEdge(g.getEdgeById('e-bc')!);

    // Only `a -> b` is left: one one-hop, no two-hop.
    expect(countOf(g, CHAIN2)).toBe(1);
  });

  test('an added vertex and edge are seen by the second query', () => {
    const g = chain();

    expect(countOf(g, CHAIN2)).toBe(3);

    const c = g.getVertexById('c')!;
    const d = g.addVertex({ id: 'd', labels: ['P'], properties: { n: 4 } });
    g.addEdge({ id: 'e-cd', from: c, to: d, labels: ['E'], properties: {} });

    // 3 one-hops, 2 two-hops (a->b->c, b->c->d).
    expect(countOf(g, CHAIN2)).toBe(5);
  });

  /**
   * ⚠️ A REMOVED VERTEX IS THE CASE `vertexCount`/`edgeCount` COULD NOT CATCH, which is why the key
   * is a version rather than a pair of counts: a delete plus an add leaves both counts where they
   * were while the topology differs. Here the delete also shifts the CSR's vertex NUMBERING, since
   * it numbers by `verticesById` iteration order.
   */
  test('a removed vertex is seen by the second query', () => {
    const g = chain();

    expect(countOf(g, CHAIN2)).toBe(3);

    g.removeVertex(g.getVertexById('b')!);

    // Removing `b` takes both edges with it.
    expect(countOf(g, CHAIN2)).toBe(0);
  });

  /**
   * ⚠️ THE CASE THAT MADE ITEM 1675 NECESSARY, and the one a four-site counter got wrong. `nbr` is
   * built from a TYPE-FILTERED adjacency, and the adjacency boxes are keyed BY EDGE TYPE, so
   * `addLabelToEdge` moves an edge into the `E` bucket without touching `insertEdge`, `edgesById`,
   * or the vertex set. A cache whose key ignored that would answer 3 here forever.
   */
  test('⚠️ an edge GAINING the queried type is seen by the second query', () => {
    const g = chain();
    const a = g.getVertexById('a')!;
    const c = g.getVertexById('c')!;

    // Added as `F`, so the `:E` walk cannot see it yet.
    g.addEdge({ id: 'e-ca', from: c, to: a, labels: ['F'], properties: {} });
    expect(countOf(g, CHAIN2)).toBe(3);

    g.addLabelToEdge('E', g.getEdgeById('e-ca')!);

    expect(countOf(g, CHAIN2)).toBe(6);
  });

  test('⚠️ an edge LOSING the queried type is seen by the second query', () => {
    const g = chain();

    g.addLabelToEdge('F', g.getEdgeById('e-bc')!);
    expect(countOf(g, CHAIN2)).toBe(3);

    g.removeLabelFromEdge('E', g.getEdgeById('e-bc')!);

    expect(countOf(g, CHAIN2)).toBe(1);
  });
});

describe('the shape is part of the key, not just the topology', () => {
  /**
   * `nbr` is DIRECTION-filtered, so the two spellings need different neighbour arrays from the same
   * topology. On this fixture both happen to count 3, so the asymmetric case is the one that tests
   * it: a single edge counted outward from `a` and inward from `b`.
   */
  test('an inward walk does not read the outward CSR', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['Q'], properties: {} });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    // Out of a `:P` into a `:Q` — one hop exists.
    expect(countOf(g, 'MATCH (x:P)-[:E]->{1,2}(y:Q) RETURN count(*) AS c')).toBe(1);
    // Out of a `:Q` there is nothing; INTO a `:Q` there is one.
    expect(countOf(g, 'MATCH (x:Q)-[:E]->{1,2}(y:P) RETURN count(*) AS c')).toBe(0);
    expect(countOf(g, 'MATCH (x:Q)<-[:E]-{1,2}(y:P) RETURN count(*) AS c')).toBe(1);
  });

  test('a different edge type does not read another type’s CSR', () => {
    const g = chain();
    const a = g.getVertexById('a')!;
    const c = g.getVertexById('c')!;

    g.addEdge({ id: 'e-ca', from: c, to: a, labels: ['F'], properties: {} });

    // `:E` is the two-edge chain; `:F` is the single `c -> a`.
    expect(countOf(g, CHAIN2)).toBe(3);
    expect(countOf(g, 'MATCH (x:P)-[:F]->{1,2}(y:P) RETURN count(*) AS c')).toBe(1);
    // And back again, so an alternating workload cannot serve one from the other.
    expect(countOf(g, CHAIN2)).toBe(3);
  });
});

describe('what the cache must NOT hold', () => {
  /**
   * ⚠️ THE ENDPOINT PREDICATE IS NOT CACHEABLE AND IS NOT CACHED. A property write does not bump
   * `topologyVersion` — deliberately, so that a `SET` does not throw the adjacency away — so if the
   * `passes` vector were cached alongside the CSR it would go stale here with no signal to catch it.
   * It is recomputed per call.
   */
  test('a property write changes the answer even though the topology did not', () => {
    const g = chain();
    const q = 'MATCH (x:P)-[:E]->{1,2}(y:P WHERE y.n > 2) RETURN count(*) AS c';

    // Only `c` has n > 2, reached by a->b->c and b->c.
    expect(countOf(g, q)).toBe(2);

    g.getVertexById('b')!.setProperty('n', 99);

    // Now `b` passes too: a->b, a->b->c, b->c.
    expect(countOf(g, q)).toBe(3);
  });

  /**
   * A vertex label write does not bump the signal either, and must not need to: the CSR numbers
   * every vertex regardless of label, so no label change can move `off`/`nbr`. What a label change
   * CAN move is which vertices the pattern selects, and that is read per call.
   */
  test('a vertex label write changes the answer even though the CSR did not', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['X'], properties: {} });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect(countOf(g, 'MATCH (x:P)-[:E]->{1,2}(y:P) RETURN count(*) AS c')).toBe(0);

    g.addLabelToVertex('P', b);

    expect(countOf(g, 'MATCH (x:P)-[:E]->{1,2}(y:P) RETURN count(*) AS c')).toBe(1);
  });
});

describe('transactions', () => {
  test('a committed write is seen by the next query', () => {
    const g = chain();

    expect(countOf(g, CHAIN2)).toBe(3);

    g.transaction(() => {
      const a = g.getVertexById('a')!;
      const c = g.getVertexById('c')!;
      g.addEdge({ id: 'e-ca', from: c, to: a, labels: ['E'], properties: {} });
    });

    expect(countOf(g, CHAIN2)).toBe(6);
  });

  /**
   * ⚠️ A ROLLBACK MUST NOT LEAVE THE PRE-TRANSACTION CACHE ENTRY SERVING THE POST-ROLLBACK GRAPH,
   * and it does not, because the undo log replays inverse operations through the same public
   * mutators and so bumps the version again. The entry is rebuilt rather than restored, which
   * over-invalidates by one build and cannot under-invalidate.
   */
  test('a rolled-back write leaves the next query correct', () => {
    const g = chain();

    expect(countOf(g, CHAIN2)).toBe(3);

    expect(() =>
      g.transaction(() => {
        const a = g.getVertexById('a')!;
        const c = g.getVertexById('c')!;
        g.addEdge({ id: 'e-ca', from: c, to: a, labels: ['E'], properties: {} });

        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    expect(countOf(g, CHAIN2)).toBe(3);
  });
});

describe('the per-shape map is capped', () => {
  /**
   * ⚠️ THE CAP IS THE ONE PART NO KEY MUTANT CAN REACH, because clearing a cache can only ever
   * cost a rebuild — it cannot return a wrong answer. So the property to pin is that crossing the
   * cap does not BREAK anything: more distinct shapes than the cap, each queried twice, with no
   * write between them, and every answer still correct.
   */
  test('more distinct edge types than the cap still answer correctly', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const types = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'TA', 'TB'];

    // One edge per type, so each type's `{1,2}` walk counts exactly 1.
    types.forEach((t, i) => {
      g.addEdge({ id: `e${i}`, from: a, to: b, labels: [t], properties: {} });
    });

    const ask = (t: string): number =>
      countOf(g, `MATCH (x:P)-[:${t}]->{1,2}(y:P) RETURN count(*) AS c`);

    // First pass fills past the cap; second pass reads back whatever survived.
    for (const t of types) {
      expect(ask(t)).toBe(1);
    }

    for (const t of types) {
      expect(ask(t)).toBe(1);
    }
  });
});

describe('two graphs do not share an entry', () => {
  test('a second graph with a different topology gets its own CSR', () => {
    const g1 = chain();
    const g2 = chain();

    g2.removeEdge(g2.getEdgeById('e-bc')!);

    expect(countOf(g1, CHAIN2)).toBe(3);
    expect(countOf(g2, CHAIN2)).toBe(1);
    // Interleaved, in case the cache were keyed on anything but the graph identity.
    expect(countOf(g1, CHAIN2)).toBe(3);
    expect(countOf(g2, CHAIN2)).toBe(1);
  });
});
