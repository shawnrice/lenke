/**
 * Item 1345's degree gate on the per-endpoint extremum fold.
 *
 * ⚠️ WHY THE ARITHMETIC IS TESTED DIRECTLY. The gate chooses between two routes that return
 * IDENTICAL rows — the per-endpoint fold (item 1246) and the per-row walk it replaces — so every
 * mutation of it is answer-equivalent and survives the differential and fuzzer suites untouched.
 * That is this repo's `perf-gate-needs-its-own-test` rule, and the remedy it prescribes is exactly
 * this: extract the decision as a pure function and unit-test the decision itself.
 *
 * The second half asserts the thing the first half cannot — that flipping routes does not change
 * an ANSWER — at a degree that DECLINES the fold and a degree that ADMITS it.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { endpointFoldBeatsRowWalk } from './executor/hop-endpoint-extremum.js';
import { query } from './index.js';

describe('endpointFoldBeatsRowWalk — the gate arithmetic', () => {
  test('declines at degree 1, where item 1344 measured the fold 1.22x SLOWER', () => {
    expect(endpointFoldBeatsRowWalk(200_000, 200_000)).toBe(false);
  });

  test('admits at degree 3 and above, every degree the fold was measured to WIN', () => {
    expect(endpointFoldBeatsRowWalk(600_000, 200_000)).toBe(true);
    expect(endpointFoldBeatsRowWalk(800_000, 200_000)).toBe(true);
    expect(endpointFoldBeatsRowWalk(1_000_000, 200_000)).toBe(true);
  });

  // The threshold pinned at N and N-1. A gate whose boundary is not pinned is a gate whose
  // constant can drift by one and still pass every test around it.
  test('the boundary is exactly 2 edges per vertex, pinned from both sides', () => {
    expect(endpointFoldBeatsRowWalk(400_000, 200_000)).toBe(true);
    expect(endpointFoldBeatsRowWalk(399_999, 200_000)).toBe(false);
  });

  test('a 2x change in SCALE does not move the decision — only the RATIO does', () => {
    expect(endpointFoldBeatsRowWalk(40, 20)).toBe(true);
    expect(endpointFoldBeatsRowWalk(39, 20)).toBe(false);
    expect(endpointFoldBeatsRowWalk(4_000_000, 2_000_000)).toBe(true);
    expect(endpointFoldBeatsRowWalk(3_999_999, 2_000_000)).toBe(false);
  });

  test('an empty graph admits rather than dividing by zero', () => {
    expect(endpointFoldBeatsRowWalk(0, 0)).toBe(true);
    expect(endpointFoldBeatsRowWalk(5, 0)).toBe(true);
  });

  test('a sparse graph with FEWER edges than vertices declines', () => {
    expect(endpointFoldBeatsRowWalk(10, 1_000)).toBe(false);
  });
});

/**
 * Build `n` vertices each carrying a sortable string, then `n * deg` edges with scattered
 * endpoints, and return the graph alongside the min and max of the REACHED endpoints' names
 * computed independently of the engine — so the expectation is not whatever the engine produced.
 */
const fixture = (n: number, deg: number): { graph: Graph; lo: string; hi: string } => {
  const graph = new Graph();
  const vs = Array.from({ length: n }, (_, i) =>
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { name: `name${i}` } }),
  );
  const reached = new Set<string>();

  for (let k = 0; k < n * deg; k++) {
    const to = (k * 7919) % n;

    graph.addEdge({
      id: `e${k}`,
      from: vs[(k * 31) % n],
      to: vs[to],
      labels: ['T'],
      properties: {},
    });
    reached.add(`name${to}`);
  }

  const names = [...reached].sort();

  return { graph, lo: names[0], hi: names[names.length - 1] };
};

describe('the route flip does not change the answer', () => {
  // deg 1 DECLINES the fold (edgeCount === vertexCount), deg 5 ADMITS it. Both must answer the
  // independently computed extrema.
  for (const deg of [1, 5]) {
    test(`min/max over a hop agree at degree ${deg} (fold ${deg >= 2 ? 'ADMITTED' : 'DECLINED'})`, () => {
      const { graph, lo, hi } = fixture(400, deg);
      const rows = query(
        graph,
        'MATCH (a:P)-[:T]->(x) RETURN min(x.name) AS lo, max(x.name) AS hi',
        {},
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].lo).toBe(lo);
      expect(rows[0].hi).toBe(hi);
      // Not vacuous: an all-null or empty answer would satisfy a looser assertion.
      expect(lo).not.toBe(hi);
    });

    test(`the single-aggregate rung agrees at degree ${deg}`, () => {
      const { graph, hi } = fixture(400, deg);
      const rows = query(graph, 'MATCH (a:P)-[:T]->(x) RETURN max(x.name) AS hi', {});

      expect(rows[0].hi).toBe(hi);
    });
  }

  test('the gate reads the GRAPH, so the same query flips route as edges are added', () => {
    const graph = new Graph();
    const vs = Array.from({ length: 50 }, (_, i) =>
      graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }),
    );

    // One edge per vertex: below the threshold, so the fold declines.
    for (let k = 0; k < 50; k++) {
      graph.addEdge({ id: `a${k}`, from: vs[k], to: vs[(k + 1) % 50], labels: ['T'] });
    }

    expect(endpointFoldBeatsRowWalk(graph.edgeCount, graph.vertexCount)).toBe(false);
    expect(query(graph, 'MATCH (a:P)-[:T]->(x) RETURN max(x.n) AS hi', {})[0].hi).toBe(49);

    // Cross the threshold. Same query, other route, same answer.
    for (let k = 0; k < 60; k++) {
      graph.addEdge({ id: `b${k}`, from: vs[k % 50], to: vs[(k * 3) % 50], labels: ['T'] });
    }

    expect(endpointFoldBeatsRowWalk(graph.edgeCount, graph.vertexCount)).toBe(true);
    expect(query(graph, 'MATCH (a:P)-[:T]->(x) RETURN max(x.n) AS hi', {})[0].hi).toBe(49);
  });
});
