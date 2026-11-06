import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { countsVisitsDirectly } from './executor/hop-projection.js';
import { query } from './index.js';

/**
 * `count(DISTINCT <far end>)` over a 1-hop counts the far-driven walk's visits DIRECTLY, with no
 * dedup set — **3.13x**, 6.923 to 2.209 ms at 50,000 vertices / 150,000 edges (item 1590).
 *
 * ⚠️ THE CLAIM THAT MAKES IT SOUND, and what these tests exist to check: `farDrivenFits` requires
 * `!onStart`, so the walk is keyed on the FAR end and iterates each candidate far vertex exactly
 * ONCE. A set can then only re-derive what the iteration already guaranteed. If that claim is wrong
 * for any shape, the count DOUBLE-COUNTS — so every fixture below is one where a far vertex is
 * reachable more than once, or where "has an incoming edge of this type" and "is reachable from a
 * qualifying start" could come apart.
 *
 * The oracle throughout is `count(DISTINCT b.id)`, which keys on a PROPERTY and therefore keeps the
 * dedup set — a different code path answering the same question, rather than the path under test.
 */
const rows = (g: Graph, q: string): Array<Record<string, unknown>> => query(g, q);
const one = (g: Graph, q: string): unknown => Object.values(rows(g, q)[0] ?? {})[0];

/** `b.id` is not a stored property, so the oracle counts distinct far ends a different way. */
const oracle = (g: Graph, pattern: string): unknown =>
  one(g, `MATCH ${pattern} RETURN count(DISTINCT b) AS c`);

describe('the far-driven count visits each far vertex once', () => {
  test('MANY edges into one far vertex count it ONCE', () => {
    const g = new Graph();
    const hub = g.addVertex({ id: 'hub', labels: ['P'], properties: {} });

    // Five distinct sources all pointing at `hub`: the shape that double-counts if the walk is
    // actually per-EDGE rather than per-far-vertex.
    for (let i = 0; i < 5; i += 1) {
      const src = g.addVertex({ id: `s${i}`, labels: ['P'], properties: {} });

      g.addEdge({ id: `e${i}`, from: src, to: hub, labels: ['E'] });
    }

    expect(one(g, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toBe(5);
    expect(oracle(g, '(a:P)-[:E]->(b)')).toBe(1);
  });

  test('PARALLEL edges between the same pair count the far vertex once', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
    g.addEdge({ id: 'e2', from: a, to: b, labels: ['E'] });
    g.addEdge({ id: 'e3', from: a, to: b, labels: ['E'] });

    expect(one(g, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toBe(3);
    expect(oracle(g, '(a:P)-[:E]->(b)')).toBe(1);
  });

  test('a SELF-LOOP counts its vertex once', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'self', from: a, to: a, labels: ['E'] });
    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });

    // Far ends are `a` (via the self-loop) and `b`.
    expect(oracle(g, '(a:P)-[:E]->(b)')).toBe(2);
  });

  test('ISOLATED vertices and vertices with only OTHER edge types are not counted', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addVertex({ id: 'lonely', labels: ['P'], properties: {} });

    const other = g.addVertex({ id: 'other', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
    // `other` has an incoming edge, but of the WRONG type — the per-type bucket must exclude it.
    g.addEdge({ id: 'x1', from: a, to: other, labels: ['OTHER'] });

    expect(oracle(g, '(a:P)-[:E]->(b)')).toBe(1);
  });

  test('an empty graph and a graph with no matching edges answer 0', () => {
    expect(oracle(new Graph(), '(a:P)-[:E]->(b)')).toBe(0);

    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    expect(oracle(g, '(a:P)-[:E]->(b)')).toBe(0);
  });
});

describe('direction and labels still select the right far ends', () => {
  const g = (): Graph => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = graph.addVertex({ id: 'b', labels: ['P', 'Q'], properties: {} });
    const c = graph.addVertex({ id: 'c', labels: ['P'], properties: {} });

    graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
    graph.addEdge({ id: 'e2', from: a, to: c, labels: ['E'] });
    graph.addEdge({ id: 'e3', from: b, to: c, labels: ['E'] });

    return graph;
  };

  test('an OUT hop counts in-adjacency; an IN hop counts out-adjacency', () => {
    // Out: far ends are b and c. In: `(a:P)<-[:E]-(b)` reads the other index, so the "far" ends are
    // the SOURCES — a and b.
    expect(oracle(g(), '(a:P)-[:E]->(b)')).toBe(2);
    expect(oracle(g(), '(a:P)<-[:E]-(b)')).toBe(2);
  });

  test('a FAR LABEL restricts the candidates', () => {
    // Only `b` carries Q, and it has an incoming E edge.
    expect(oracle(g(), '(a:P)-[:E]->(b:Q)')).toBe(1);
    // A label nothing carries.
    expect(oracle(g(), '(a:P)-[:E]->(b:ZZZ)')).toBe(0);
  });

  test('an untyped hop counts far ends across every edge type', () => {
    const graph = g();
    const a = graph.verticesById.get('a');

    if (a === undefined) {
      throw new Error('fixture lost vertex a');
    }

    const d = graph.addVertex({ id: 'd', labels: ['P'], properties: {} });

    graph.addEdge({ id: 'x1', from: a, to: d, labels: ['OTHER'] });

    expect(oracle(graph, '(a:P)-[:E]->(b)')).toBe(2);
    // ⚠️ `-->` is not this surface's spelling — it raises "a query must end in RETURN or FINISH",
    // which reads like a different mistake entirely. `-[]->` and `->` are the untyped forms, and
    // both are exercised here because they are two spellings of one question and must agree.
    expect(oracle(graph, '(a:P)-[]->(b)')).toBe(3);
    expect(oracle(graph, '(a:P)->(b)')).toBe(3);
  });
});

describe('the shapes that must KEEP the dedup set', () => {
  const g = (): Graph => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { k: 7 } });
    const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { k: 7 } });

    graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
    graph.addEdge({ id: 'e2', from: a, to: c, labels: ['E'] });

    return graph;
  };

  test('a PROPERTY key must still dedup — two far ends can SHARE a value', () => {
    // b and c are two distinct vertices with the same `k`. Counting visits would say 2; the right
    // answer for distinct VALUES is 1. This is why the optimization is gated on the source being
    // the keyed variable itself.
    expect(one(g(), 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c')).toBe(2);
    expect(one(g(), 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c')).toBe(1);
  });

  test('a WHERE on the keyed end declines the fast count and still answers', () => {
    expect(one(g(), 'MATCH (a:P)-[:E]->(b) WHERE b.k = 7 RETURN count(DISTINCT b) AS c')).toBe(2);
    expect(one(g(), 'MATCH (a:P)-[:E]->(b) WHERE b.k = 99 RETURN count(DISTINCT b) AS c')).toBe(0);
  });

  test('keyed on the START end answers correctly (a different walk entirely)', () => {
    expect(one(g(), 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c')).toBe(1);
  });

  test('an inline constraint on the keyed end declines and still answers', () => {
    expect(one(g(), 'MATCH (a:P)-[:E]->(b {k: 7}) RETURN count(DISTINCT b) AS c')).toBe(2);
  });
});

describe('the ROUTE choice, which is answer-equivalent and so needs its own test', () => {
  // Declining returns the same rows by the slower path, so every mutant in this predicate is
  // invisible to the answer tests above. `countsVisitsDirectly` is exported and pure for exactly
  // that reason.
  const bare = { kind: 'var', name: 'b' } as const;

  test('the bare keyed variable with no gate COUNTS DIRECTLY', () => {
    expect(countsVisitsDirectly(bare, 'b', false)).toBe(true);
  });

  test('a PROPERTY of the keyed end declines — two far ends can share a value', () => {
    expect(countsVisitsDirectly({ kind: 'prop', variable: 'b', key: 'k' }, 'b', false)).toBe(false);
  });

  test('a variable that is NOT the keyed one declines', () => {
    expect(countsVisitsDirectly({ kind: 'var', name: 'a' }, 'b', false)).toBe(false);
  });

  test('a clause WHERE declines, so the counting walk never needs a binding', () => {
    expect(countsVisitsDirectly(bare, 'b', true)).toBe(false);
  });

  test('any other expression shape declines', () => {
    expect(countsVisitsDirectly({ kind: 'literal', value: 1 } as never, 'b', false)).toBe(false);
  });
});
