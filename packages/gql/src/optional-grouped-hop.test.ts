/*
 * Item 2123 — `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(b) RETURN a.k, count(*)`.
 *
 * ⚠️⚠️ **THE FIXTURE MUST CONTAIN UNMATCHED ANCHORS OR IT CANNOT TEST THIS RUNG AT ALL.** The whole
 * difference from the non-OPTIONAL grouped count is `max(1, degree)`: an anchor with no qualifying edge
 * still contributes its one null-filled row. 🔑 My first measurement fixture gave EVERY vertex degree 3,
 * so `max(1,d) === d` and the two arithmetics agreed — the numbers matched and proved nothing. Every
 * fixture here has zero-degree anchors, and one test asserts the two forms DISAGREE.
 *
 * 🔑 THE REFERENCE IS THE GENERAL PATH, forced by an `ORDER BY` (the gate refuses one). So the expected
 * answer is the engine's own for the same question rather than a number I computed.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** `degrees[i]` out-edges from `v{i}`, so zero-degree anchors are explicit. */
const graphOf = (degrees: readonly number[], groups = 3): Graph => {
  const g = new Graph();

  for (const [i] of degrees.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % groups, n: i } });
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

const Q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c';
const bagOf = (rows: readonly Record<string, unknown>[]): string =>
  rows
    .map((r) => `${String(r.g)}:${String(r.c)}`)
    .sort()
    .join(',');

/** The rung's answer against the general path's, which an `ORDER BY` forces. */
const bothRoutes = (g: Graph, q = Q): { fused: string; general: string } => ({
  fused: bagOf(query(g, q)),
  general: bagOf(query(g, `${q} ORDER BY g`)),
});

describe('optionalGroupedHopCount (item 2123)', () => {
  test('⚠️⚠️ unmatched anchors COUNT, and the non-OPTIONAL twin proves the fixture separates them', () => {
    /*
     * 🔑 Degrees 2,0,1,0,2,0 over three groups. The OPTIONAL form counts a row for each zero-degree
     * anchor; the plain form does not. ⚠️ If these two ever agree the fixture has stopped testing the
     * rung, which is what my first measurement fixture did.
     */
    const g = graphOf([2, 0, 1, 0, 2, 0]);
    const { fused, general } = bothRoutes(g);
    const plain = bagOf(query(g, 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS c'));

    expect(fused).toBe(general);
    expect(fused).not.toBe(plain);
  });

  test('⚠️ an ALL-ZERO graph gives every anchor exactly one row', () => {
    /*
     * The degenerate case the `max(1, …)` exists for: no edges at all, so each group's count is its
     * member count. ⚠️ The non-OPTIONAL twin returns NO rows here, which is the sharpest form of the
     * difference.
     */
    const g = graphOf([0, 0, 0, 0, 0, 0]);
    const { fused, general } = bothRoutes(g);

    expect(fused).toBe(general);
    expect(fused).toBe('0:2,1:2,2:2');
    expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS c')).toHaveLength(0);
  });

  test('⚠️ a NULL group key is its own group, not dropped', () => {
    /*
     * 🔑 ISO GQL yields NULL for an absent property, and a group keyed NULL is a group. ⚠️ The rung
     * coalesces `undefined` to `null` before keying for exactly this; dropping it would lose the group.
     */
    const g = new Graph();

    for (let i = 0; i < 4; i += 1) {
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: i < 2 ? { k: 7 } : { other: i },
      });
    }

    g.addEdge({
      id: 'e0',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('v1')!,
      labels: ['E'],
      properties: {},
    });

    const { fused, general } = bothRoutes(g);

    expect(fused).toBe(general);
    // v0 has degree 1, v1/v2/v3 have none: group 7 counts 1 + 1 = 2, the NULL group counts 2.
    expect(fused).toBe('7:2,null:2');
  });

  test('🔑 a FILTERED anchor sums only the anchors that pass', () => {
    /*
     * `anchorFilterGate` is shared with the ungrouped rung (item 559 priced refusing one at 191.69 ms
     * against 8.12). ⚠️ The filter must change WHICH anchors are summed and nothing else.
     */
    const g = graphOf([2, 0, 1, 0, 2, 0]);
    const q =
      'MATCH (a:P) WHERE a.n > 1 OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
    // ⚠️ And the filter must actually have excluded something.
    expect(fused).not.toBe(bothRoutes(g).fused);
  });

  test('⚠️ `count(b)` is NOT this rung — it excludes the null row', () => {
    /*
     * 🔑 The arithmetic differs: `count(*)` counts the null-filled row, `count(b)` does not. ⚠️ If this
     * rung ever claimed `count(b)` it would over-count by the number of unmatched anchors.
     */
    const g = graphOf([2, 0, 1, 0, 2, 0]);
    const star = bagOf(query(g, Q));
    const colB = bagOf(
      query(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(b) AS c'),
    );
    const general = bagOf(
      query(
        g,
        'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(b) AS c ORDER BY g',
      ),
    );

    expect(colB).toBe(general);
    expect(colB).not.toBe(star);
  });

  test('⚠️ an INCOMING hop agrees too — direction is not assumed', () => {
    const g = graphOf([2, 0, 1, 0, 2, 0]);
    const q = 'MATCH (a:P) OPTIONAL MATCH (a)<-[:E]-(b) RETURN a.k AS g, count(*) AS c';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
  });

  test('⚠️ a key on the FAR end is REFUSED — grouping is per anchor', () => {
    /*
     * 🔑 The walk makes ONE pass over anchors, so a key over `b` would need the edges — that is
     * `detectGroupedHopCount`'s far-keyed walk and a different shape. Asserted by the ANSWER.
     */
    const g = graphOf([2, 0, 1, 0, 2, 0]);
    const q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN b.k AS g, count(*) AS c';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
  });

  test('⚠️⚠️ `ORDER BY` IS REFUSED, AND ADMITTING IT DROPS THE SORT — a silent wrong answer', () => {
    /*
     * 🔑 THE SAME TRAP AS ITEM 2119, AND THE SAME MUTANT SURVIVED UNTIL THIS TEST EXISTED. Every other
     * case here compares BAGS, which is right — group order is unspecified without an `ORDER BY` — and a
     * bag CANNOT see a dropped sort. Deleting the `orderBy` clause from the gate returned
     * **[5,1,4,2,3] where [1,2,3,4,5] is correct**, with all eight other tests still passing.
     *
     * ⚠️ So the refusal is LOAD-BEARING, not conservative, and this is the one case here that must
     * assert a LIST.
     */
    const g = new Graph();
    const ks = [5, 1, 4, 2, 3];

    for (const [i, k] of ks.entries()) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k, n: i } });
    }

    g.addEdge({
      id: 'e0',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('v1')!,
      labels: ['E'],
      properties: {},
    });

    const sorted = query(g, `${Q} ORDER BY g`).map((r) => r.g);

    expect(sorted).toStrictEqual([1, 2, 3, 4, 5]);
    // ⚠️ And the keys must NOT already be in vertex order, or the assertion is vacuous.
    expect(query(g, Q).map((r) => r.g)).not.toStrictEqual([1, 2, 3, 4, 5]);
  });

  test('⚠️ an EDGE TYPE that matches nothing gives one row per anchor', () => {
    const g = graphOf([2, 0, 1, 0, 2, 0]);
    const q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:ZZZ]->(b) RETURN a.k AS g, count(*) AS c';
    const { fused, general } = bothRoutes(g, q);

    expect(fused).toBe(general);
    expect(fused).toBe('0:2,1:2,2:2');
  });
});
