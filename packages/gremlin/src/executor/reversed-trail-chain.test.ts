/*
 * Item 2130 — `reversedTrailChain`: `[out, out, has]` answered as `[has, in, in]`.
 *
 * 🔑 THE REWRITE IS A BIJECTION ON PATHS. The k-hop OUT-paths from any vertex that END at a vertex
 * passing P correspond one-to-one with the k-hop IN-paths that START at a P-passing vertex — reverse each
 * path. A count is order-free, so the two are the same number, and self-loops and parallel edges need no
 * special case because reversal maps each walk to exactly one walk.
 *
 * ⚠️⚠️ **WHY IT EXISTS: WITHOUT IT, THE OTHER HALF OF ITEM 2130 OPENS A 9.4x EQUIVALENT-SPELLING GAP.**
 * Giving the LEADING spelling the CSR propagation and leaving the trailing one on its far-driven walk
 * measured **13.31 ms against 125.52 for the identical answer** (2,499,750). Nothing got slower; the gap
 * alone is the defect this repo is organised around. After both halves: 12.07 and 14.15, a 1.17x spread.
 *
 * ⚠️ **A ROUTE REWRITE IS ANSWER-EQUIVALENT, so the engine's own tests cannot see a mutant of the
 * ROUTING** — `[[perf-gate-needs-its-own-test]]`. What they CAN see is the rewrite computing the wrong
 * thing, which is what this file pins: every case below is checked against a BRUTE-FORCE enumeration
 * written in the test, not against a literal I chose.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { V, both, count, eq, gt, has, hasLabel, in_, out, toArray, traversal } from '../index.js';
import { denseChainCount, reversedTrailChain } from './count-shortcut.js';

/**
 * 60 vertices, out-degree 3, so 3-hop paths are plentiful (3^3 per vertex) and a trailing filter has
 * something to reject. ⚠️ The three edges per vertex use DISTINCT offsets so the fan-out is real — a
 * `(a*k + b) % N` generator keyed on one index alone sends a vertex's whole fan-out to one target
 * (items 1516/1518), which no degree check catches.
 */
const M = 60;
const graph = new Graph();

for (let i = 0; i < M; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: i % 4 === 0 ? ['A', 'B'] : ['A'],
    properties: { k: i % 5, team: `t${i % 3}` },
  });
}

let edgeId = 0;

for (let i = 0; i < M; i += 1) {
  for (let d = 1; d <= 3; d += 1) {
    graph.addEdge({
      id: `x${edgeId}`,
      from: graph.getVertexById(`v${i}`)!,
      to: graph.getVertexById(`v${(i * 7 + d) % M}`)!,
      labels: ['E'],
      properties: {},
    });
    edgeId += 1;
  }
}

/** The fan-out is real: v0's three edges must reach three DISTINCT targets. */
const firstTargets = new Set<string>();

for (const edge of graph.getVertexById('v0')!.adjFrom?.get('E') ?? []) {
  firstTargets.add(edge.to.id);
}

/** Brute-force count of k-hop paths (following `out` or `in`) whose END vertex passes `keep`. */
const brute = (k: number, forward: boolean, keep: (v: Vertex) => boolean): number => {
  let found = 0;

  const walk = (v: Vertex, depth: number): void => {
    if (depth === k) {
      if (keep(v)) {
        found += 1;
      }

      return;
    }

    for (const edge of (forward ? v.adjFrom : v.adjTo)?.get('E') ?? []) {
      walk(forward ? edge.to : edge.from, depth + 1);
    }
  };

  for (const v of graph.verticesById.values()) {
    walk(v, 0);
  }

  return found;
};

const answered = (plan: Parameters<typeof toArray>[0]): unknown => toArray(plan, graph)[0];

describe('reversedTrailChain (item 2130)', () => {
  test('⚠️ the fixture is not degenerate — three edges, three distinct targets', () => {
    // Guards every number below: a functional graph answers k-hop counts correctly and measures wrong.
    expect(firstTargets.size).toBe(3);
  });

  describe('the ANSWER matches brute force at every depth', () => {
    test('two hops', () => {
      expect(answered(traversal(V(), out('E'), out('E'), has('k', gt(2)), count()))).toBe(
        brute(2, true, (v) => (v.properties.k as number) > 2),
      );
    });

    test('three hops — the depth the old route declined', () => {
      expect(answered(traversal(V(), out('E'), out('E'), out('E'), has('k', gt(2)), count()))).toBe(
        brute(3, true, (v) => (v.properties.k as number) > 2),
      );
    });

    test('four hops', () => {
      expect(
        answered(traversal(V(), out('E'), out('E'), out('E'), out('E'), has('k', gt(2)), count())),
      ).toBe(brute(4, true, (v) => (v.properties.k as number) > 2));
    });

    test('⚠️ the IN direction — the flip must not be hard-coded one way', () => {
      expect(answered(traversal(V(), in_('E'), in_('E'), in_('E'), has('k', gt(2)), count()))).toBe(
        brute(3, false, (v) => (v.properties.k as number) > 2),
      );
    });

    test('a trailing `hasLabel`, where the labels are NOT a partition', () => {
      // Every 4th vertex carries both `A` and `B`, so `hasLabel` is not a label partition here.
      expect(answered(traversal(V(), out('E'), out('E'), out('E'), hasLabel('B'), count()))).toBe(
        brute(3, true, (v) => v.labels.has('B')),
      );
    });

    test('TWO trailing filters compose', () => {
      expect(
        answered(
          traversal(
            V(),
            out('E'),
            out('E'),
            out('E'),
            hasLabel('B'),
            has('team', eq('t0')),
            count(),
          ),
        ),
      ).toBe(brute(3, true, (v) => v.labels.has('B') && v.properties.team === 't0'));
    });
  });

  test('⚠️⚠️ the CSR route answers a PARTIAL seed set — the capability item 2130 relies on', () => {
    /*
     * 🔑 THE POINT OF THE WHOLE ITEM. `slotChainCount` propagates multiplicities over a CSR and needs no
     * identity, so it works from an ARBITRARY seed set — it was simply never called with filtered seeds
     * (its only call site sat inside the `unfiltered` branch). The unfiltered route is an O(V) degree
     * identity that a filter of any kind invalidates, which is why the filtered form cost 123 ms against
     * the unfiltered 14.
     *
     * ⚠️ THIS TEST EXISTS BECAUSE NO ANSWER-COMPARING TEST CAN SEE IT: replacing the call with
     * `undefined` falls back to the per-edge walk, which answers identically, so that mutant SURVIVES by
     * construction. Asserting the function answers for a partial seed set is the strongest check
     * available — and it pins the ANSWER too, against an enumeration.
     *
     * ⚠️⚠️ ITS OWN FIXTURE, AND THE SEED FLOOR IS WHY. `denseChainCount` refuses unless
     * `seeds.length > max(vertexCount >> 4, 1024)` — the floor that keeps a small source off a
     * whole-graph CSR build. The 60-vertex fixture above can NEVER clear 1024, so this needs a bigger
     * one; the small fixture's decline is pinned in the next test rather than left as a silent pass.
     */
    const big = new Graph();
    const BIG = 4000;

    for (let i = 0; i < BIG; i += 1) {
      big.addVertex({ id: `b${i}`, labels: ['A'], properties: { k: i % 5 } });
    }

    let id = 0;

    for (let i = 0; i < BIG; i += 1) {
      for (let d = 1; d <= 2; d += 1) {
        big.addEdge({
          id: `y${id}`,
          from: big.getVertexById(`b${i}`)!,
          to: big.getVertexById(`b${(i * 7 + d) % BIG}`)!,
          labels: ['E'],
          properties: {},
        });
        id += 1;
      }
    }

    const seeds = [...big.verticesById.values()].filter((v) => (v.properties.k as number) > 2);
    const hops = [
      { kind: 'out' as const, labels: ['E'] },
      { kind: 'out' as const, labels: ['E'] },
    ];
    const got = denseChainCount(hops, seeds, big);

    // ⚠️ A PARTIAL seed set above the floor — exactly what the old route could not take.
    expect(seeds.length).toBeGreaterThan(Math.max(BIG >> 4, 1024));
    expect(seeds.length).toBeLessThan(BIG);
    expect(got).not.toBeUndefined();

    // Two-hop paths STARTING at a passing vertex: the mirror of the trailing-filter question.
    let want = 0;

    for (const seed of seeds) {
      for (const e0 of seed.adjFrom?.get('E') ?? []) {
        for (const _e1 of e0.to.adjFrom?.get('E') ?? []) {
          want += 1;
        }
      }
    }

    expect(got).toBe(want);
  });

  test('⚠️ and it DECLINES below the seed floor, which keeps a small source off a whole-graph CSR', () => {
    // 🔑 The 60-vertex fixture: ~24 passing seeds against a floor of 1024. The decline is the design.
    const seeds = [...graph.verticesById.values()].filter((v) => (v.properties.k as number) > 2);

    expect(seeds.length).toBeLessThan(1024);
    expect(
      denseChainCount(
        [
          { kind: 'out', labels: ['E'] },
          { kind: 'out', labels: ['E'] },
        ],
        seeds,
        graph,
      ),
    ).toBeUndefined();
  });

  describe('the REWRITE itself — what it accepts and refuses', () => {
    const steps = (plan: { steps: readonly unknown[] }): readonly unknown[] => plan.steps;
    const mid = (plan: { steps: readonly unknown[] }): readonly unknown[] =>
      steps(plan).slice(1, -1);

    test('🔑 `[out, out, has]` becomes `[has, in, in]` — filters first, hops flipped and reversed', () => {
      const got = reversedTrailChain(
        mid(traversal(V(), out('E'), out('E'), has('k', gt(2)), count())) as never,
      );

      expect(got?.map((s) => s.kind)).toStrictEqual(['has', 'in', 'in']);
    });

    test('🔑 `in` flips to `out`, and the HOP ORDER reverses', () => {
      /*
       * ⚠️ The order matters as soon as the hops differ. `[out, in, has]` must become `[has, out, in]`:
       * reversed to `[in, out]` and then each flipped to `[out, in]`.
       */
      const got = reversedTrailChain(
        mid(traversal(V(), out('E'), in_('E'), has('k', gt(2)), count())) as never,
      );

      expect(got?.map((s) => s.kind)).toStrictEqual(['has', 'out', 'in']);
    });

    test('⚠️ NO trailing filter is refused — the unreversed call already answered it', () => {
      expect(
        reversedTrailChain(mid(traversal(V(), out('E'), out('E'), count())) as never),
      ).toBeUndefined();
    });

    test('⚠️ ONE hop is refused — that is `filteredHopCount`, which already drives the far side', () => {
      expect(
        reversedTrailChain(mid(traversal(V(), out('E'), has('k', gt(2)), count())) as never),
      ).toBeUndefined();
    });

    test('⚠️ `both` is refused — its reverse is itself, so the rewrite would not progress', () => {
      expect(
        reversedTrailChain(
          mid(traversal(V(), both('E'), both('E'), has('k', gt(2)), count())) as never,
        ),
      ).toBeUndefined();
    });

    test('⚠️⚠️ a LEADING filter is refused — both ends filtered is not this rewrite', () => {
      /*
       * 🔑 The hop scan starts at index 0, so `[hasLabel, out, out, has]` yields NO hops and declines.
       * That shape stays with `trailingFilteredHopCount` (item 1612), which handles a lead filter.
       * ⚠️ And it must still answer correctly — asserted against brute force, not just routed away.
       */
      expect(
        reversedTrailChain(
          mid(traversal(V(), hasLabel('A'), out('E'), out('E'), has('k', gt(2)), count())) as never,
        ),
      ).toBeUndefined();

      const withLead = answered(
        traversal(V(), hasLabel('A'), out('E'), out('E'), has('k', gt(2)), count()),
      );

      // Every vertex carries `A`, so the lead filter keeps all starts and the count is the plain one.
      expect(withLead).toBe(brute(2, true, (v) => (v.properties.k as number) > 2));
    });

    test('⚠️ a non-filter trailing step is refused', () => {
      // `dedupe` is not a vertex filter: reversing the chain around it would change the answer.
      expect(
        reversedTrailChain([
          { kind: 'out', labels: ['E'] },
          { kind: 'out', labels: ['E'] },
          { kind: 'dedupe' },
        ] as never),
      ).toBeUndefined();
    });
  });
});
