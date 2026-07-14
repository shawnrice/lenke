import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { connectedComponents } from './connected-components.js';

// Two disjoint components {1,2,3} and {4,5} plus an isolated vertex 6. Nodes added
// in id order, so roots are the min-index member: {1,2,3}→"1", {4,5}→"4", {6}→"6".
// Edge 5→4 also proves union is undirected. Mirrors the Rust `two_components` test.
const twoComponents = (): Graph => {
  const g = new Graph();

  for (const id of ['1', '2', '3', '4', '5', '6']) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [from, to] of [
    ['1', '2'],
    ['2', '3'],
    ['5', '4'],
  ] as const) {
    g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: ['E'] });
  }

  return g;
};

const map = (rows: { node: string; componentId: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.node, r.componentId]));

describe('weakly-connected components', () => {
  test('roots are the min-index member of each component', async () => {
    expect(map(await connectedComponents({}, twoComponents()))).toEqual({
      1: '1',
      2: '1',
      3: '1',
      4: '4',
      5: '4',
      6: '6',
    });
  });

  test('rows are in insertion order', async () => {
    expect((await connectedComponents({}, twoComponents())).map((r) => r.node)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  });

  test('unknown edge type → every vertex is its own component', async () => {
    expect(map(await connectedComponents({ edgeLabel: 'NOPE' }, twoComponents()))).toEqual({
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
    });
  });

  test('writeProperty writes each componentId back to the vertex', async () => {
    const g = twoComponents();
    await connectedComponents({ writeProperty: 'comp' }, g);
    expect(g.getVertexById('3')?.getProperty<string>('comp')).toBe('1');
    expect(g.getVertexById('5')?.getProperty<string>('comp')).toBe('4');
  });

  test('dual-form: curried application equals direct', async () => {
    const g = twoComponents();
    expect(await connectedComponents({})(g)).toEqual(
      await connectedComponents({}, twoComponents()),
    );
  });
});
