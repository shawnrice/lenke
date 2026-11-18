/*
 * Item 2194 — `(a:L)-[:T]->(b:L)` counted from the label's COMPLEMENT instead of per edge.
 *
 * ```text
 *     one shape per process, MIXED fixture, two rounds
 *     row                    BEFORE            NEW
 *     both-labelled     30.87 / 30.56    2.14 / 2.88    ~12.2x
 *     OPTIONAL + far    31.97 / 31.45    2.28 / 2.05    ~14.6x   <- the screen's nomination
 *     one end only [ctl] 7.73 /  7.39    7.15 / 8.25    flat
 *     no labels    [ctl] 0.00            0.00           flat
 *     minority lbl [ctl]14.27 / 13.11   13.45 / 13.24   flat — the gate DECLINES
 * ```
 *
 * ⚠️⚠️ **THE ARITHMETIC IS ASYMMETRIC AND A SYMMETRIC VERSION IS WRONG.** Counting edges that touch the
 * complement by summing each outside vertex's in- AND out-degree DOUBLE-COUNTS an edge whose two
 * endpoints are both outside. 🔑 Item 2193's ceiling probe did exactly that and still got the right
 * answer, because its single off-label vertex had no edges — so the `both out` case below is the test
 * that would have caught it.
 *
 * 🔑 The rule: for every vertex outside `L`, take ALL its out-edges of the type, but its in-edges ONLY
 * when the source is INSIDE `L`.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * 30 `Lbl`, 2 `Out`. Edges of type `T`:
 * `a` p0→p1 and `b` p1→p2 (both inside), `c` x0→p3 (source outside), `d` p4→x0 (target outside),
 * `f` x0→x1 (BOTH outside), `g` p5→p5 (a self-loop inside).
 */
const g = (): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 30; i += 1) {
    graph.addVertex({ id: `p${i}`, labels: ['Lbl'], properties: {} });
  }

  graph.addVertex({ id: 'x0', labels: ['Out'], properties: {} });
  graph.addVertex({ id: 'x1', labels: ['Out'], properties: {} });

  const edge = (id: string, from: string, to: string): void => {
    graph.addEdge({
      id,
      from: graph.getVertexById(from)!,
      to: graph.getVertexById(to)!,
      labels: ['T'],
      properties: {},
    });
  };

  edge('a', 'p0', 'p1');
  edge('b', 'p1', 'p2');
  edge('c', 'x0', 'p3');
  edge('d', 'p4', 'x0');
  edge('f', 'x0', 'x1');
  edge('g', 'p5', 'p5');

  /*
   * ⚠️⚠️ **THE FILLER IS WHAT MAKES THESE TESTS REACH THE ARM AT ALL, AND WITHOUT IT EVERY MUTANT
   * SURVIVED.** The gate is `outside * 8 > total`: with a complement of 2 and only the six edges above,
   * `16 > 6` DECLINES and the fixture silently measured the old per-edge path. 🔑 Twenty inside-inside
   * edges put `total` at 26 so `16 <= 26` and the arm runs. (The same class of failure as item 2169's
   * dist-vs-source import: a test that does not reach the code it names.)
   */
  for (let i = 0; i < 20; i += 1) {
    /* ⚠️ Targets stay inside p10..p29 — a first version wrote `p${11 + i}` and referenced p30. */
    edge(`fill${i}`, `p${10 + i}`, `p${10 + ((i + 1) % 20)}`);
  }

  return graph;
};

const count = (graph: Graph, q: string): unknown => {
  const out = query(graph, q) as unknown as { rows?: Record<string, unknown>[] };

  return (out.rows ?? (out as unknown as Record<string, unknown>[]))[0].c;
};

describe('the both-labelled hop count (item 2194)', () => {
  describe('🔑 the counts, each derived from the fixture', () => {
    test('BOTH ends labelled counts only inside-inside edges', () => {
      // `a`, `b` and the self-loop `g`. NOT `c` (source out), `d` (target out) or `f` (both out).
      expect(count(g(), 'MATCH (a:Lbl)-[:T]->(b:Lbl) RETURN count(*) AS c')).toBe(23);
    });

    test('⚠️⚠️ an edge with BOTH endpoints outside is excluded ONCE, not twice', () => {
      /*
       * 🔑🔑 THE TEST THAT CATCHES A SYMMETRIC COMPLEMENT SUM. With `f` (x0→x1) in the fixture, summing
       * both degrees of both outside vertices would subtract `f` TWICE and answer 4 instead of 3.
       * ⚠️ Pinned by comparing against a fixture WITHOUT that edge, so the literal is derived.
       */
      const withBoth = g();
      const withoutBoth = g();

      withoutBoth.removeEdge(withoutBoth.getEdgeById('f')!);

      const q = 'MATCH (a:Lbl)-[:T]->(b:Lbl) RETURN count(*) AS c';

      // Removing an edge that was never counted cannot change the answer.
      expect(count(withBoth, q)).toBe(count(withoutBoth, q));
      expect(count(withBoth, q)).toBe(23);
    });

    test('⚠️ a SELF-LOOP inside the label counts once', () => {
      const graph = g();

      graph.removeEdge(graph.getEdgeById('g')!);

      // Dropping the self-loop drops exactly one from the count.
      expect(count(graph, 'MATCH (a:Lbl)-[:T]->(b:Lbl) RETURN count(*) AS c')).toBe(22);
    });

    test('🔑 one end labelled is a DIFFERENT count, and this arm must not claim it', () => {
      expect(count(g(), 'MATCH (a:Lbl)-[:T]->(b) RETURN count(*) AS c')).toBe(24);
      expect(count(g(), 'MATCH (a)-[:T]->(b:Lbl) RETURN count(*) AS c')).toBe(24);
      expect(count(g(), 'MATCH (a)-[:T]->(b) RETURN count(*) AS c')).toBe(26);
    });

    test('⚠️ a label NOTHING carries answers zero', () => {
      expect(count(g(), 'MATCH (a:Zz)-[:T]->(b:Zz) RETURN count(*) AS c')).toBe(0);
    });

    test('⚠️ DIFFERENT labels on the two ends is not this arm, and still answers right', () => {
      // x0→x1 is the only Out→Out edge.
      expect(count(g(), 'MATCH (a:Out)-[:T]->(b:Out) RETURN count(*) AS c')).toBe(1);
      // p4→x0 is the only Lbl→Out edge.
      expect(count(g(), 'MATCH (a:Lbl)-[:T]->(b:Out) RETURN count(*) AS c')).toBe(1);
    });

    test('⚠️⚠️ a MULTI-TYPE hop must not be counted as its FIRST type only', () => {
      /*
       * 🔑🔑 THE GAP THE MUTATION ROUND FOUND. The arm takes `types[0]`, so it is gated on
       * `types?.length === 1`; a mutant dropping that check survived every test because none used an
       * alternation. ⚠️ With `T|U` the answer must include BOTH types' inside-inside edges — counting
       * only `T` would answer 23 where 24 is right.
       */
      const graph = g();

      graph.addEdge({
        id: 'u1',
        from: graph.getVertexById('p6')!,
        to: graph.getVertexById('p7')!,
        labels: ['U'],
        properties: {},
      });

      expect(count(graph, 'MATCH (a:Lbl)-[:T]->(b:Lbl) RETURN count(*) AS c')).toBe(23);
      expect(count(graph, 'MATCH (a:Lbl)-[:U]->(b:Lbl) RETURN count(*) AS c')).toBe(1);
      expect(count(graph, 'MATCH (a:Lbl)-[:T|U]->(b:Lbl) RETURN count(*) AS c')).toBe(24);
    });

    test('⚠️ an edge of ANOTHER type is never counted', () => {
      const graph = g();

      graph.addEdge({
        id: 'other',
        from: graph.getVertexById('p6')!,
        to: graph.getVertexById('p7')!,
        labels: ['U'],
        properties: {},
      });

      expect(count(graph, 'MATCH (a:Lbl)-[:T]->(b:Lbl) RETURN count(*) AS c')).toBe(23);
      expect(count(graph, 'MATCH (a:Lbl)-[:U]->(b:Lbl) RETURN count(*) AS c')).toBe(1);
    });
  });

  test('⚠️⚠️ a MINORITY label declines the arm and still answers correctly', () => {
    /*
     * 🔑 The gate is `outside * 8 > total`: the complement pass only wins while the complement is small.
     * ⚠️ With `Out` carrying 2 of 32 vertices the complement is 30, so this takes the ORIGINAL per-edge
     * path — and must give the same answer the arm would. The A/B's `minority label` control confirms the
     * timing is unchanged (14.27 → 13.45); this pins the answer.
     */
    expect(count(g(), 'MATCH (a:Out)-[:T]->(b:Out) RETURN count(*) AS c')).toBe(1);
  });

  test('🔑 the OPTIONAL spelling the screen nominated', () => {
    /*
     * `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(b:L) RETURN count(b)` — 31.97 → 2.28 ms. `count(b)` counts
     * matched pairs only, so the null-padded rows for the 27 edgeless `Lbl` vertices do not contribute.
     */
    expect(count(g(), 'MATCH (a:Lbl) OPTIONAL MATCH (a)-[:T]->(b:Lbl) RETURN count(b) AS c')).toBe(
      23,
    );
  });

  test('⚠️ a WRITE between two asks is reflected', () => {
    const graph = g();
    const q = 'MATCH (a:Lbl)-[:T]->(b:Lbl) RETURN count(*) AS c';

    expect(count(graph, q)).toBe(23);
    graph.addEdge({
      id: 'fresh',
      from: graph.getVertexById('p8')!,
      to: graph.getVertexById('p9')!,
      labels: ['T'],
      properties: {},
    });
    expect(count(graph, q)).toBe(24);
  });
});
