import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { Graph } from './Graph.js';
import { Path } from './Path.js';

// a —KNOWS→ b —KNOWS→ c
const chain = () => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { name: 'A' } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { name: 'B' } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { name: 'C' } });
  const e1 = g.addEdge({ id: 'e1', from: a, to: b, labels: ['KNOWS'], properties: {} });
  const e2 = g.addEdge({ id: 'e2', from: b, to: c, labels: ['KNOWS'], properties: {} });

  return { a, b, c, e1, e2 };
};

describe('Path', () => {
  test('iterates vertex, edge, vertex, … interleaved', () => {
    const { a, b, c, e1, e2 } = chain();
    const p = new Path([a, b, c], [e1, e2]);

    expect([...p]).toEqual([a, e1, b, e2, c]);
  });

  test('length/size is the element count (List contract); hops is the edge count', () => {
    const { a, b, c, e1, e2 } = chain();
    const p = new Path([a, b, c], [e1, e2]);

    expect(p.length).toBe(5); // 2·hops + 1
    expect(p.size).toBe(5);
    expect(p.hops).toBe(2); // graph path length
  });

  test('start / end / vertices / edges', () => {
    const { a, b, c, e1, e2 } = chain();
    const p = new Path([a, b, c], [e1, e2]);

    expect(p.start).toBe(a);
    expect(p.end).toBe(c);
    expect(p.vertices).toEqual([a, b, c]);
    expect(p.edges).toEqual([e1, e2]);
  });

  test('a single-node path has zero hops and iterates just that node', () => {
    const { a } = chain();
    const p = new Path([a], []);

    expect([...p]).toEqual([a]);
    expect(p.length).toBe(1);
    expect(p.hops).toBe(0);
    expect(p.start).toBe(a);
    expect(p.end).toBe(a);
  });

  test('fromSteps builds from {edge, vertex} walk steps', () => {
    const { a, b, c, e1, e2 } = chain();
    const p = Path.fromSteps(a, [
      { edge: e1, vertex: b },
      { edge: e2, vertex: c },
    ]);

    expect([...p]).toEqual([a, e1, b, e2, c]);
  });

  test('inherited List combinators work over the interleaved stream', () => {
    const { a, b, c, e1, e2 } = chain();
    const p = new Path([a, b, c], [e1, e2]);

    // count() honors the fast-path length; take() slices the interleaving.
    expect(p.toArray()).toHaveLength(5);
    expect([...p.take(3)]).toEqual([a, e1, b]);
  });

  test('toJSON is the canonical {vertices, edges, length=hops} shape', () => {
    const { a, b, c, e1, e2 } = chain();
    const p = new Path([a, b, c], [e1, e2]);

    expect(p.toJSON()).toEqual({
      vertices: [a.toJSON(), b.toJSON(), c.toJSON()],
      edges: [e1.toJSON(), e2.toJSON()],
      length: 2,
    });
  });

  test('rejects a vertices/edges count mismatch', () => {
    const { a, b, e1, e2 } = chain();

    try {
      new Path([a, b], [e1, e2]);
      expect.unreachable();
    } catch (err) {
      expect(hasErrorCode(err, ErrorCode.InvalidValue)).toBe(true);
    }
  });
});
