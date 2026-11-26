/*
 * Item 2163 — `MATCH (a[:L]) WHERE [NOT] EXISTS { (a)-[:T]->() } RETURN count(*)` from the edge index.
 *
 * `count(*)` over that shape is `|{vertices with ≥1 such edge}|`, and `edgesFromByLabel` is an index of
 * exactly that. `NOT EXISTS` is `vertexCount` minus it. Measured over 200,000 vertices:
 *
 * ```text
 *     EXISTS            19-27 ms -> 0.90    (native: 0.87 — parity)
 *     NOT EXISTS        22-33    -> 1.27
 *     EXISTS incoming      33    -> 2.22
 * ```
 *
 * **THE ORACLE HERE IS MUTATION-VERSUS-FRESH-LOAD, NOT AN APPENDED `ORDER BY`.** Item 2162 found a
 * shipped WRONG ANSWER that sixteen tests missed because their `ORDER BY` oracle took the SAME rung, so
 * they compared a closed form against itself. `deserialize` and the mutating API reach the same graph
 * through different code, so a disagreement between them is a real bug.
 *
 * And the bug 2162 fixed is the reason this file checks `has(type)` rather than `index.size`: that
 * index keeps a vertex's OUTER entry after its last edge is removed.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const EXISTS = 'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b) } RETURN count(*) AS c';
const NOT_EXISTS = 'MATCH (a:P) WHERE NOT EXISTS { MATCH (a)-[:T]->(b) } RETURN count(*) AS c';
const INCOMING = 'MATCH (a:P) WHERE EXISTS { MATCH (a)<-[:T]-(b) } RETURN count(*) AS c';

/** `n` vertices labelled `P`, with an edge `v{from} -> v{to}` for each pair given. */
const graphOf = (
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  label = 'T',
): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  for (const [i, [from, to]] of edges.entries()) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${from}`)!,
      to: g.getVertexById(`v${to}`)!,
      labels: [label],
      properties: {},
    });
  }

  return g;
};

describe('the EXISTS hop count (item 2163)', () => {
  describe('the arithmetic', () => {
    test('counts the vertices HAVING an out-edge, not the edges', () => {
      // v0 has two out-edges and v1 has one, so three edges over TWO source vertices.
      const g = graphOf(4, [
        [0, 1],
        [0, 2],
        [1, 2],
      ]);

      expect(query(g, EXISTS)[0].c).toBe(2);
      expect(query(g, NOT_EXISTS)[0].c).toBe(2);
      // And the two must sum to the vertex count, or one of them is wrong.
      expect(Number(query(g, EXISTS)[0].c) + Number(query(g, NOT_EXISTS)[0].c)).toBe(4);
    });

    test('the INCOMING direction counts TARGETS, on a fixture that can TELL', () => {
      /*
       * SOURCES AND TARGETS MUST DIFFER IN COUNT, or the test cannot see the direction. My first
       * fixture had two of each (sources {v0,v1}, targets {v1,v2}) and a mutant hard-coding the OUT index
       * survived it — the same coincidence that broke item 2152's `$param` test.
       *
       * Here v0 and v1 both point at v3: three sources ({v0,v1,v2}) against two targets ({v3,v2}).
       */
      const g = graphOf(5, [
        [0, 3],
        [1, 3],
        [2, 2],
      ]);

      expect(query(g, EXISTS)[0].c).toBe(3);
      expect(query(g, INCOMING)[0].c).toBe(2);
      // Disjoint, so neither index can stand in for the other.
      expect(query(g, EXISTS)[0].c).not.toBe(query(g, INCOMING)[0].c);
    });

    test('a SELF-LOOP makes its vertex both a source and a target', () => {
      const g = graphOf(3, [[0, 0]]);

      expect(query(g, EXISTS)[0].c).toBe(1);
      expect(query(g, INCOMING)[0].c).toBe(1);
      expect(query(g, NOT_EXISTS)[0].c).toBe(2);
    });

    test('PARALLEL edges count their source ONCE', () => {
      const g = new Graph();

      g.addVertex({ id: 'a', labels: ['P'], properties: {} });
      g.addVertex({ id: 'b', labels: ['P'], properties: {} });

      for (const w of [1, 2, 3]) {
        g.addEdge({
          id: `p${w}`,
          from: g.getVertexById('a')!,
          to: g.getVertexById('b')!,
          labels: ['T'],
          properties: { w },
        });
      }

      expect(query(g, EXISTS)[0].c).toBe(1);
    });

    test('an EMPTY graph, and a graph with no edges', () => {
      expect(query(new Graph(), EXISTS)[0].c).toBe(0);
      expect(query(graphOf(3, []), EXISTS)[0].c).toBe(0);
      expect(query(graphOf(3, []), NOT_EXISTS)[0].c).toBe(3);
    });

    test('a DIFFERENT edge type is not counted', () => {
      const g = graphOf(3, [[0, 1]], 'OTHER');

      expect(query(g, EXISTS)[0].c).toBe(0);
      expect(query(g, NOT_EXISTS)[0].c).toBe(3);
    });
  });

  describe('the independent oracle: MUTATION against a FRESH LOAD', () => {
    /**
     * The same final state two ways: built DIRECTLY, and reached BY A REMOVAL.
     *
     * THE ORACLE ITEM 2162 VALIDATED. An appended `ORDER BY` takes the same rung, so it proves only
     * self-consistency; two different routes to one graph do not. A disagreement here is a real bug —
     * it is exactly how 2162's wrong answer surfaced.
     */
    const bothRoutes = (q: string): { byRemoval: unknown; direct: unknown } => {
      const removed = graphOf(3, [[0, 1]]);

      removed.removeEdge(removed.getEdgeById('e0')!);

      return { byRemoval: query(removed, q)[0]?.c, direct: query(graphOf(3, []), q)[0]?.c };
    };

    test("removing a vertex's LAST edge makes it NOT-EXISTS again", () => {
      /*
       * THE ITEM 2162 CASE, which is why this form walks `has(type)` instead of reading `index.size`:
       * that index keeps the vertex's OUTER entry after its last edge goes, so `.size` would still count
       * it as having one.
       */
      const g = graphOf(3, [[0, 1]]);

      expect(query(g, EXISTS)[0].c).toBe(1);
      g.removeEdge(g.getEdgeById('e0')!);

      expect(query(g, EXISTS)[0].c).toBe(0);
      expect(query(g, NOT_EXISTS)[0].c).toBe(3);

      // And the two ROUTES to that state agree, which is the oracle rather than the literal.
      const e = bothRoutes(EXISTS);
      const ne = bothRoutes(NOT_EXISTS);

      expect(e.byRemoval).toBe(e.direct);
      expect(ne.byRemoval).toBe(ne.direct);
    });

    test('removing ONE of two edges leaves the vertex EXISTS', () => {
      const g = graphOf(3, [
        [0, 1],
        [0, 2],
      ]);

      g.removeEdge(g.getEdgeById('e1')!);

      expect(query(g, EXISTS)[0].c).toBe(1);
      expect(query(g, NOT_EXISTS)[0].c).toBe(2);
    });

    test('a vertex ADDED after the first ask is counted', () => {
      const g = graphOf(2, [[0, 1]]);

      expect(query(g, NOT_EXISTS)[0].c).toBe(1);
      g.addVertex({ id: 'fresh', labels: ['P'], properties: {} });
      expect(query(g, NOT_EXISTS)[0].c).toBe(2);
      expect(query(g, EXISTS)[0].c).toBe(1);
    });

    test('an EDGE added after the first ask is counted', () => {
      const g = graphOf(3, []);

      expect(query(g, EXISTS)[0].c).toBe(0);
      g.addEdge({
        id: 'later',
        from: g.getVertexById('v1')!,
        to: g.getVertexById('v2')!,
        labels: ['T'],
        properties: {},
      });
      expect(query(g, EXISTS)[0].c).toBe(1);
    });
  });

  describe('the declines, each of which must still ANSWER', () => {
    /**
     * **A FIXTURE WHOSE DECLINE ANSWERS DIFFER FROM 2, WHICH IS WHAT THE CLOSED FORM WOULD SAY.**
     * My first fixture gave every decline the answer 2 — the same number the form produces by ignoring
     * the condition — so four mutants that wrongly ADMITTED a shape survived. A decline test only has
     * teeth when the correct answer and the form's answer DISAGREE.
     *
     * 5 vertices, `k = 0..4`, `v2` additionally labelled `Q`. Edges: v0→v1, v1→v2, v3→v4.
     *
     * ```text
     *     sources with a T out-edge   {v0, v1, v3}   = 3   <- what the form answers
     *     targets that are Q          {v2}
     * ```
     */
    const g = (): Graph => {
      const h = new Graph();

      for (let i = 0; i < 5; i += 1) {
        h.addVertex({ id: `v${i}`, labels: i === 2 ? ['P', 'Q'] : ['P'], properties: { k: i } });
      }

      for (const [i, [from, to]] of [
        [0, 1],
        [1, 2],
        [3, 4],
      ].entries()) {
        h.addEdge({
          id: `e${i}`,
          from: h.getVertexById(`v${from}`)!,
          to: h.getVertexById(`v${to}`)!,
          labels: ['T'],
          properties: {},
        });
      }

      return h;
    };

    test('the form itself answers 3 on this fixture, so every decline below must differ', () => {
      expect(query(g(), EXISTS)[0].c).toBe(3);
    });

    test('a SELECTIVE anchor label falls back and stays correct', () => {
      /*
       * THE SHARPEST DECLINE. The index is keyed by vertex id with NO label information, so a
       * selective label would count non-anchors. Here only v0 and v1 are `Q`, and v1 is the only `Q`
       * with an out-edge — a form that ignored the label would answer 2.
       */
      const h = new Graph();

      for (let i = 0; i < 4; i += 1) {
        h.addVertex({ id: `v${i}`, labels: i < 2 ? ['P', 'Q'] : ['P'], properties: { k: i } });
      }

      for (const [i, [from, to]] of [
        [0, 1],
        [2, 3],
      ].entries()) {
        h.addEdge({
          id: `e${i}`,
          from: h.getVertexById(`v${from}`)!,
          to: h.getVertexById(`v${to}`)!,
          labels: ['T'],
          properties: {},
        });
      }

      // Q = {v0, v1}; only v0 has an out-edge.
      expect(
        query(h, 'MATCH (a:Q) WHERE EXISTS { MATCH (a)-[:T]->(b) } RETURN count(*) AS c')[0].c,
      ).toBe(1);
      // And the vacuous label over the same graph answers 2, so the label really is doing work.
      expect(query(h, EXISTS)[0].c).toBe(2);
    });

    test.each([
      // Only v2 is Q, and only v1 points at it: 1, against the form's 3.
      ['a FAR label', 'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b:Q) } RETURN count(*) AS c', 1],
      // k = 1 is v1, pointed at by v0 alone: 1.
      [
        'a FAR inline property',
        'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b {k: 1}) } RETURN count(*) AS c',
        1,
      ],
      // Undirected: every vertex touches an edge: 5.
      [
        'a BOTH direction',
        'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]-(b) } RETURN count(*) AS c',
        5,
      ],
      // b.k > 1 holds only for v2 and v4, reached from v1 and v3: 2.
      [
        'a subquery WHERE',
        'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b) WHERE b.k > 1 } RETURN count(*) AS c',
        2,
      ],
      // Pinned to k = 0 (v0), which has an out-edge: 1.
      [
        'an inline prop on the ANCHOR',
        'MATCH (a:P {k: 0}) WHERE EXISTS { MATCH (a)-[:T]->(b) } RETURN count(*) AS c',
        1,
      ],
      // Sources are v0, v1, v3; k > 0 keeps v1 and v3: 2.
      [
        'EXISTS AND another conjunct',
        'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b) } AND a.k > 0 RETURN count(*) AS c',
        2,
      ],
      /*
       * AN UNCORRELATED subquery is a CONSTANT: `(x)-[:T]->(y)` does not mention the candidate, so it
       * is true for every one of the five. A form that skipped its `start.variable === startVar` check
       * would answer 3 instead.
       */
      [
        'an UNCORRELATED subquery',
        'MATCH (a:P) WHERE EXISTS { MATCH (x)-[:T]->(y) } RETURN count(*) AS c',
        5,
      ],
      [
        'a REL variable',
        'MATCH (a:P) WHERE EXISTS { MATCH (a)-[e:T]->(b) } RETURN count(*) AS c',
        3,
      ],
      ['an UNTYPED rel', 'MATCH (a:P) WHERE EXISTS { MATCH (a)->(b) } RETURN count(*) AS c', 3],
      ['a plain scan count', 'MATCH (a:P) RETURN count(*) AS c', 5],
      ['a filtered scan count', 'MATCH (a:P) WHERE a.k = 1 RETURN count(*) AS c', 1],
    ])('%s answers %i', (_name, q, want) => {
      expect(query(g(), q)[0].c).toBe(want);
    });

    test('a QUANTIFIER reaches further than one hop, so its answer differs', () => {
      /*
       * 1-2 hops from v0 reaches v1 and v2; from v1 reaches v2; from v3 reaches v4. Sources are still
       * {v0, v1, v3} = 3 here, so the quantifier needs a fixture where TWO hops add a source — a chain
       * where the second hop is the only one of its type.
       */
      const h = new Graph();

      for (let i = 0; i < 3; i += 1) {
        h.addVertex({ id: `w${i}`, labels: ['P'], properties: { k: i } });
      }

      h.addEdge({
        id: 'q0',
        from: h.getVertexById('w0')!,
        to: h.getVertexById('w1')!,
        labels: ['T'],
        properties: {},
      });
      h.addEdge({
        id: 'q1',
        from: h.getVertexById('w1')!,
        to: h.getVertexById('w2')!,
        labels: ['T'],
        properties: {},
      });

      // One hop: sources {w0, w1} = 2. 1-2 hops: the same two sources, so use the FAR side to differ.
      expect(
        query(h, 'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->{2,2}(b) } RETURN count(*) AS c')[0].c,
      ).toBe(1);
      expect(query(h, EXISTS)[0].c).toBe(2);
    });
  });
  /*
   * Item 2392 — the EMPTY inline map `{}`, which constrains nothing and so IS the bare spelling.
   *
   * **THE ANSWER CANNOT SEE THIS CHANGE, WHICH IS WHY THE NON-EMPTY MAP IS HERE TOO.** All
   * three braced spellings already answered correctly before item 2392 — by the general path, 3.82x
   * slower (the spelling probe's `EMPTY inline map` group holds that measurement). So the equality
   * tests below pin the admission, and `{k: 2}` is what gives the group TEETH: a gate that widened
   * too far would ignore a REAL constraint and answer 3 where the correct answer is 1.
   */
  describe('an EMPTY inline map is a spelling of the bare element (item 2392)', () => {
    /** v0->v1, v1->v2, v3->v4 over `k = 0..4`: sources {v0, v1, v3} = 3. */
    const g = (): Graph =>
      graphOf(5, [
        [0, 1],
        [1, 2],
        [3, 4],
      ]);

    test('the bare spelling answers 3, which every empty-map spelling must match', () => {
      expect(query(g(), EXISTS)[0].c).toBe(3);
    });

    test('the FAR element braced', () => {
      expect(
        query(g(), 'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b {}) } RETURN count(*) AS c')[0].c,
      ).toBe(3);
    });

    test('the NEAR element braced', () => {
      expect(
        query(g(), 'MATCH (a:P) WHERE EXISTS { MATCH (a {})-[:T]->(b) } RETURN count(*) AS c')[0].c,
      ).toBe(3);
    });

    test('BOTH braced', () => {
      expect(
        query(g(), 'MATCH (a:P) WHERE EXISTS { MATCH (a {})-[:T]->(b {}) } RETURN count(*) AS c')[0]
          .c,
      ).toBe(3);
    });

    test('a NON-EMPTY map still constrains: 1, not the 3 an over-wide gate would answer', () => {
      // Only v1 -> v2 has a far endpoint with k = 2.
      expect(
        query(
          g(),
          'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:T]->(b {k: 2}) } RETURN count(*) AS c',
        )[0].c,
      ).toBe(1);
    });

    test('and on the NEAR side: k = 1 selects v1 alone, which does have an out-edge', () => {
      expect(
        query(
          g(),
          'MATCH (a:P) WHERE EXISTS { MATCH (a {k: 1})-[:T]->(b) } RETURN count(*) AS c',
        )[0].c,
      ).toBe(1);
    });

    test('a NOT over the braced spelling: 5 - 3 = 2', () => {
      expect(
        query(
          g(),
          'MATCH (a:P) WHERE NOT EXISTS { MATCH (a)-[:T]->(b {}) } RETURN count(*) AS c',
        )[0].c,
      ).toBe(2);
    });
  });
});
