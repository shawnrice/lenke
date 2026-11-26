/*
 * Item 2131 — an UNFILTERED chain count is memoized per topology generation.
 *
 * THE GQL TWIN ALREADY DID THIS (item 1890 put the degree product on its CSR), and the gap it left was
 * the biggest cross-language one measured. Steady state, 200,000 vertices / 1,000,000 edges, identical
 * question and identical answer (5,000,000): GQL **0.3-0.5 ms** against Gremlin's **10.6-15.4**. After
 * this item Gremlin reads **0.0-0.1**.
 *
 * **THE WHOLE RISK IS STALENESS, SO THAT IS WHAT THIS FILE TESTS.** A cached count that outlives the
 * thing it counted is a WRONG ANSWER, and it is the kind no timing probe and no answer-comparing test
 * finds unless the test MUTATES THE GRAPH between two asks. Every test below asks twice with a write in
 * between.
 *
 * THE KEY IS `graph.topologyVersion`, chosen for two measured properties:
 *
 *   - it advances SYNCHRONOUSLY on an edge or vertex write (verified: 2 -> 4 on `addEdge`, unchanged
 *     across a microtask drain) — unlike `version`/`epoch`, which advance only ON the drain and whose
 *     use as a cache key cost item 1646 its design;
 *   - it does NOT advance on a PROPERTY write — which is exactly why only the UNFILTERED count may be
 *     cached. A filtered count reads properties, so caching one on this key would go stale silently.
 *     The last describe block is that boundary.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { V, count, gt, has, in_, out, toArray, traversal } from '../index.js';

/** A small ring where every vertex has out-degree 2, so a 2-hop count is 4 per vertex. */
const ringOf = (n: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 3 } });
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

const twoHop = (g: Graph): unknown => toArray(traversal(V(), out('E'), out('E'), count()), g)[0];

describe('the unfiltered chain-count memo (item 2131)', () => {
  describe('it must GO STALE on a topology write — asked twice with a write between', () => {
    test('an ADDED edge changes the answer', () => {
      /*
       * THE TEST THE WHOLE ITEM RESTS ON. The first ask populates the memo; the write must drop it.
       * The arithmetic is checked, not just the inequality: one new edge `v0 -> v1` adds `v1`'s
       * out-degree (2 new paths leaving through v1) plus `v0`'s in-degree (2 existing arrivals that can
       * now continue through the new edge) — 4 more.
       */
      const g = ringOf(10);

      expect(twoHop(g)).toBe(40);

      g.addEdge({
        id: 'extra',
        from: g.getVertexById('v0')!,
        to: g.getVertexById('v1')!,
        labels: ['E'],
        properties: {},
      });

      expect(twoHop(g)).toBe(44);
    });

    test('a REMOVED edge changes the answer', () => {
      const g = ringOf(10);

      expect(twoHop(g)).toBe(40);
      g.removeEdge(g.getEdgeById('e0')!);
      // Removing one edge out of v0 drops v1's out-degree worth plus v0's in-degree worth.
      expect(twoHop(g)).toBe(36);
    });

    test('an ADDED vertex invalidates even though this count does not move', () => {
      /*
       * An isolated vertex changes no 2-hop path, so the ANSWER is the same either way and this test
       * cannot catch a stale read by itself. What it pins is that the generation key moves — asserted
       * directly, because the answer cannot assert it.
       */
      const g = ringOf(10);

      expect(twoHop(g)).toBe(40);

      const before = g.topologyVersion;

      g.addVertex({ id: 'lonely', labels: ['P'], properties: {} });

      expect(g.topologyVersion).not.toBe(before);
      expect(twoHop(g)).toBe(40);
    });

    test('TWO writes in a row each invalidate — not just the first', () => {
      const g = ringOf(10);

      expect(twoHop(g)).toBe(40);

      for (const [n, to] of [
        ['x1', 'v1'],
        ['x2', 'v2'],
      ] as const) {
        g.addEdge({
          id: n,
          from: g.getVertexById('v0')!,
          to: g.getVertexById(to)!,
          labels: ['E'],
          properties: {},
        });
      }

      // v0 now has 4 out-edges. Checked against a brute-force enumeration rather than by hand.
      let want = 0;

      for (const v of g.verticesById.values()) {
        for (const e0 of v.adjFrom?.get('E') ?? []) {
          for (const _e1 of e0.to.adjFrom?.get('E') ?? []) {
            want += 1;
          }
        }
      }

      expect(twoHop(g)).toBe(want);
    });
  });

  describe('different SHAPES must not share one entry', () => {
    test('two hops and three hops', () => {
      const g = ringOf(10);

      expect(twoHop(g)).toBe(40);
      expect(toArray(traversal(V(), out('E'), out('E'), out('E'), count()), g)[0]).toBe(80);
    });

    test('`out` and `in` — the direction is part of the key', () => {
      /*
       * In this ring both directions happen to give 40, so the ANSWER cannot separate them. An
       * asymmetric graph can: give one vertex an extra OUT edge and the out-chain count moves while the
       * in-chain count moves differently.
       */
      const g = ringOf(10);

      g.addEdge({
        id: 'skew',
        from: g.getVertexById('v0')!,
        to: g.getVertexById('v5')!,
        labels: ['E'],
        properties: {},
      });

      const [outCount] = toArray(traversal(V(), out('E'), out('E'), count()), g);
      const [inCount] = toArray(traversal(V(), in_('E'), in_('E'), count()), g);

      /*
       * A 2-hop count is actually direction-symmetric (reversing every path is a bijection), so these
       * two are EQUAL by construction and cannot discriminate the key. The label test below is what does
       * — recorded here rather than leaving a test that looks discriminating and is not.
       */
      expect(outCount).toBe(inCount);
    });

    test('two different edge LABELS must not share an entry', () => {
      /*
       * THE DISCRIMINATING SHAPE TEST. `E` and `F` have different topologies, so asking one after the
       * other must give different answers — a key that ignored the label would return the first.
       */
      const g = ringOf(10);

      g.addEdge({
        id: 'f0',
        from: g.getVertexById('v0')!,
        to: g.getVertexById('v1')!,
        labels: ['F'],
        properties: {},
      });
      g.addEdge({
        id: 'f1',
        from: g.getVertexById('v1')!,
        to: g.getVertexById('v2')!,
        labels: ['F'],
        properties: {},
      });

      expect(toArray(traversal(V(), out('E'), out('E'), count()), g)[0]).toBe(40);
      // One `F` path: v0 -> v1 -> v2.
      expect(toArray(traversal(V(), out('F'), out('F'), count()), g)[0]).toBe(1);
      // And back again, to catch a key that is written once and never re-read per shape.
      expect(toArray(traversal(V(), out('E'), out('E'), count()), g)[0]).toBe(40);
    });
  });

  describe('the FILTERED count is NOT cached — a property write must still be seen', () => {
    test('a property write changes a filtered count', () => {
      /*
       * THE SOUNDNESS BOUNDARY OF THE WHOLE ITEM. `topologyVersion` does NOT advance on a property
       * write (verified), so a cached FILTERED count would go stale silently. This test is what fails
       * if the memo's `unfiltered` guard is ever widened.
       */
      const g = ringOf(10);
      const filtered = (): unknown =>
        toArray(traversal(V(), out('E'), out('E'), has('k', gt(1)), count()), g)[0];
      const before = filtered();
      const tv = g.topologyVersion;

      // Make EVERY vertex pass, without touching the topology.
      for (const v of g.verticesById.values() as Iterable<Vertex>) {
        v.properties = { k: 99 };
      }

      expect(g.topologyVersion).toBe(tv);
      expect(filtered()).toBe(40);
      expect(filtered()).not.toBe(before);
    });

    test('and the unfiltered count is unaffected by that same write', () => {
      const g = ringOf(10);

      expect(twoHop(g)).toBe(40);

      for (const v of g.verticesById.values() as Iterable<Vertex>) {
        v.properties = { k: 99 };
      }

      expect(twoHop(g)).toBe(40);
    });
  });
});
