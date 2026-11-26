/*
 * Item 2146 — the OPTIONAL hop count from COUNTERS, with no walk at all.
 *
 * THE ARITHMETIC. Each anchor contributes `max(1, degree)` (item 2123), and
 * `Σ max(1, d) = Σ d + |{anchors with d = 0}|`, so:
 *
 * ```text
 *     count = |edges of the type| + (|anchors| - |anchors having ≥1 such edge|)
 * ```
 *
 * All three terms are O(1) reads: `edgesByLabel.get(t).size`, `vertexCount`, and
 * `edgesFromByLabel.size`. Measured 0.001 / 0.000 ms against the per-anchor walk's 6.731 over 200,000
 * anchors; the bench row read 18.5 ms against native's 0.6, and native's figure is what said a closed form
 * had to exist.
 *
 * **THE `ORDER BY` ORACLE BELOW IS NOT INDEPENDENT, AND ITEM 2162 PROVED IT.** I wrote these tests
 * believing an appended `ORDER BY` forced the general path, because that is true of several sibling rungs.
 * It is NOT true here: `routes-fired`'s own helper reports `optionalHopCount` for the plain spelling,
 * the `ORDER BY` spelling AND the `LIMIT` spelling — this rung's gate reads the PATTERN, not the
 * projection, so ordering a one-row count is a no-op it happily accepts. **So the `both()` comparisons
 * here compared the closed form against itself**, and a wrong answer in a shared term was invisible to
 * all sixteen of them.
 *
 * The genuinely independent oracle is a **freshly LOADED graph** with the same final contents, which is
 * what caught item 2162's bug: the mutating API and `deserialize` reach the same state by different code.
 * The `freshOracle` block at the bottom uses it. The `both()` comparisons are kept because they still
 * pin the ARITHMETIC against a mutation of it (the item's 8/8 mutants were all caught), but they are not
 * evidence of cross-path agreement and the header no longer claims they are.
 *
 * THE SUBTLE TERM IS `edgesFromByLabel.size`: it counts vertices with ANY out-edge, which equals
 * "vertices with an edge of OUR type" **only when the graph holds exactly one edge label**. That is
 * checked per CALL rather than per compile, because a write can add a second label to a graph the closure
 * was compiled against — and the last describe block is that case.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const Q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c';
/** The same question through the general path: the projection gate refuses `ORDER BY`. */
const REF = `${Q} ORDER BY c`;

/** `degrees[i]` out-edges from `v{i}`; `labels[i]` overrides that vertex's labels. */
const graphOf = (degrees: readonly number[], labels: readonly string[][] = []): Graph => {
  const g = new Graph();

  for (const [i] of degrees.entries()) {
    g.addVertex({ id: `v${i}`, labels: labels[i] ?? ['P'], properties: { k: i } });
  }

  let e = 0;

  for (const [i, d] of degrees.entries()) {
    for (let j = 0; j < d; j += 1) {
      g.addEdge({
        id: `e${e}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i + j + 1) % degrees.length}`)!,
        labels: ['E'],
        properties: {},
      });
      e += 1;
    }
  }

  return g;
};

const both = (g: Graph, q = Q): { closed: unknown; general: unknown } => ({
  closed: query(g, q)[0]?.c,
  general: query(g, `${q} ORDER BY c`)[0]?.c,
});

describe('the OPTIONAL count closed form (item 2146)', () => {
  describe('the arithmetic agrees with the walk', () => {
    test.each([
      ['mixed degrees', [2, 0, 1, 0, 2, 0], 8],
      ['every anchor unmatched', [0, 0, 0, 0], 4],
      ['every anchor matched', [3, 3, 3], 9],
      ['one isolated vertex', [0], 1],
      ['one matched vertex', [1], 1],
    ])('%s', (_name, degrees, want) => {
      const g = graphOf(degrees);
      const { closed, general } = both(g);

      expect(closed).toBe(general);
      expect(closed).toBe(want);
    });

    test('the UNMATCHED anchors are what the two forms differ by', () => {
      /*
       * The guard that keeps every fixture above honest: if `OPTIONAL` and plain `MATCH` ever agree,
       * the fixture has stopped testing the `max(1, …)` the closed form encodes (item 2123's lesson).
       */
      const g = graphOf([2, 0, 1, 0, 2, 0]);

      expect(query(g, Q)[0].c).toBe(8);
      expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')[0].c).toBe(5);
    });

    test('an INCOMING hop reads the other index', () => {
      const g = graphOf([2, 0, 1, 0, 2, 0]);
      const q = 'MATCH (a:P) OPTIONAL MATCH (a)<-[:E]-(b) RETURN count(*) AS c';
      const { closed, general } = both(g, q);

      expect(closed).toBe(general);
    });
  });

  describe('the four DECLINE conditions, each with the answer pinned', () => {
    test('a FAR LABEL — "qualifying" would depend on the far end', () => {
      const g = graphOf([2, 0, 1, 0], [['P'], ['P'], ['P', 'Q'], ['P']]);
      const q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:Q) RETURN count(*) AS c';
      const { closed, general } = both(g, q);

      expect(closed).toBe(general);
      // v0 reaches v1 and v2; only v2 is a Q. v1, v3 and (for the label) v0 contribute null rows.
      expect(closed).toBe(4);
    });

    test('an anchor WHERE — `vertexCount` is no longer `|anchors|`', () => {
      const g = graphOf([2, 0, 1, 0, 2, 0]);
      const q = 'MATCH (a:P) WHERE a.k > 1 OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c';
      const { closed, general } = both(g, q);

      expect(closed).toBe(general);
      // And the filter must actually exclude something, or the test is vacuous.
      expect(closed).not.toBe(query(g, Q)[0].c);
    });

    test('a SELECTIVE anchor label — not every vertex is an anchor', () => {
      const g = graphOf([2, 0, 1, 0], [['P'], ['P'], ['R'], ['R']]);
      const { closed, general } = both(g);

      expect(closed).toBe(general);
      // Only v0 and v1 are P: v0 has 2 edges, v1 has none.
      expect(closed).toBe(3);
    });

    test('TWO EDGE LABELS — `edgesFromByLabel.size` stops being per-type', () => {
      /*
       * THE SHARPEST CASE. `edgesFromByLabel.size` counts vertices with ANY out-edge. Give v1 an `F`
       * edge and it joins that count while having no `E` edge at all — so the closed form would subtract
       * it from the unmatched set and UNDER-count by one. The guard is `edgesByLabel.size === 1`.
       */
      const g = graphOf([2, 0, 1, 0]);

      g.addEdge({
        id: 'f0',
        from: g.getVertexById('v1')!,
        to: g.getVertexById('v2')!,
        labels: ['F'],
        properties: {},
      });

      const { closed, general } = both(g);

      expect(closed).toBe(general);
      // v0: 2, v1: 0 (its only edge is F), v2: 1, v3: 0 → 2 + 1 + 1 + 1 = 5.
      expect(closed).toBe(5);
    });
  });

  describe('the label check is PER CALL, because a write can change it', () => {
    test('adding a second edge label between two asks changes the answer', () => {
      /*
       * THE REASON THE GUARD IS NOT A COMPILE-TIME DECISION. The first ask takes the closed form; the
       * write makes `edgesFromByLabel.size` non-per-type; the second ask must fall back. A
       * compile-time check would answer the second from an identity that no longer holds — and because
       * both asks use the same query TEXT, the plan cache hands back the same closure.
       */
      const g = graphOf([2, 0, 1, 0]);

      // 2 + 1 + 1 + 1 = 5: v0's two edges, then one null row each for v1, v2's edge, and v3.
      expect(query(g, Q)[0].c).toBe(5);

      g.addEdge({
        id: 'later',
        from: g.getVertexById('v1')!,
        to: g.getVertexById('v3')!,
        labels: ['F'],
        properties: {},
      });

      // v1 now has an out-edge, but not an `E` one — so it still contributes its null row.
      expect(query(g, Q)[0].c).toBe(5);
      expect(query(g, REF)[0].c).toBe(5);
    });

    test('adding an `E` edge between two asks is reflected', () => {
      const g = graphOf([2, 0, 1, 0]);

      expect(query(g, Q)[0].c).toBe(5);

      g.addEdge({
        id: 'later',
        from: g.getVertexById('v1')!,
        to: g.getVertexById('v3')!,
        labels: ['E'],
        properties: {},
      });

      // v1 gains an edge, so it stops contributing a null row and contributes 1 edge instead: still 5.
      expect(query(g, Q)[0].c).toBe(query(g, REF)[0].c);
      expect(query(g, Q)[0].c).toBe(5);
    });

    test('a REMOVED edge is reflected', () => {
      const g = graphOf([2, 0, 1, 0]);

      expect(query(g, Q)[0].c).toBe(5);
      g.removeEdge(g.getEdgeById('e0')!);

      const { closed, general } = both(g);

      expect(closed).toBe(general);
      // v0 drops from 2 edges to 1, so the total falls by one.
      expect(closed).toBe(4);
    });

    test('an ADDED vertex with no edges adds a null row', () => {
      const g = graphOf([2, 0, 1, 0]);

      expect(query(g, Q)[0].c).toBe(5);
      g.addVertex({ id: 'lonely', labels: ['P'], properties: {} });
      expect(query(g, Q)[0].c).toBe(6);
      expect(query(g, REF)[0].c).toBe(6);
    });
  });

  describe('item 2162: a vertex whose LAST edge is removed (the shipped wrong answer)', () => {
    /**
     * The same final state reached two ways: by MUTATION, and by a fresh LOAD.
     *
     * THE ONLY INDEPENDENT ORACLE THIS RUNG HAS. `deserialize` and the mutating API reach the same
     * graph through different code, so a disagreement is a bug in one of them — where an appended
     * `ORDER BY` just takes the same rung again.
     */
    const twoWays = (q: string): { mutated: unknown; fresh: unknown } => {
      const m = new Graph();

      for (let i = 0; i < 3; i += 1) {
        m.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
      }

      const e = m.addEdge({
        id: 'e0',
        from: m.getVertexById('v0')!,
        to: m.getVertexById('v1')!,
        labels: ['E'],
        properties: {},
      });

      m.removeEdge(e);

      const f = new Graph();

      for (let i = 0; i < 3; i += 1) {
        f.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
      }

      return { mutated: query(m, q)[0]?.c, fresh: query(f, q)[0]?.c };
    };

    test("THE BUG: removing a vertex's only edge must leave it UNMATCHED", () => {
      /*
       * WHAT WENT WRONG. The `withEdge` term was `edgesFromByLabel.size`, and that index keeps a
       * vertex's OUTER entry after its last edge is removed — only the inner per-type bucket is deleted.
       * So `.size` counted a vertex with no edges at all, the unmatched set was UNDER-counted by one, and
       * three anchors with no edges answered **2**.
       *
       * Item 2146's own mutation round asked whether a removed edge is reflected, and it IS — as long
       * as some OTHER edge survives on that vertex. This is the case that does not.
       */
      const { mutated, fresh } = twoWays(Q);

      expect(mutated).toBe(fresh);
      expect(mutated).toBe(3);
    });

    test('and with the ORDER BY spelling, which takes the SAME rung', () => {
      const { mutated, fresh } = twoWays(REF);

      expect(mutated).toBe(fresh);
      expect(mutated).toBe(3);
    });

    test('one of TWO edges removed still leaves the vertex matched', () => {
      /*
       * The other side of the boundary, and the case item 2146 DID test: v0 keeps an edge, so it is
       * still in the matched set and the index entry is legitimately there.
       */
      const g = new Graph();

      for (let i = 0; i < 3; i += 1) {
        g.addVertex({ id: `w${i}`, labels: ['P'], properties: { k: i } });
      }

      const keep = g.addEdge({
        id: 'k0',
        from: g.getVertexById('w0')!,
        to: g.getVertexById('w1')!,
        labels: ['E'],
        properties: {},
      });
      const drop = g.addEdge({
        id: 'd0',
        from: g.getVertexById('w0')!,
        to: g.getVertexById('w2')!,
        labels: ['E'],
        properties: {},
      });

      g.removeEdge(drop);

      // w0 keeps one edge (1 row), w1 and w2 are unmatched (1 each) → 3.
      expect(query(g, Q)[0].c).toBe(3);
      expect(keep.id).toBe('k0');
    });
  });

  test('an EMPTY graph counts zero', () => {
    const { closed, general } = both(new Graph());

    expect(closed).toBe(general);
    expect(closed).toBe(0);
  });
});
