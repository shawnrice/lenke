import { describe, expect, test } from 'bun:test';

import { type NativeSubgraph, subgraphToGraph } from './subgraph.js';

describe('subgraphToGraph — native subgraph record → @lenke/core Graph', () => {
  const native: NativeSubgraph = {
    vertices: [
      { id: '1', labels: ['PERSON'], properties: { name: 'marko', age: 29 } },
      { id: '2', labels: ['PERSON'], properties: { name: 'vadas', age: 27 } },
      { id: '4', labels: ['PERSON'], properties: { name: 'josh', age: 32 } },
    ],
    edges: [
      { id: '7', label: 'KNOWS', outV: '1', inV: '2', properties: { weight: 0.5 } },
      { id: '8', label: 'KNOWS', outV: '1', inV: '4', properties: { weight: 1 } },
    ],
  };

  test('rebuilds a faithful graph (counts, labels, properties, endpoints)', () => {
    const g = subgraphToGraph(native);
    expect(g.vertexCount).toBe(3);
    expect(g.edgeCount).toBe(2);

    const marko = g.getVertexById('1')!;
    expect(marko.properties.name).toBe('marko');
    expect(marko.labels.has('PERSON')).toBe(true);

    const e = g.getEdgeById('7')!;
    expect(e.from.id).toBe('1');
    expect(e.to.id).toBe('2');
    expect(e.labels.has('KNOWS')).toBe(true);
    expect(e.properties.weight).toBe(0.5);
  });

  test('is robust to missing optional fields', () => {
    const g = subgraphToGraph({
      vertices: [{ id: 'x', labels: [], properties: {} }],
      edges: [],
    });
    expect(g.vertexCount).toBe(1);
    expect(g.edgeCount).toBe(0);
  });
});
