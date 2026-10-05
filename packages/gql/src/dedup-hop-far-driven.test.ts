import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `MATCH (a)-[:T]->(f) RETURN DISTINCT f.k ORDER BY x` asks for the distinct `f.k` over the far
// vertices REACHED. Walking edges pays one endpoint resolution each — ~180ns, which item 194
// measured as the whole of this shape's remaining 284.5ms over a million edges. Asked from the
// far end a vertex is reached exactly when it has an in-edge of the type, so it is ONE adjacency
// lookup per far vertex: 200,000 instead of 1,000,000, and 293.7ms becomes 90.4ms (item 195).
//
// Two runtime conditions, and the tests here exist mostly to pin what happens when they fail:
//
//   - the START side must be UNCONSTRAINED, because an in-edge says a far vertex is reached from
//     SOME source and cannot say the source matched a label. A vacuous start label — one every
//     vertex carries — is the case where that distinction does not exist.
//   - a SORT must impose the order, because first-seen order differs between the two walks and
//     that order is observable without one.

/** Every vertex carries `P`, so the start label is VACUOUS and the far-driven walk is allowed. */
const vacuous = (): Graph => {
  const g = new Graph();
  const v = (id: string, extra: string[], n: number) =>
    g.addVertex({ id, labels: ['P', ...extra], properties: { n } });

  const a = v('a', [], 1);
  const b = v('b', [], 2);
  const y = v('y', ['Q'], 30);
  const z = v('z', [], 20);

  v('unreached', [], 99); // no in-edges: must NOT appear

  // Inserted so that bucket order is not id order.
  g.addEdge({ from: b, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: y, to: y, labels: ['T'], properties: {} }); // self-loop
  g.addEdge({ from: b, to: a, labels: ['S'], properties: {} }); // another type

  return g;
};

const g = vacuous();

/** Forced to the general path by a dead `LET`, which the dedup walk declines entirely. */
const viaGeneral = (graph: Graph, q: string) => {
  const i = q.indexOf(' RETURN ');

  return query(graph, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

describe('the far-driven walk', () => {
  test('values and ORDER match the general path', () => {
    const q = 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
    // y (30) and z (20) are reached; `unreached` (99) and the sources a/b are not — except a,
    // which has only an S in-edge, so it is not reached by a T hop either.
    expect(query(g, q)).toEqual([{ x: 20 }, { x: 30 }]);
  });

  test('DESC is honoured', () => {
    const q = 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x DESC';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
    expect(query(g, q)).toEqual([{ x: 30 }, { x: 20 }]);
  });

  test('a far-end LABEL narrows the walked bucket', () => {
    const q = 'MATCH (a:P)-[:T]->(f:Q) RETURN DISTINCT f.n AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
    expect(query(g, q)).toEqual([{ x: 30 }]);
  });

  test('a clause WHERE over the far end is carried', () => {
    const q = 'MATCH (a:P)-[:T]->(f) WHERE f.n > 25 RETURN DISTINCT f.n AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
    expect(query(g, q)).toEqual([{ x: 30 }]);
  });

  test('a window pages the sorted rows', () => {
    expect(query(g, 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x LIMIT 1')).toEqual([
      { x: 20 },
    ]);
  });

  test('a far vertex with NO in-edges of the type never appears', () => {
    const rows = query(g, 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x') as Array<{
      x: number;
    }>;

    expect(rows.map((r) => r.x)).not.toContain(99);
    // `a` has an in-edge, but of type S — a bucket keyed by the wrong type must not count.
    expect(rows.map((r) => r.x)).not.toContain(1);
  });

  test('a self-loop reaches its own vertex', () => {
    // y->y means y is reached even with no other in-edge, which the far-driven walk sees as an
    // in-bucket of size one.
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['P'], properties: { n: 5 } });

    h.addEdge({ from: s, to: s, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x')).toEqual([
      { x: 5 },
    ]);
  });

  test('a REVERSED hop reads the mirror index', () => {
    const q = 'MATCH (a:P)<-[:T]-(f) RETURN DISTINCT f.n AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
    // Reversed, the "far" end is the SOURCE: a and b and y (the self-loop) are sources of T.
    expect(query(g, q)).toEqual([{ x: 1 }, { x: 2 }, { x: 30 }]);
  });

  describe('a NON-vacuous start label must exclude unmatched sources', () => {
    // The condition `vacuousLabel` protects, and the only test here that can fail by answering
    // TOO MUCH: `far` is reached only from a `B` vertex, so a walk that asked "has any in-edge"
    // would wrongly include it for a start label of `A`.
    const mixed = (): Graph => {
      const h = new Graph();
      const fromA = h.addVertex({ id: 'fromA', labels: ['A'], properties: { n: 1 } });
      const fromB = h.addVertex({ id: 'fromB', labels: ['B'], properties: { n: 2 } });
      const viaA = h.addVertex({ id: 'viaA', labels: ['Z'], properties: { n: 10 } });
      const viaB = h.addVertex({ id: 'viaB', labels: ['Z'], properties: { n: 20 } });

      h.addEdge({ from: fromA, to: viaA, labels: ['T'], properties: {} });
      h.addEdge({ from: fromB, to: viaB, labels: ['T'], properties: {} });

      return h;
    };

    test('only the far vertices reached FROM the labelled start appear', () => {
      const h = mixed();
      const q = 'MATCH (a:A)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x';

      expect(query(h, q)).toEqual(viaGeneral(h, q));
      // viaB (20) is reached only from a B vertex and must be absent.
      expect(query(h, q)).toEqual([{ x: 10 }]);
    });

    test('the mirror, from the B side', () => {
      const h = mixed();
      const q = 'MATCH (a:B)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x';

      expect(query(h, q)).toEqual([{ x: 20 }]);
    });

    test('an UNLABELLED start reaches both, since every vertex qualifies', () => {
      const h = mixed();
      const q = 'MATCH (a)-[:T]->(f) RETURN DISTINCT f.n AS x ORDER BY x';

      expect(query(h, q)).toEqual(viaGeneral(h, q));
      expect(query(h, q)).toEqual([{ x: 10 }, { x: 20 }]);
    });
  });

  describe('shapes that keep the start-driven walk', () => {
    test('no sort: the order is first-seen, which the far walk would change', () => {
      const q = 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.n AS x';

      expect(query(g, q)).toEqual(viaGeneral(g, q));
      // a is visited before b, and a's bucket is [y, z] — so 30 precedes 20, which is NOT the
      // far-bucket order the far-driven walk would produce.
      expect(query(g, q)).toEqual([{ x: 30 }, { x: 20 }]);
    });

    test('keyed on the START end', () => {
      const q = 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT a.n AS x ORDER BY x';

      expect(query(g, q)).toEqual(viaGeneral(g, q));
      expect(query(g, q)).toEqual([{ x: 1 }, { x: 2 }, { x: 30 }]);
    });

    test('an UNDIRECTED hop', () => {
      const q = 'MATCH (a:P)-[:T]-(f) RETURN DISTINCT f.n AS x ORDER BY x';

      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });

    test('a type DISJUNCTION', () => {
      const q = 'MATCH (a:P)-[:T|S]->(f) RETURN DISTINCT f.n AS x ORDER BY x';

      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });
  });
});
