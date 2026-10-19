// A `count(*)` over a TRAIL of depth 3 (`-[:K]->{3}`) takes the level recurrence plus an
// inclusion-exclusion correction (item 601). The recurrence counts WALKS; a trail forbids reusing
// an edge, and at depth 3 the walks to exclude are exactly those where two of `e0, e1, e2`
// coincide.
//
// WHY THIS FILE EXISTS, AND WHY IT BRUTE-FORCES. The shortcut returns a plausible number whichever
// way the arithmetic lands, so no timing and no smoke test can tell a correct correction from a
// wrong one. `examples/README.md`'s warning applies directly here: the integration probes "do
// assert answers, and they passed while the engine returned wrong rows — three times", because
// their fixtures give every node the same label and ask for `count(*)`. So this file counts the
// trails by ENUMERATION and compares, over randomized graphs.
//
// The fixture generator deliberately admits the two shapes that break a naive correction:
//
//   - SELF-LOOPS, which are the whole of the `e0 == e1` and `e1 == e2` cases and are also the one
//     walk the depth-2 trail correction already subtracted;
//   - PARALLEL EDGES, because two parallel `a -> b` edges make `e0, b -> a, e2` a VALID trail when
//     `e0 !== e2` — so the `e0 == e2` term must subtract one walk per reverse edge, not "one if a
//     reverse edge exists". A version that treated it as a boolean passes every hand-written case
//     and fails here.
//
// A one-fixture check cannot witness either, which is the same trap item 600 recorded: I expected
// the fixed chain to be the slow spelling and the measurement said the opposite, because the
// ANSWERS differed (a chain is a walk, a quantified path is a trail).
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { query } from './index.js';

/** A deterministic LCG, so a failure replays. */
const lcg = (seed: number) => {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 0x1_0000_0000;
  };
};

type Built = { graph: Graph; edges: [number, number][] };

const build = (v: number, m: number, rnd: () => number): Built => {
  const graph = new Graph();
  const vs: Vertex[] = [];

  for (let i = 0; i < v; i += 1) {
    vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
  }

  const edges: [number, number][] = [];

  for (let e = 0; e < m; e += 1) {
    // No constraint against `a === b` or against repeating a pair: self-loops and parallel edges
    // are the cases under test.
    const a = Math.floor(rnd() * v);
    const b = Math.floor(rnd() * v);

    graph.addEdge({ id: `e${e}`, from: vs[a], to: vs[b], labels: ['K'], properties: {} });
    edges.push([a, b]);
  }

  return { graph, edges };
};

/** Trails of length 3 by enumeration — three distinct edges, following the chain. */
const brute = (
  v: number,
  edges: [number, number][],
  endPasses?: (n: number) => boolean,
): number => {
  const out: number[][] = Array.from({ length: v }, () => []);

  for (let e = 0; e < edges.length; e += 1) {
    out[edges[e][0]].push(e);
  }

  let n = 0;

  for (let e0 = 0; e0 < edges.length; e0 += 1) {
    for (const e1 of out[edges[e0][1]]) {
      for (const e2 of out[edges[e1][1]]) {
        if (e0 !== e1 && e1 !== e2 && e0 !== e2 && (endPasses?.(edges[e2][1]) ?? true)) {
          n += 1;
        }
      }
    }
  }

  return n;
};

const counted = (graph: Graph, q: string): number =>
  (query(graph, q)[0] as { c: number } | undefined)?.c ?? -1;

describe('a count over a depth-3 trail', () => {
  test('matches enumeration over 200 random graphs with self-loops and parallel edges', () => {
    const rnd = lcg(20_261_019);
    let checked = 0;
    let withSelfLoop = 0;
    let withParallel = 0;
    let withReverse = 0;

    for (let trial = 0; trial < 200; trial += 1) {
      const v = 2 + Math.floor(rnd() * 5);
      const m = 1 + Math.floor(rnd() * 12);
      const { graph, edges } = build(v, m, rnd);

      // Record that the generator actually PRODUCED the shapes this test claims to cover — a
      // generator that never emits a self-loop would make the whole file vacuous, and nothing
      // else here would say so.
      if (edges.some(([a, b]) => a === b)) {
        withSelfLoop += 1;
      }

      const seen = new Set<string>();

      for (const [a, b] of edges) {
        if (seen.has(`${a}>${b}`)) {
          withParallel += 1;
        }

        seen.add(`${a}>${b}`);
      }

      if (edges.some(([a, b]) => edges.some(([c, d]) => c === b && d === a))) {
        withReverse += 1;
      }

      expect(counted(graph, 'MATCH (a:P)-[:K]->{3}(d) RETURN count(*) AS c')).toBe(brute(v, edges));
      checked += 1;
    }

    expect(checked).toBe(200);
    // The coverage assertions. Each shape must appear in a decent share of trials, or this test is
    // asserting less than it looks like it does.
    expect(withSelfLoop).toBeGreaterThan(20);
    expect(withParallel).toBeGreaterThan(20);
    expect(withReverse).toBeGreaterThan(20);
  });

  test('an endpoint predicate applies to the trail, not to the walk', () => {
    const rnd = lcg(777);

    for (let trial = 0; trial < 120; trial += 1) {
      const v = 2 + Math.floor(rnd() * 5);
      const m = 1 + Math.floor(rnd() * 12);
      const { graph, edges } = build(v, m, rnd);
      // `n` is the vertex index, so this keeps the even-indexed endpoints — a mask that rejects
      // some but not all, which is what distinguishes a correction applied at the right node from
      // one applied everywhere.
      const want = (n: number) => n % 2 === 0;

      expect(
        counted(graph, 'MATCH (a:P)-[:K]->{3}(d) WHERE d.n % 2 = 0 RETURN count(*) AS c'),
      ).toBe(brute(v, edges, want));
    }
  });

  test('the multi-level forms sum each level with its own correction', () => {
    // `{1,3}` and `{2,3}` sum levels that have DIFFERENT corrections: level 1 needs none (one edge
    // cannot repeat), level 2 subtracts the self-loop taken twice, level 3 the four-term form. A
    // correction applied once for the whole range rather than per level passes `{3}` and fails
    // these.
    const rnd = lcg(4242);

    const brute1 = (v: number, edges: [number, number][]): number => edges.length;
    const brute2 = (v: number, edges: [number, number][]): number => {
      const out: number[][] = Array.from({ length: v }, () => []);

      for (let e = 0; e < edges.length; e += 1) {
        out[edges[e][0]].push(e);
      }

      let n = 0;

      for (let e0 = 0; e0 < edges.length; e0 += 1) {
        for (const e1 of out[edges[e0][1]]) {
          if (e0 !== e1) {
            n += 1;
          }
        }
      }

      return n;
    };

    for (let trial = 0; trial < 120; trial += 1) {
      const v = 2 + Math.floor(rnd() * 5);
      const m = 1 + Math.floor(rnd() * 12);
      const { graph, edges } = build(v, m, rnd);
      const l1 = brute1(v, edges);
      const l2 = brute2(v, edges);
      const l3 = brute(v, edges);

      expect(counted(graph, 'MATCH (a:P)-[:K]->{1,3}(d) RETURN count(*) AS c')).toBe(l1 + l2 + l3);
      expect(counted(graph, 'MATCH (a:P)-[:K]->{2,3}(d) RETURN count(*) AS c')).toBe(l2 + l3);
    }
  });

  test('a TRAIL of depth 4 is still correct — the bound at 3 is a CORRECTNESS guard', () => {
    // `takesTheLevelRecurrence` admits a trail at EXACTLY 3. Relaxing that to `max >= 3` — the
    // one edit a future reader is most likely to make, since the walk branch has no bound —
    // SURVIVED every other test here: nothing exercised a trail past depth 3, so a depth-4 trail
    // would have quietly received the WALK count.
    //
    // Item 600 derived the depth-3 correction and explicitly did not derive depth 4, where the
    // coinciding pairs start interacting. So depth 4 must keep ENUMERATING, and the only way to
    // say that in a test is to assert the answer it enumerates.
    const rnd = lcg(90_210);

    const brute4 = (v: number, edges: [number, number][]): number => {
      const out: number[][] = Array.from({ length: v }, () => []);

      for (let e = 0; e < edges.length; e += 1) {
        out[edges[e][0]].push(e);
      }

      let n = 0;

      for (let e0 = 0; e0 < edges.length; e0 += 1) {
        for (const e1 of out[edges[e0][1]]) {
          for (const e2 of out[edges[e1][1]]) {
            for (const e3 of out[edges[e2][1]]) {
              if (new Set([e0, e1, e2, e3]).size === 4) {
                n += 1;
              }
            }
          }
        }
      }

      return n;
    };

    let sawADifference = 0;

    for (let trial = 0; trial < 120; trial += 1) {
      const v = 2 + Math.floor(rnd() * 5);
      const m = 1 + Math.floor(rnd() * 12);
      const { graph, edges } = build(v, m, rnd);
      const trail4 = brute4(v, edges);

      expect(counted(graph, 'MATCH (a:P)-[:K]->{4}(d) RETURN count(*) AS c')).toBe(trail4);

      // The assertion above is only meaningful on fixtures where the trail and the walk DIFFER —
      // otherwise the mutant's answer coincides with the right one. Count how often they do.
      const out: number[][] = Array.from({ length: v }, () => []);

      for (let e = 0; e < edges.length; e += 1) {
        out[edges[e][0]].push(e);
      }

      let walk4 = 0;

      for (const [, to0] of edges) {
        for (const e1 of out[to0]) {
          for (const e2 of out[edges[e1][1]]) {
            walk4 += out[edges[e2][1]].length;
          }
        }
      }

      if (walk4 !== trail4) {
        sawADifference += 1;
      }
    }

    expect(sawADifference).toBeGreaterThan(20);
  });

  test('a WALK of depth 3 is unchanged — it must NOT get the trail correction', () => {
    // The control: the same depth in the other mode. A correction leaking into the walk branch
    // answers fewer paths than there are, and this is the only test here that would notice.
    const rnd = lcg(31_337);

    const bruteWalk = (v: number, edges: [number, number][]): number => {
      const out: number[][] = Array.from({ length: v }, () => []);

      for (let e = 0; e < edges.length; e += 1) {
        out[edges[e][0]].push(e);
      }

      let n = 0;

      for (const [, to0] of edges) {
        for (const e1 of out[to0]) {
          n += out[edges[e1][1]].length;
        }
      }

      return n;
    };

    for (let trial = 0; trial < 120; trial += 1) {
      const v = 2 + Math.floor(rnd() * 5);
      const m = 1 + Math.floor(rnd() * 12);
      const { graph, edges } = build(v, m, rnd);

      expect(counted(graph, 'MATCH WALK (a:P)-[:K]->{3}(d) RETURN count(*) AS c')).toBe(
        bruteWalk(v, edges),
      );
    }
  });
});
