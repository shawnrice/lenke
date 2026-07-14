import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { shortestPath } from './shortest-path.js';

// 1→2 (w1), 2→3 (w2), 1→3 (w5); node 4 isolated (unreachable from 1). Mirrors the
// Rust `weighted_chain` test.
const weightedChain = (): Graph => {
  const g = new Graph();

  for (const id of ['1', '2', '3', '4']) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [from, to, w] of [
    ['1', '2', 1],
    ['2', '3', 2],
    ['1', '3', 5],
  ] as const) {
    g.addEdge({
      from: g.getVertexById(from)!,
      to: g.getVertexById(to)!,
      labels: ['E'],
      properties: { w },
    });
  }

  return g;
};

const map = (rows: { node: string; distance: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.node, r.distance]));

describe('shortest path', () => {
  test('unweighted BFS — direct 1→3 edge is one hop', async () => {
    expect(map(await shortestPath({ source: '1' }, weightedChain()))).toEqual({ 1: 0, 2: 1, 3: 1 });
  });

  test('weighted Dijkstra — 1→2→3 (3) beats direct 1→3 (5)', async () => {
    expect(map(await shortestPath({ source: '1', weightProperty: 'w' }, weightedChain()))).toEqual({
      1: 0,
      2: 1,
      3: 3,
    });
  });

  test('reachable set excludes upstream/disconnected vertices', async () => {
    // From 2: only 2 and 3; node 1 is upstream and node 4 disconnected.
    expect(map(await shortestPath({ source: '2', weightProperty: 'w' }, weightedChain()))).toEqual({
      2: 0,
      3: 2,
    });
  });

  test('unknown source → no rows', async () => {
    expect(await shortestPath({ source: '99' }, weightedChain())).toEqual([]);
    expect(await shortestPath({}, weightedChain())).toEqual([]);
  });

  test('unknown edge type → only the source at distance 0', async () => {
    expect(map(await shortestPath({ source: '1', edgeLabel: 'NOPE' }, weightedChain()))).toEqual({
      1: 0,
    });
  });

  test('writeProperty writes each distance back to the vertex', async () => {
    const g = weightedChain();
    await shortestPath({ source: '1', weightProperty: 'w', writeProperty: 'dist' }, g);
    expect(g.getVertexById('3')?.getProperty<number>('dist')).toBe(3);
    expect(g.getVertexById('1')?.getProperty<number>('dist')).toBe(0);
    // Unreachable node 4 gets no distance written.
    expect(g.getVertexById('4')?.getProperty('dist')).toBeUndefined();
  });

  test('dual-form: curried application equals direct', async () => {
    expect(await shortestPath({ source: '1' })(weightedChain())).toEqual(
      await shortestPath({ source: '1' }, weightedChain()),
    );
  });
});
