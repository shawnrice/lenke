/**
 * A label carried by NO vertex makes the whole chain empty (item 1552).
 *
 * The companion of `vacuousLabel`: one asks `size === vertexCount` ("drop the test"), the other
 * `size === 0` ("drop the query"). `buildTwoHopCount` drives from the MIDDLE, so an empty middle
 * bucket already yielded 0 for free; the END labels are per-edge filters and cost the whole sweep
 * to discover nothing. Measured at 200,000 vertices:
 *
 * ```text
 *   MATCH (a:Nope)-[:E]->(b)-[:E]->(c)   146.126 -> 0.001 ms
 *   MATCH (a)-[:E]->(b)-[:E]->(c:Nope)   118.157 -> 0.001
 *   MATCH (a:Q)-[:E]->(b)-[:E]->(c)      148.264 -> 147.201   <- selective, untouched
 * ```
 *
 * ⚠️ THE WRONG-ANSWER RISK IS THE OTHER DIRECTION: a guard that fires for a label which DOES match
 * answers 0 for a query with rows. Most of this file is that control.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** A 4-cycle of `:P`, half of them also `:Q`. `R` exists on nobody. */
const build = () => {
  const g = new Graph();
  const vs = [0, 1, 2, 3].map((i) =>
    g.addVertex({
      id: `v${i}`,
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: { n: i },
    }),
  );

  for (const i of [0, 1, 2, 3]) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i + 1) % 4], labels: ['E'], properties: {} });
  }

  return g;
};

const c = (g: Graph, q: string): number => Number((query(g, q)[0] as { c: number }).c);

describe('item 1552 — an empty label short-circuits the chain', () => {
  test('an empty label at the START, MIDDLE or END of a two-hop answers 0', () => {
    const g = build();

    expect(c(g, 'MATCH (a:R)-[:E]->(b)-[:E]->(x) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a)-[:E]->(b:R)-[:E]->(x) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a)-[:E]->(b)-[:E]->(x:R) RETURN count(*) AS c')).toBe(0);
  });

  test('and at any position of a three-hop', () => {
    const g = build();

    expect(c(g, 'MATCH (a:R)-[:E]->(b)-[:E]->(x)-[:E]->(y) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a)-[:E]->(b:R)-[:E]->(x)-[:E]->(y) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a)-[:E]->(b)-[:E]->(x:R)-[:E]->(y) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a)-[:E]->(b)-[:E]->(x)-[:E]->(y:R) RETURN count(*) AS c')).toBe(0);
  });

  /**
   * ⚠️ THE CONTROL THAT MATTERS. A guard that fires too eagerly answers 0 where there are rows,
   * and 0 is exactly what a short-circuit produces — so a wrong guard looks like a working one on
   * every empty-label case and only breaks here.
   */
  test('⚠️ a label that DOES match is not short-circuited', () => {
    const g = build();

    // Every vertex is `:P`, so the full 4-cycle: 4 two-hop paths and 4 three-hop paths.
    expect(c(g, 'MATCH (a:P)-[:E]->(b)-[:E]->(x) RETURN count(*) AS c')).toBe(4);
    expect(c(g, 'MATCH (a)-[:E]->(b:P)-[:E]->(x) RETURN count(*) AS c')).toBe(4);
    expect(c(g, 'MATCH (a)-[:E]->(b)-[:E]->(x:P) RETURN count(*) AS c')).toBe(4);
    expect(c(g, 'MATCH (a:P)-[:E]->(b)-[:E]->(x)-[:E]->(y) RETURN count(*) AS c')).toBe(4);

    // `Q` is on two of the four, so these are genuinely selective and must still be computed.
    expect(c(g, 'MATCH (a:Q)-[:E]->(b)-[:E]->(x) RETURN count(*) AS c')).toBe(2);
    expect(c(g, 'MATCH (a)-[:E]->(b:Q)-[:E]->(x) RETURN count(*) AS c')).toBe(2);
    expect(c(g, 'MATCH (a)-[:E]->(b)-[:E]->(x:Q) RETURN count(*) AS c')).toBe(2);
  });

  /**
   * ⚠️ PER EXECUTION, NOT PER COMPILE — the point item 1551 had to establish. `compile(stmt)` is
   * cached in `planCache`, so a guard decided at compile time would be baked in and answer 0
   * forever once it had seen an empty bucket. Same query text, run before and after the label
   * stops being empty.
   */
  test('the guard is re-evaluated per execution, not baked into the cached plan', () => {
    const g = build();
    const Q = 'MATCH (a:R)-[:E]->(b)-[:E]->(x) RETURN count(*) AS c';

    expect(c(g, Q)).toBe(0);

    // Give every vertex `R` as well, so the label now matches everything.
    for (const v of g.vertices) {
      g.addLabelToVertex('R', v);
    }

    // A baked guard would still answer 0 here.
    expect(c(g, Q)).toBe(4);

    // And it goes back when the label is removed again.
    for (const v of g.vertices) {
      g.removeLabelFromVertex('R', v);
    }

    expect(c(g, Q)).toBe(0);
  });

  test('an EMPTY graph still answers 0 rather than throwing', () => {
    const g = new Graph();

    expect(c(g, 'MATCH (a:R)-[:E]->(b)-[:E]->(x) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a)-[:E]->(b)-[:E]->(x) RETURN count(*) AS c')).toBe(0);
  });
});
