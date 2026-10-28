/**
 * Item 1097: a FILTERED chain count with an undirected leg — `longChainCount`/`sweepChain`.
 *
 * `longChainCount` declined any `both` segment, so a filtered undirected chain fell to the general
 * pipeline while the BARE one was already answered by `buildThreeHopCount`'s `aBoth`/`midBoth`/
 * `dBoth`. Alternated POST/PRE/POST, min of the two POST rounds, 60,000 vertices x degree 3:
 *
 *   3-hop BOTH filtered   2332.61 ms -> 107.46   21.7x
 *   3-hop MIXED filtered  1158.37    ->  76.81   15.1x
 *   3/4/5-hop OUT filtered and 3-hop BOTH bare — CONTROLS — 1.00 / 1.00 / 0.98 / 0.98x
 *
 * ⚠️ WHAT BROKE FIRST, AND WHAT CAUGHT IT. `sweepChain`'s LAST position is not a pass: it is a
 * weighted sum of DEGREES, via `side(…, last.out, …)`, which the per-leg direction loop never
 * reaches. So the first cut counted ONE direction at the final hop and answered EXACTLY HALF —
 * caught by two pre-existing tests from item 484 at 8 against 16 and 0 against 1. Removing a
 * decline diverts shapes another rung was answering correctly into the new path, which is why
 * those tests mattered more than any of mine.
 *
 * THE ORACLE IS A ROW PROJECTION (item 1095). `AND true` and `SKIP 0` are absorbed by any rung
 * already taking a predicate or a page bound, so they compare a route against itself. A
 * row-returning query cannot be answered by a count shortcut.
 *
 * THE SELF-LOOP RULE is ISO-GQL's: `-[:T]-` emits a loop ONCE, so the second direction pass skips
 * it and the degree tail uses `undirectedSide`. Gremlin's `both()` yields it TWICE (items
 * 1086/1087/1092), which is why neither arithmetic can be borrowed from the other.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/** The fast route and an INDEPENDENT (row-returning) route on ONE pattern. */
const both = (g: Graph, pattern: string, filter: string): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} ${filter} RETURN count(*) AS c`)[0].c;
  const enumerated = query(g, `MATCH ${pattern} ${filter} RETURN a.k AS x`).length;

  expect(fast).toBe(enumerated);

  return fast;
};

/** A path with a branch and two self-loops, so no degree is uniform and loops are live. */
const looped = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: i === 5 ? ['Q'] : ['P'], properties: { k: i } }),
  );

  g.addEdge({ id: 'a', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
  g.addEdge({ id: 'b', labels: ['T'], from: vs[1], to: vs[2], properties: {} });
  g.addEdge({ id: 'c', labels: ['T'], from: vs[2], to: vs[3], properties: {} });
  g.addEdge({ id: 'd', labels: ['T'], from: vs[3], to: vs[4], properties: {} });
  g.addEdge({ id: 'e', labels: ['T'], from: vs[1], to: vs[5], properties: {} });
  g.addEdge({ id: 'l1', labels: ['T'], from: vs[0], to: vs[0], properties: {} });
  g.addEdge({ id: 'l3', labels: ['T'], from: vs[3], to: vs[3], properties: {} });

  return g;
};

/** The same shape with no loop, so a rung that only works on looped graphs is caught. */
const plain = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: i === 5 ? ['Q'] : ['P'], properties: { k: i } }),
  );

  g.addEdge({ id: 'a', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
  g.addEdge({ id: 'b', labels: ['T'], from: vs[1], to: vs[2], properties: {} });
  g.addEdge({ id: 'c', labels: ['T'], from: vs[2], to: vs[3], properties: {} });
  g.addEdge({ id: 'd', labels: ['T'], from: vs[3], to: vs[4], properties: {} });
  g.addEdge({ id: 'e', labels: ['T'], from: vs[1], to: vs[5], properties: {} });

  return g;
};

describe('a filtered chain with undirected legs', () => {
  for (const [name, fixture] of [
    ['two self-loops', looped],
    ['loop-free', plain],
  ] as ReadonlyArray<readonly [string, () => Graph]>) {
    describe(name, () => {
      test('THREE undirected legs, per start', () => {
        const g = fixture();

        // One start at a time, so a per-vertex error cannot cancel against another's — and the
        // oracle is independent, so each is a real comparison.
        for (let k = 0; k < 6; k += 1) {
          expect(
            both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d)', `WHERE a.k = ${k}`),
          ).toBeGreaterThanOrEqual(0);
        }

        expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
      });

      test('FOUR undirected legs', () => {
        const g = fixture();

        expect(
          both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d)-[:T]-(x)', 'WHERE a.k >= 0'),
        ).toBeGreaterThan(0);
      });

      test('MIXED directions, each position undirected in turn', () => {
        const g = fixture();

        for (const pattern of [
          '(a:P)-[:T]-(b)-[:T]->(c)-[:T]->(d)',
          '(a:P)-[:T]->(b)-[:T]-(c)-[:T]->(d)',
          '(a:P)-[:T]->(b)-[:T]->(c)-[:T]-(d)',
          '(a:P)-[:T]-(b)-[:T]->(c)-[:T]-(d)',
          '(a:P)<-[:T]-(b)-[:T]-(c)-[:T]->(d)',
        ]) {
          expect(both(g, pattern, 'WHERE a.k >= 0')).toBeGreaterThanOrEqual(0);
        }
      });

      test('the LAST leg undirected is the degree tail, which is where the first cut was HALF', () => {
        const g = fixture();
        const lastBoth = both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]-(d)', 'WHERE a.k >= 0');
        const lastOut = both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)', 'WHERE a.k >= 0');

        // The undirected last leg must be STRICTLY more than the directed one on these fixtures —
        // a halved tail would land at or below it, which is exactly the bug item 484's tests saw.
        expect(lastBoth).toBeGreaterThan(lastOut);
      });

      test('a LABEL at the end, and a GATE at the end', () => {
        const g = fixture();

        expect(
          both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d:Q)', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
        expect(
          both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d {k: 2})', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
        // A gate on the last position forces the extra pass rather than the degree tail, so this
        // is the OTHER branch of the same decision.
        expect(
          both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d {k: 3})', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
      });

      test('an INTERIOR label and gate', () => {
        const g = fixture();

        expect(
          both(g, '(a:P)-[:T]-(b:P)-[:T]-(c)-[:T]-(d)', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
        expect(
          both(g, '(a:P)-[:T]-(b {k: 1})-[:T]-(c)-[:T]-(d)', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
      });

      test('the DIRECTED chain is unchanged', () => {
        const g = fixture();

        expect(
          both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
        expect(
          both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)', 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
      });
    });
  }
});

describe('the self-loop is counted ONCE per undirected leg', () => {
  test('a loop on the start, the interior and the end', () => {
    // Three separate fixtures, each with the loop in one position, so a correction applied in the
    // wrong place cannot hide behind one applied in the right place.
    for (const at of [0, 1, 2]) {
      const g = new Graph();
      const vs = Array.from({ length: 3 }, (_, i) =>
        g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
      );

      g.addEdge({ id: 'a', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
      g.addEdge({ id: 'b', labels: ['T'], from: vs[1], to: vs[2], properties: {} });
      g.addEdge({ id: `l${at}`, labels: ['T'], from: vs[at], to: vs[at], properties: {} });

      expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
      expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
    }
  });
});
