import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { peerPressure } from './peer-pressure.js';

// Two directed cliques {1,2,3} and {4,5,6} (all six intra-triangle edges each). Peer
// pressure converges each to its smallest-id cluster. Mirrors the Rust `two_cliques`.
const twoCliques = (): Graph => {
  const g = new Graph();

  for (const id of ['1', '2', '3', '4', '5', '6']) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [a, b] of [
    ['1', '2'],
    ['1', '3'],
    ['2', '3'],
    ['4', '5'],
    ['4', '6'],
    ['5', '6'],
  ] as const) {
    g.addEdge({ from: g.getVertexById(a)!, to: g.getVertexById(b)!, labels: ['E'] });
    g.addEdge({ from: g.getVertexById(b)!, to: g.getVertexById(a)!, labels: ['E'] });
  }

  return g;
};

const map = (rows: { node: string; cluster: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.node, r.cluster]));

describe('peer pressure', () => {
  test('cliques converge to their smallest-id cluster', async () => {
    expect(map(await peerPressure({}, twoCliques()))).toEqual({
      1: '1',
      2: '1',
      3: '1',
      4: '4',
      5: '4',
      6: '4',
    });
  });

  test('unknown edge type → every vertex is its own cluster', async () => {
    expect(map(await peerPressure({ edgeLabel: 'NOPE' }, twoCliques()))).toEqual({
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
    });
  });

  test('writeProperty writes each cluster back to the vertex', async () => {
    const g = twoCliques();
    await peerPressure({ writeProperty: 'cl' }, g);
    expect(g.getVertexById('3')?.getProperty<string>('cl')).toBe('1');
    expect(g.getVertexById('5')?.getProperty<string>('cl')).toBe('4');
  });

  test('dual-form: curried application equals direct', async () => {
    expect(await peerPressure({})(twoCliques())).toEqual(await peerPressure({}, twoCliques()));
  });
});
