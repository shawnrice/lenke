/*
 * Item 2135 — the three-segment unfiltered count is memoized per topology generation.
 *
 * The Gremlin twin got this at item 2131, and the gap was the largest in item 2132's cross-language
 * table: identical question, identical answer (25,000,000), GQL **7.75 ms** against Gremlin's **0.00**.
 *
 * **MY FIRST VERSION WAS A WRONG ANSWER AND AN EXISTING TEST CAUGHT IT.** I read the memo at the TOP
 * of the compiled closure, on the assumption that "the closure IS the shape". It is NOT: the same closure
 * serves both the ungated question and `WHERE c.k > 1000`, so the memo returned the ungated 6 where 0 is
 * correct (`three-hop-interior-filter.test.ts`). The read now sits exactly where the WRITE does, behind
 * the same `csrDegreeProductApplies` test — and this file is the regression wall for that.
 *
 * The memo is keyed on `graph.topologyVersion`, which advances SYNCHRONOUSLY on an edge or vertex write
 * but **NOT on a label write** (verified at item 2132). That is why a MIDDLE label refuses the memo: the
 * CSR gate checks the other three labels but not `bLabel`, so a count depending on it would go stale.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** A ring where every vertex has out-degree 2, so a three-segment count is 8 per start. */
const ringOf = (n: number, labelEvery?: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: labelEvery !== undefined && i % labelEvery === 0 ? ['P', 'Mid'] : ['P'],
      properties: { k: i },
    });
  }

  let id = 0;

  for (let i = 0; i < n; i += 1) {
    for (let d = 1; d <= 2; d += 1) {
      g.addEdge({
        id: `e${id}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i + d) % n}`)!,
        labels: ['E'],
        properties: {},
      });
      id += 1;
    }
  }

  return g;
};

const THREE = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS n';
const asked = (g: Graph, q = THREE): unknown => query(g, q)[0]?.n;

describe('the three-segment topology memo (item 2135)', () => {
  describe('a GATED question must never read the memo — the bug my first version shipped', () => {
    test('a gate matching NOTHING answers zero, after the ungated question has run', () => {
      /*
       * THE EXACT SHAPE THAT CAUGHT ME. The ungated ask populates the memo; the gated ask must not
       * read it. Order matters — the ungated query runs FIRST on purpose.
       */
      const g = ringOf(8);

      expect(asked(g)).toBe(64);
      expect(
        asked(g, 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE d.k > 1000 RETURN count(*) AS n'),
      ).toBe(0);
    });

    test('a gate matching EVERYTHING equals the ungated count, both orders', () => {
      const g = ringOf(8);
      const vacuous =
        'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE d.k > -1 RETURN count(*) AS n';

      expect(asked(g, vacuous)).toBe(64);
      expect(asked(g)).toBe(64);
      expect(asked(g, vacuous)).toBe(64);
    });

    test('a SELECTIVE gate is not served the ungated number', () => {
      const g = ringOf(8);

      expect(asked(g)).toBe(64);

      const selective = asked(
        g,
        'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE d.k > 3 RETURN count(*) AS n',
      );

      expect(selective).not.toBe(64);
      expect(selective).toBe(32);
    });
  });

  describe('a MIDDLE label refuses the memo — `topologyVersion` ignores label writes', () => {
    test('the mid-labelled count tracks a LABEL write, which the memo could not', () => {
      /*
       * THE SOUNDNESS BOUNDARY. `csrDegreeProductApplies` checks the start, `c` and end labels but NOT
       * `bLabel`, so the memo requires `bLabel === undefined` separately. Here the middle IS labelled
       * and a label write must still be seen — `topologyVersion` does not move for one, so a memo would
       * answer the old number forever.
       */
      const g = ringOf(8, 4);
      const midLabelled = 'MATCH (a:P)-[:E]->(b:Mid)-[:E]->(c)-[:E]->(d) RETURN count(*) AS n';
      const before = asked(g, midLabelled);
      const tv = g.topologyVersion;

      // Give every vertex `Mid` without touching the topology.
      for (const v of g.verticesById.values()) {
        v.labels = new Set(['P', 'Mid']);
      }

      expect(g.topologyVersion).toBe(tv);

      const after = asked(g, midLabelled);

      expect(after).not.toBe(before);
      // Every middle now qualifies, so it equals the unlabelled count.
      expect(after).toBe(64);
    });
  });

  test('a VACUOUS mid label reaches the CSR and must still refuse the memo', () => {
    /*
     * THE TEST THAT GIVES THE `bLabel === undefined` GUARD ITS TEETH, and my first attempt used the
     * wrong kind of label. A SELECTIVE mid label (`:Mid` on a quarter of the vertices) never reaches the
     * CSR at all — instrumented: `threeHopCsrCount` returns `undefined` and the memo is never offered
     * the question. A VACUOUS one (`:P`, carried by every vertex) DOES reach it: `viaCsr` is defined
     * and `bLabel` is PRESENT, which is exactly the case the guard exists for.
     *
     * AND THE ANSWER DEPENDS ON THAT LABEL. Removing `P` from one vertex changes the count while
     * `topologyVersion` stays put (it does not advance for a label write — item 2132), so memoizing here
     * would answer the old number forever. Admitting a present `bLabel` into the memo makes this test
     * fail; without it, that mutant survives.
     */
    /*
     * TWO DISTINCT UNIVERSAL LABELS, AND THAT IS THE WHOLE POINT OF THE FIXTURE. My first attempt
     * used `(a:P)` and `(b:P)` and the mutant still survived: dropping `P` from a vertex makes the START
     * label non-vacuous too, so `aEff` becomes defined and `csrDegreeProductApplies` disables the memo
     * through a DIFFERENT condition. To isolate `bLabel` the mid label must be able to stop being
     * vacuous ON ITS OWN — so every vertex carries both `P` and `Q`, and only `Q` is taken away.
     */
    const g = new Graph();

    for (let i = 0; i < 8; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P', 'Q'], properties: { k: i } });
    }

    let id = 0;

    for (let i = 0; i < 8; i += 1) {
      for (let d = 1; d <= 2; d += 1) {
        g.addEdge({
          id: `e${id}`,
          from: g.getVertexById(`v${i}`)!,
          to: g.getVertexById(`v${(i + d) % 8}`)!,
          labels: ['E'],
          properties: {},
        });
        id += 1;
      }
    }

    const vacuousMid = 'MATCH (a:P)-[:E]->(b:Q)-[:E]->(c)-[:E]->(d) RETURN count(*) AS n';

    expect(asked(g, vacuousMid)).toBe(64);

    const tv = g.topologyVersion;

    // Drop only `Q`, from one vertex: `P` stays universal so the START label is still vacuous.
    g.getVertexById('v0')!.labels = new Set(['P']);

    expect(g.topologyVersion).toBe(tv);

    const after = asked(g, vacuousMid);

    expect(after).not.toBe(64);
    expect(after).toBeLessThan(64);
  });

  describe('the memo goes stale on a TOPOLOGY write', () => {
    test('an ADDED edge changes the answer', () => {
      const g = ringOf(8);

      expect(asked(g)).toBe(64);
      g.addEdge({
        id: 'extra',
        from: g.getVertexById('v0')!,
        to: g.getVertexById('v1')!,
        labels: ['E'],
        properties: {},
      });

      /*
       * Checked against a brute-force enumeration rather than by hand: the arithmetic of adding one
       * edge to a three-segment product is not obvious, and item 1611's note is that literals written by
       * eye in this repo have been wrong while the engine was right.
       */
      let want = 0;

      for (const a of g.verticesById.values()) {
        for (const e1 of a.adjFrom?.get('E') ?? []) {
          for (const e2 of e1.to.adjFrom?.get('E') ?? []) {
            for (const _e3 of e2.to.adjFrom?.get('E') ?? []) {
              want += 1;
            }
          }
        }
      }

      expect(asked(g)).toBe(want);
      expect(asked(g)).not.toBe(64);
    });

    test('a REMOVED edge changes the answer', () => {
      const g = ringOf(8);

      expect(asked(g)).toBe(64);
      g.removeEdge(g.getEdgeById('e0')!);
      expect(asked(g)).toBeLessThan(64);
    });

    test('TWO writes in a row each invalidate', () => {
      const g = ringOf(8);
      const seen = new Set<unknown>();

      seen.add(asked(g));

      for (const [i, to] of ['v1', 'v2'].entries()) {
        g.addEdge({
          id: `x${i}`,
          from: g.getVertexById('v0')!,
          to: g.getVertexById(to)!,
          labels: ['E'],
          properties: {},
        });
        seen.add(asked(g));
      }

      // Three distinct answers: a second write that did not invalidate would collapse this to two.
      expect(seen.size).toBe(3);
    });
  });

  test('a repeat ask returns the SAME number, not a mutated row', () => {
    /*
     * The memo stores the NUMBER and `rowOf` runs on every call, so no caller is handed an aliased
     * row array. Mutating the first result must not change the second.
     */
    const g = ringOf(8);
    const first = query(g, THREE);

    (first[0] as Record<string, unknown>).n = 999;

    expect(query(g, THREE)[0].n).toBe(64);
  });
});
