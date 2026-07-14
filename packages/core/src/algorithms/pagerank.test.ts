import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { pagerank } from './pagerank.js';

const line = (edges: [string, string][], nodes = ['1', '2', '3']): Graph => {
  const g = new Graph();

  for (const id of nodes) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [from, to] of edges) {
    g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: ['E'] });
  }

  return g;
};

const map = (rows: { node: string; score: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.node, r.score]));

describe('pagerank', () => {
  test('symmetric 2-cycle → exactly [0.5, 0.5]', () => {
    const g = line(
      [
        ['1', '2'],
        ['2', '1'],
      ],
      ['1', '2'],
    );
    expect(map(pagerank({}, g))).toEqual({ 1: 0.5, 2: 0.5 });
  });

  test('mass is conserved (scores sum to 1) even with dangling sinks', () => {
    // 1→2→3, 3 is a dangling sink.
    const g = line([
      ['1', '2'],
      ['2', '3'],
    ]);
    const total = pagerank({}, g).reduce((s, r) => s + r.score, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  test('a sink outranks a source', () => {
    const g = line([
      ['1', '2'],
      ['2', '3'],
    ]);
    const s = map(pagerank({}, g));
    expect(s['3']).toBeGreaterThan(s['1']);
  });

  test('unknown edge type → uniform 1/N', () => {
    const g = line([['1', '2']]);
    const s = map(pagerank({ edgeLabel: 'NOPE' }, g));
    expect(s['1']).toBeCloseTo(1 / 3, 12);
    expect(s['2']).toBeCloseTo(1 / 3, 12);
    expect(s['3']).toBeCloseTo(1 / 3, 12);
  });

  test('writeProperty writes each score back to the vertex', () => {
    const g = line(
      [
        ['1', '2'],
        ['2', '1'],
      ],
      ['1', '2'],
    );
    pagerank({ writeProperty: 'pr' }, g);
    expect(g.getVertexById('1')?.getProperty<number>('pr')).toBe(0.5);
  });

  test('dual-form: curried application equals direct', () => {
    const edges: [string, string][] = [
      ['1', '2'],
      ['2', '3'],
    ];
    expect(pagerank({})(line(edges))).toEqual(pagerank({}, line(edges)));
  });
});
