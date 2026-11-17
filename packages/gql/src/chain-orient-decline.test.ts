/*
 * Item 2105 — `chainProjection` and its two composing rungs decline when the far node carries a genuine
 * index seek. The same gate item 2104 gave `hop2Projection`, worth far more here.
 *
 * ⚠️⚠️ **THE GATE ITSELF IS ALREADY UNIT-TESTED** in `hop2-orient-decline.test.ts` — one exported
 * `farEndSeeksNarrower`, tested directly because a route choice is answer-equivalent. This file tests
 * what is NEW: that this rung and the two rungs that COMPOSE its walk are wired to it and still answer
 * correctly on both sides of the decline.
 *
 * 🔑 EVERY ASSERTION COMPARES THE TWO ROUTES AGAINST EACH OTHER, indexed and not. A vacuous `LIMIT`
 * forces the generic path (it defeats the rung's length gate — the diagnostic that found this), so each
 * shape is asked three ways and the answers must agree.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const NODES = 600;

const build = (withIndex: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 7, tag: `t${i % 50}` } });
  }

  for (let e = 0; e < NODES * 3; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  if (withIndex) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });
  }

  return g;
};

const C3 = '(a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P)';

/** The rung, the generic path (forced by a vacuous `LIMIT`), and the hand-written reverse spelling. */
const threeWays = (g: Graph, tail: string, rev: string): readonly unknown[][] => {
  const asWritten = query(g, `MATCH ${C3} ${tail}`, { t: 't7' });
  const generic = query(g, `MATCH ${C3} ${tail} LIMIT 1000000`, { t: 't7' });
  const reversed = query(g, `MATCH ${rev} ${tail}`, { t: 't7' });

  const norm = (rows: readonly Record<string, unknown>[]): unknown[] =>
    rows.map((r) => JSON.stringify(r)).sort();

  return [norm(asWritten), norm(generic), norm(reversed)];
};

const REV3 = '(b:P)<-[:E]-(m2:P)<-[:E]-(m:P)<-[:E]-(a:P)';

describe('chainProjection orientation decline (item 2105)', () => {
  for (const withIndex of [false, true]) {
    const tag = withIndex ? 'INDEXED (the gate fires)' : 'unindexed (the gate keeps)';

    describe(tag, () => {
      /*
       * ⚠️ BOTH SIDES ARE TESTED, and the unindexed side is the one that protects a WIN rather than
       * creating one: this rung's documented 5.8x (item 1820) is on a fixture with no seek, so a gate
       * that declined there would hand back 5.8x to buy 934x elsewhere. Measured LIVE against KILLED on
       * an unindexed fixture, all five shapes were flat (~1.00x) — the gate correctly keeps them.
       */
      test('⚠️ rows — all three spellings agree', () => {
        const [a, b, c] = threeWays(build(withIndex), 'WHERE b.tag = $t RETURN a.n AS n', REV3);

        expect(a).toStrictEqual(b);
        expect(a).toStrictEqual(c);
        expect(a.length).toBeGreaterThan(0);
      });

      test("⚠️ RETURN DISTINCT — item 1820's own shape", () => {
        const [a, b, c] = threeWays(
          build(withIndex),
          'WHERE b.tag = $t RETURN DISTINCT a.n AS n',
          REV3,
        );

        expect(a).toStrictEqual(b);
        expect(a).toStrictEqual(c);
      });

      test('⚠️ the FOLDED aggregate composes the walk and inherits the decline', () => {
        const [a, b, c] = threeWays(
          build(withIndex),
          'WHERE b.tag = $t RETURN min(a.n) AS m',
          REV3,
        );

        expect(a).toStrictEqual(b);
        expect(a).toStrictEqual(c);
      });

      test('⚠️ the GROUPED count composes the walk and inherits the decline', () => {
        const [a, b, c] = threeWays(
          build(withIndex),
          'WHERE b.tag = $t RETURN a.n AS k, count(*) AS c',
          REV3,
        );

        expect(a).toStrictEqual(b);
        expect(a).toStrictEqual(c);
      });
    });
  }

  test('🔑 a chain with NO far predicate is untouched — the gate cannot fire', () => {
    /*
     * THE NULL CONTROL, and it is in the measurement too: with no far predicate the gate cannot reach
     * this shape, and the indexed A/B read it at 1.01x LIVE against KILLED while the four shapes beside
     * it gained 459-989x. A harness that moved this row would have been measuring something else.
     */
    const g = build(true);
    const rows = query(g, `MATCH ${C3} RETURN count(*) AS c`);

    expect((rows[0] as { c: number }).c).toBe(NODES * 27);
  });

  test('⚠️ the answer does not depend on whether an index exists', () => {
    const bare = query(build(false), `MATCH ${C3} WHERE b.tag = $t RETURN DISTINCT a.n AS n`, {
      t: 't7',
    });
    const indexed = query(build(true), `MATCH ${C3} WHERE b.tag = $t RETURN DISTINCT a.n AS n`, {
      t: 't7',
    });

    expect([...bare].map((r) => JSON.stringify(r)).sort()).toStrictEqual(
      [...indexed].map((r) => JSON.stringify(r)).sort(),
    );
  });
});
