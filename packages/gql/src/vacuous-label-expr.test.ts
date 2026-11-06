/**
 * `vacuousLabel` over COMPOUND label expressions (item 1549).
 *
 * `LabelExpr` has five kinds — `label`, `wildcard`, `not`, `and`, `or` — and only `label` was
 * tested, so every compound spelling of a vacuous label stayed in the plan and left the O(1) route.
 * The same defect as item 1547's on the Gremlin side. Measured at 200,000 vertices, every arm
 * answering the identical 200,000:
 *
 * ```text
 *   MATCH (a:P|Q)-[:E]->(x)     7.406 -> 0.001 ms     7406x
 *   MATCH (a:Q|P)-[:E]->(x)     7.152 -> 0.001        7152x
 *   MATCH (a:!Nope)-[:E]->(x)   6.949 -> 0.001        6949x
 *   MATCH (a:P&P)-[:E]->(x)     9.495 -> 0.001        9495x
 * ```
 *
 * ⚠️ AN ELISION IS ANSWER-EQUIVALENT WHEN IT IS CORRECT, so most of this file is about the cases
 * where eliding would be WRONG — and the fixture carries an UNLABELLED vertex specifically so that
 * those cases have a different answer to fail on.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * `P` on every LABELLED vertex, `Q` on two of them, `R` on none — plus one vertex with NO labels
 * at all, which is what makes the wildcard case decidable.
 */
const build = () => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P', 'Q'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3 } });
  const bare = g.addVertex({ id: 'bare', labels: [], properties: { n: 4 } });

  for (const [i, [from, to]] of [
    [a, b],
    [b, c],
    [c, a],
    [bare, a],
  ].entries()) {
    g.addEdge({ id: `e${i}`, from, to, labels: ['E'], properties: {} });
  }

  return g;
};

const c = (g: Graph, q: string): number => Number((query(g, q)[0] as { c: number }).c);

describe('item 1549 — vacuousLabel over compound label expressions', () => {
  /**
   * `P` is NOT universal in this fixture (the unlabelled vertex lacks it), so nothing here is
   * elided — these assert the ANSWERS stay right, which is what an elision must not change.
   */
  test('the answers are right with an UNLABELLED vertex present', () => {
    const g = build();

    expect(c(g, 'MATCH (a) RETURN count(*) AS c')).toBe(4);
    expect(c(g, 'MATCH (a:P) RETURN count(*) AS c')).toBe(3);
    expect(c(g, 'MATCH (a:P|Q) RETURN count(*) AS c')).toBe(3);
    expect(c(g, 'MATCH (a:Q) RETURN count(*) AS c')).toBe(2);
    expect(c(g, 'MATCH (a:P&Q) RETURN count(*) AS c')).toBe(2);
    expect(c(g, 'MATCH (a:R) RETURN count(*) AS c')).toBe(0);
  });

  /**
   * ⚠️ THE WILDCARD IS THE WRONG-ANSWER GUARD. `:%` reads as "any node" and the obvious
   * implementation of `case 'wildcard'` is `return true` — which invents the unlabelled rows.
   * These two lines are the difference, and they are why `wildcard` is left un-elided.
   */
  test('⚠️ `:%` does NOT match an unlabelled vertex, so it may not be elided', () => {
    const g = build();

    expect(c(g, 'MATCH (a:%) RETURN count(*) AS c')).toBe(3);
    // The unlabelled spelling finds one MORE. If `%` were elided these two would agree.
    expect(c(g, 'MATCH (a) RETURN count(*) AS c')).toBe(4);
    expect(c(g, 'MATCH (a:%)-[:E]->(x) RETURN count(*) AS c')).toBe(3);
    expect(c(g, 'MATCH (a)-[:E]->(x) RETURN count(*) AS c')).toBe(4);
  });

  /**
   * ⚠️ `:!X` DOES match an unlabelled vertex, which is the other half of the same question — so
   * eliding it when `X` is absent is sound, and eliding it when `X` is present is not.
   */
  test('`:!X` matches the unlabelled vertex, and is only elidable when X is absent', () => {
    const g = build();

    // `R` is on nobody, so `:!R` is every vertex — elided, and the answer agrees with no label.
    expect(c(g, 'MATCH (a:!R) RETURN count(*) AS c')).toBe(4);
    expect(c(g, 'MATCH (a:!R)-[:E]->(x) RETURN count(*) AS c')).toBe(4);
    // ⚠️ `Q` IS present, so `:!Q` is selective and must be applied — AND THE SHAPE MATTERS. A bare
    // `MATCH (a:!Q) RETURN count(*)` does NOT consult `vacuousLabel` at all: mutation proved it,
    // because inverting the emptiness test left this line passing. The elision fires on the HOP
    // shapes, which is where the 6949x was measured, so that is what the guard has to use.
    expect(c(g, 'MATCH (a:!Q) RETURN count(*) AS c')).toBe(2);
    // `a` and `b` carry Q; only `c` and `bare` do not, and each has one outgoing E.
    expect(c(g, 'MATCH (a:!Q)-[:E]->(x) RETURN count(*) AS c')).toBe(2);
  });

  /**
   * Now a graph where `P` IS universal, so the compound spellings become elidable — and each must
   * answer exactly what the single-label and unlabelled spellings answer.
   */
  test('every compound spelling of a UNIVERSAL label agrees with the elided ones', () => {
    const g = new Graph();
    const v1 = g.addVertex({ id: 'x', labels: ['P', 'Q'], properties: {} });
    const v2 = g.addVertex({ id: 'y', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e', from: v1, to: v2, labels: ['E'], properties: {} });

    for (const q of [
      'MATCH (a) RETURN count(*) AS c',
      'MATCH (a:P) RETURN count(*) AS c',
      'MATCH (a:P|Q) RETURN count(*) AS c',
      'MATCH (a:Q|P) RETURN count(*) AS c',
      'MATCH (a:P&P) RETURN count(*) AS c',
      'MATCH (a:!Nope) RETURN count(*) AS c',
      // `%` too, here — every vertex carries a label in THIS graph, so it agrees by data rather
      // than by elision.
      'MATCH (a:%) RETURN count(*) AS c',
    ]) {
      expect(`${q} -> ${c(g, q)}`).toBe(`${q} -> 2`);
    }

    for (const q of [
      'MATCH (a)-[:E]->(x) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(x) RETURN count(*) AS c',
      'MATCH (a:P|Q)-[:E]->(x) RETURN count(*) AS c',
      'MATCH (a:P&P)-[:E]->(x) RETURN count(*) AS c',
      'MATCH (a:!Nope)-[:E]->(x) RETURN count(*) AS c',
    ]) {
      expect(`${q} -> ${c(g, q)}`).toBe(`${q} -> 1`);
    }
  });

  test('`and` needs BOTH sides universal, not either', () => {
    // `P` is on both vertices and `Q` on one, so `:P&Q` is SELECTIVE and eliding it would answer 2.
    const g = new Graph();

    g.addVertex({ id: 'x', labels: ['P', 'Q'], properties: {} });
    g.addVertex({ id: 'y', labels: ['P'], properties: {} });

    // ⚠️ ON A HOP, for the reason above: the bare count does not reach the elision, so only this
    // spelling fails when `and` is weakened to `or`.
    g.addEdge({
      id: 'e1',
      from: g.getVertexById('x') as never,
      to: g.getVertexById('y') as never,
      labels: ['E'],
      properties: {},
    });
    g.addEdge({
      id: 'e2',
      from: g.getVertexById('y') as never,
      to: g.getVertexById('x') as never,
      labels: ['E'],
      properties: {},
    });

    expect(c(g, 'MATCH (a:P&Q) RETURN count(*) AS c')).toBe(1);
    expect(c(g, 'MATCH (a:Q&P) RETURN count(*) AS c')).toBe(1);
    // Only `x` carries both, and it has one outgoing E.
    expect(c(g, 'MATCH (a:P&Q)-[:E]->(z) RETURN count(*) AS c')).toBe(1);
    expect(c(g, 'MATCH (a:P|Q)-[:E]->(z) RETURN count(*) AS c')).toBe(2);
    // And `or` of the same pair IS vacuous, since `P` alone covers everything.
    expect(c(g, 'MATCH (a:P|Q) RETURN count(*) AS c')).toBe(2);
  });

  test('an EMPTY graph is handled, and a nested compound does not crash', () => {
    const g = new Graph();

    expect(c(g, 'MATCH (a:P|Q) RETURN count(*) AS c')).toBe(0);
    expect(c(g, 'MATCH (a:!Nope) RETURN count(*) AS c')).toBe(0);

    const h = new Graph();

    h.addVertex({ id: 'x', labels: ['P'], properties: {} });
    // `(P|Q)|R` — a nested `or`, which the recursion has to walk rather than refuse.
    expect(c(h, 'MATCH (a:P|Q|R) RETURN count(*) AS c')).toBe(1);
    expect(c(h, 'MATCH (a:!Nope&!Other) RETURN count(*) AS c')).toBe(1);
  });
});
