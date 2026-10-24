import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index';

/**
 * The bounded trail/walk COUNT routes, against brute-force enumeration over randomized graphs.
 *
 * This oracle exists because of a specific hazard item 602 recorded. While native enumerated the
 * trail, the seven byte-identity fuzzers checked the TS closed form against a DIFFERENT
 * implementation for free. Both engines now run the same depth-3 formula, so those fuzzers prove
 * only that the two AGREE — they would pass on a shared wrong answer. Something has to compare the
 * formula against enumeration, and nothing in the repo did.
 *
 * Item 689 also found that the depth-3 correction had never been brute-forced PER SOURCE: item 600
 * validated the total on one fixture. A per-source error that cancels in the total is exactly what
 * a total cannot see, and the depth-4 work (687-689) builds directly on the per-source value.
 *
 * The three things that separate a trail from a walk are SELF-LOOPS, PARALLEL EDGES and REVERSE
 * EDGES (item 600: parallel edges are what break a naive version). The generator is biased to
 * produce all three, and the test ASSERTS it produced them — otherwise a green run would mean the
 * generator, not the engine.
 */

type Edge = [number, number];

// A tiny deterministic LCG, so a failure is replayable from the seed in the message.
const lcg = (seed: number) => {
  let s = seed;

  return (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;

    return s / 0x7fffffff;
  };
};

const makeGraph = (n: number, edges: readonly Edge[]): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ labels: ['P'], properties: { n: i } }));
  }

  for (const [u, v] of edges) {
    g.addEdge({ from: vs[u], to: vs[v], labels: ['K'] });
  }

  return g;
};

/**
 * Walks of between `min` and `max` edges; `trail` additionally forbids reusing an edge, and
 * `endOk` filters the ENDPOINT of each emitted path.
 *
 * The `min`/`max` RANGE and the endpoint predicate are both here because mutation said so. With
 * exact depths only, "the level-2 correction is dropped" SURVIVED — `trail3` is
 * `isTrail && max === 3`, so for `{2}` that block never runs at all (depth 2 goes to the
 * `max <= 2` route) and the level-2 branch fires only inside a range like `{1,3}`. With no
 * endpoint predicate, "the raw out-degree instead of the PASSING one" survived too, because
 * `pass[x]` is 1 everywhere and the two degrees coincide.
 */
const brute = (
  n: number,
  edges: readonly Edge[],
  min: number,
  max: number,
  trail: boolean,
  endOk: (v: number) => boolean = () => true,
): number => {
  const out: number[][] = Array.from({ length: n }, () => []);

  edges.forEach(([u], i) => out[u].push(i));

  let count = 0;
  const walk = (at: number, used: number[]): void => {
    if (used.length >= min && used.length <= max && used.length > 0 && endOk(at)) {
      count += 1;
    }

    if (used.length === max) {
      return;
    }

    for (const e of out[at]) {
      if (trail && used.includes(e)) {
        continue;
      }

      used.push(e);
      walk(edges[e][1], used);
      used.pop();
    }
  };

  for (let v = 0; v < n; v += 1) {
    walk(v, []);
  }

  return count;
};

describe('bounded trail/walk counts agree with enumeration', () => {
  test('depth 1-3, TRAIL and WALK, over randomized multigraphs', () => {
    const rnd = lcg(20261024);
    let selfLoopGraphs = 0;
    let parallelGraphs = 0;
    let reverseGraphs = 0;
    let differed = 0;

    for (let trial = 0; trial < 60; trial += 1) {
      const n = 3 + Math.floor(rnd() * 5);
      const m = 2 + Math.floor(rnd() * 10);
      const edges: Edge[] = [];

      for (let i = 0; i < m; i += 1) {
        const u = Math.floor(rnd() * n);
        // A deliberate self-loop bias: at uniform random they are too rare to test the terms
        // that exist for them.
        const v = rnd() < 0.22 ? u : Math.floor(rnd() * n);

        edges.push([u, v]);
      }

      if (edges.some(([u, v]) => u === v)) {
        selfLoopGraphs += 1;
      }

      if (edges.some(([u, v], i) => edges.findIndex(([x, y]) => x === u && y === v) !== i)) {
        parallelGraphs += 1;
      }

      if (edges.some(([u, v]) => u !== v && edges.some(([x, y]) => x === v && y === u))) {
        reverseGraphs += 1;
      }

      const g = makeGraph(n, edges);
      const got = (q: string): number => (query(g, q)[0] as { c: number }).c;

      // EXACT depths, then RANGES. A range is what exercises the per-level corrections: a
      // correction applied once for the whole range answers `{3,3}` right and `{1,3}` wrong
      // (item 602), and the level-2 branch is only reachable through one.
      for (const [lo, hi] of [
        [1, 1],
        [2, 2],
        [3, 3],
        [1, 3],
        [2, 3],
      ] as const) {
        const q = lo === hi ? `{${lo}}` : `{${lo},${hi}}`;
        const wantTrail = brute(n, edges, lo, hi, true);
        const wantWalk = brute(n, edges, lo, hi, false);

        // No mode keyword is a TRAIL (`parsePathMode` returns 'trail'), which is the default
        // spelling and the one item 601 found nothing was watching.
        expect(got(`MATCH (a)-[:K]->${q}(y) RETURN count(*) AS c`)).toBe(wantTrail);
        expect(got(`MATCH WALK (a)-[:K]->${q}(y) RETURN count(*) AS c`)).toBe(wantWalk);

        // An ENDPOINT PREDICATE, carried rather than refused since item 583. It makes the
        // endpoint mask non-trivial, which is what tells the PASSING out-degree apart from the
        // raw one.
        const wantFiltered = brute(n, edges, lo, hi, true, (v) => v > 0);

        expect(got(`MATCH (a)-[:K]->${q}(y) WHERE y.n > 0 RETURN count(*) AS c`)).toBe(
          wantFiltered,
        );

        if (wantTrail !== wantWalk) {
          differed += 1;
        }
      }
    }

    // The generator has to have produced the structures the trail terms exist for, or a green
    // run says nothing about them.
    expect(selfLoopGraphs).toBeGreaterThan(20);
    expect(parallelGraphs).toBeGreaterThan(10);
    expect(reverseGraphs).toBeGreaterThan(10);
    // ... and the trail and walk answers have to actually DIVERGE somewhere, or both spellings
    // could be answered by one formula and the test could not tell.
    expect(differed).toBeGreaterThan(20);
  });

  test('the depth-3 correction is right PER SOURCE, not just in the total', () => {
    // Item 689's gap: item 600 validated the depth-3 total. A per-source error that cancels in
    // the total is invisible to that, and items 687-689 build on the per-source value.
    //
    // A fixture chosen so the per-source counts are UNEQUAL — with equal counts a mix-up between
    // sources would not show.
    const edges: Edge[] = [
      [0, 1],
      [0, 1], // parallel
      [1, 2],
      [2, 0], // reverse path back
      [1, 1], // self-loop at the busy middle
      [2, 3],
      [3, 0],
    ];
    const n = 4;
    const g = makeGraph(n, edges);

    const perSource = (v: number): number => {
      const out: number[][] = Array.from({ length: n }, () => []);

      edges.forEach(([u], i) => out[u].push(i));

      let count = 0;
      const walk = (at: number, used: number[]): void => {
        if (used.length === 3) {
          count += 1;

          return;
        }

        for (const e of out[at]) {
          if (used.includes(e)) {
            continue;
          }

          used.push(e);
          walk(edges[e][1], used);
          used.pop();
        }
      };

      walk(v, []);

      return count;
    };

    const counts = [0, 1, 2, 3].map(perSource);

    // The fixture's own claim: the sources differ, so this test can see a per-source mix-up.
    expect(new Set(counts).size).toBeGreaterThan(2);

    for (let v = 0; v < n; v += 1) {
      const got = query(g, `MATCH (a {n: ${v}})-[:K]->{3}(y) RETURN count(*) AS c`) as {
        c: number;
      }[];

      expect(got[0]?.c).toBe(counts[v]);
    }
  });
});
