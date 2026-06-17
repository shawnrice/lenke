import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { cap, E, hasLabel, inV, outE, subgraph, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('subgraph() — accumulate matching edges into a named subgraph', () => {
  // doc: g.E().hasLabel('KNOWS').subgraph('sg').cap('sg').next()
  //      → tinkergraph[vertices:3 edges:2]
  test('collect KNOWS edges via cap', () => {
    const g = createTestTinkerGraph();
    const r = arr(run(traversal(E(), hasLabel('KNOWS'), subgraph('sg'), cap('sg')), g));
    expect(r).toHaveLength(1);
    const sg = r[0] as Graph;
    expect(sg.vertexCount).toBe(3); // marko, vadas, josh
    expect(sg.edgeCount).toBe(2); // marko-knows->vadas, marko-knows->josh
  });

  // subgraph() passes traversers through, so it composes mid-stream and
  // accumulates across multiple keys.
  test('chained accumulation across multiple keys', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          V(),
          outE('KNOWS'),
          subgraph('knowsG'),
          inV(),
          outE('CREATED'),
          subgraph('createdG'),
          inV(),
          cap('createdG'),
        ),
        g,
      ),
    );
    const created = r[0] as Graph;
    // marko knows {vadas, josh}; of those, josh created {lop, ripple} → 2 edges,
    // 3 vertices (josh, lop, ripple). vadas created nothing.
    expect(created.edgeCount).toBe(2);
    expect(created.vertexCount).toBe(3);
  });
});
