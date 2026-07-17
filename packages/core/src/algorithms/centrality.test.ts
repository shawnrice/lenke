import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/index.js';
import { betweenness, closeness } from './centrality.js';

/** Build a graph from `[from, to, label?, weight?]` edge tuples over auto-added vertices. */
const graphFrom = (ids: string[], edges: [string, string, string?, number?][]): Graph => {
  const g = new Graph();
  const v = new Map(ids.map((id) => [id, g.addVertex({ id, labels: ['N'] })]));

  for (const [from, to, label = 'E', w] of edges) {
    g.addEdge({
      from: v.get(from)!,
      to: v.get(to)!,
      labels: [label],
      properties: w === undefined ? {} : { w },
    });
  }

  return g;
};

describe('betweenness (Brandes)', () => {
  test('directed path 1→2→3→4: interior vertices score 2 each', async () => {
    const g = graphFrom(
      ['1', '2', '3', '4'],
      [
        ['1', '2'],
        ['2', '3'],
        ['3', '4'],
      ],
    );

    expect(await betweenness({}, g)).toEqual([
      { node: '1', centrality: 0 },
      { node: '2', centrality: 2 },
      { node: '3', centrality: 2 },
      { node: '4', centrality: 0 },
    ]);
  });

  test('diamond: two equal shortest paths split the (1,4) pair 0.5/0.5', async () => {
    const g = graphFrom(
      ['1', '2', '3', '4'],
      [
        ['1', '2'],
        ['1', '3'],
        ['2', '4'],
        ['3', '4'],
      ],
    );

    expect(await betweenness({}, g)).toEqual([
      { node: '1', centrality: 0 },
      { node: '2', centrality: 0.5 },
      { node: '3', centrality: 0.5 },
      { node: '4', centrality: 0 },
    ]);
  });

  test('writeProperty writes each score back to its vertex', async () => {
    const g = graphFrom(
      ['1', '2', '3'],
      [
        ['1', '2'],
        ['2', '3'],
      ],
    );
    await betweenness({ writeProperty: 'bt' }, g);

    expect(g.getVertexById('2')!.getProperty<number>('bt')).toBe(1);
    expect(g.getVertexById('1')!.getProperty<number>('bt')).toBe(0);
  });

  test('unknown edge label → every score 0', async () => {
    const g = graphFrom(
      ['1', '2', '3'],
      [
        ['1', '2'],
        ['2', '3'],
      ],
    );

    expect((await betweenness({ edgeLabel: 'NOPE' }, g)).every((r) => r.centrality === 0)).toBe(
      true,
    );
  });
});

describe('closeness', () => {
  test('directed path 1→2→3→4: 1/Σd, sink scores 0', async () => {
    const g = graphFrom(
      ['1', '2', '3', '4'],
      [
        ['1', '2'],
        ['2', '3'],
        ['3', '4'],
      ],
    );

    expect(await closeness({}, g)).toEqual([
      { node: '1', centrality: 1 / 6 },
      { node: '2', centrality: 1 / 3 },
      { node: '3', centrality: 1 },
      { node: '4', centrality: 0 },
    ]);
  });

  test('weighted: distances double when every edge weighs 2 → closeness halves', async () => {
    const g = graphFrom(
      ['1', '2', '3'],
      [
        ['1', '2', 'E', 2],
        ['2', '3', 'E', 2],
      ],
    );

    expect(await closeness({ weightProperty: 'w' }, g)).toEqual([
      { node: '1', centrality: 1 / 6 },
      { node: '2', centrality: 1 / 2 },
      { node: '3', centrality: 0 },
    ]);
  });
});
