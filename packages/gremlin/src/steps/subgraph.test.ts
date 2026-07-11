import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import {
  cap,
  E,
  has,
  hasLabel,
  inE,
  inV,
  outE,
  outV,
  pipe,
  repeat,
  subgraph,
  V,
} from '../steps.js';
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

  test('a subgraph INSIDE a repeat() body accumulates transitively (side-effects escape the loop)', () => {
    // b->a, c->b, d->c: a chain of dependents pointing at `a`. Walking incoming
    // edges transitively and collecting them must capture ALL 3, not 0 — the
    // repeat body shares the enclosing side-effect scope (regression: it used to
    // run in a fresh context, so `cap` came back empty).
    const g = new Graph();

    for (const id of ['a', 'b', 'c', 'd']) {
      g.addVertex({ id, labels: ['N'], properties: { name: id } });
    }

    for (const [from, to] of [
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c'],
    ]) {
      g.addEdge({
        from: g.getVertexById(from)!,
        to: g.getVertexById(to)!,
        labels: ['E'],
        properties: {},
      });
    }

    const r = arr(
      run(
        traversal(
          V(),
          has('name', 'a'),
          repeat(pipe(inE('E'), subgraph('blast'), outV())).emit(),
          cap('blast'),
        ),
        g,
      ),
    );
    const blast = r[0] as Graph;
    expect(blast.edgeCount).toBe(3);
    expect(blast.vertexCount).toBe(4);
  });
});
