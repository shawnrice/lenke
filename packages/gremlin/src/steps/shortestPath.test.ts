import { describe, expect, test } from 'bun:test';

import type { Vertex } from '@pl-graph/core';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { has, ShortestPath, shortestPath, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];
const ids = (paths: unknown[]): string[][] => (paths as Vertex[][]).map((p) => p.map((v) => v.id));

describe('shortestPath() — shortest vertex paths from each source', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().has('name','marko').shortestPath()
  //          .with(ShortestPath.target, __.has('name','josh')) → [v[1], v[4]]
  test('target via with() option — marko → josh', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', 'marko'),
          shortestPath().with(ShortestPath.target, has('name', 'josh')),
        ),
        g,
      ),
    );
    expect(ids(r)).toEqual([['1', '4']]); // marko —knows→ josh (one hop)
  });

  test('multi-hop shortest path — marko → ripple', () => {
    // marko(1) —knows→ josh(4) —created→ ripple(5): two hops, the shortest route
    // (the marko→lop→josh→ripple chain is longer).
    const r = arr(
      run(
        traversal(
          V(),
          has('name', 'marko'),
          shortestPath().with(ShortestPath.target, has('name', 'ripple')),
        ),
        g,
      ),
    );
    expect(ids(r)).toEqual([['1', '4', '5']]);
  });

  test('no target ⇒ a path to every reachable vertex (incl. the trivial self path)', () => {
    const r = arr(run(traversal(V(), has('name', 'marko'), shortestPath()), g));
    const reached = new Set((r as Vertex[][]).map((p) => p[p.length - 1]!.id));
    // marko reaches everyone in the connected modern graph, including itself.
    expect(reached).toEqual(new Set(['1', '2', '3', '4', '5', '6']));
  });
});
