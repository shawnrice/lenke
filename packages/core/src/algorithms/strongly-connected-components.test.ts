import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { stronglyConnectedComponents } from './strongly-connected-components.js';

const build = (nodes: string[], edges: [string, string][]): Graph => {
  const g = new Graph();

  for (const id of nodes) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [from, to] of edges) {
    g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: ['E'] });
  }

  return g;
};

const map = (rows: { node: string; componentId: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.node, r.componentId]));

describe('stronglyConnectedComponents', () => {
  test('a directed cycle is one component; tails are singletons', async () => {
    // 1→2→3→1 cycle; 4→3 and 5→4 cannot get back, so they are singletons.
    const g = build(
      ['1', '2', '3', '4', '5'],
      [
        ['1', '2'],
        ['2', '3'],
        ['3', '1'],
        ['4', '3'],
        ['5', '4'],
      ],
    );

    expect(map(await stronglyConnectedComponents({}, g))).toEqual({
      1: '1',
      2: '1',
      3: '1',
      4: '4',
      5: '5',
    });
  });

  test('direction matters: a DAG has every vertex as its own SCC', async () => {
    // 1→2→3 with a cross edge 1→3 — connected but acyclic → all singletons.
    const g = build(
      ['1', '2', '3'],
      [
        ['1', '2'],
        ['2', '3'],
        ['1', '3'],
      ],
    );

    expect(map(await stronglyConnectedComponents({}, g))).toEqual({ 1: '1', 2: '2', 3: '3' });
  });

  test('two separate cycles keep their own min-index ids', async () => {
    // {1,2} 2-cycle and {3,4,5} 3-cycle, linked one-way 2→3.
    const g = build(
      ['1', '2', '3', '4', '5'],
      [
        ['1', '2'],
        ['2', '1'],
        ['3', '4'],
        ['4', '5'],
        ['5', '3'],
        ['2', '3'],
      ],
    );

    expect(map(await stronglyConnectedComponents({}, g))).toEqual({
      1: '1',
      2: '1',
      3: '3',
      4: '3',
      5: '3',
    });
  });

  test('a self-loop and parallel edges do not change the partition', async () => {
    const g = build(
      ['a', 'b', 'c'],
      [
        ['a', 'a'],
        ['a', 'b'],
        ['b', 'a'],
        ['b', 'a'],
        ['b', 'c'],
      ],
    );

    expect(map(await stronglyConnectedComponents({}, g))).toEqual({ a: 'a', b: 'a', c: 'c' });
  });

  test('a named-but-unknown edge type → every vertex its own component', async () => {
    const g = build(
      ['1', '2', '3'],
      [
        ['1', '2'],
        ['2', '3'],
        ['3', '1'],
      ],
    );

    expect(map(await stronglyConnectedComponents({ edgeLabel: 'NOPE' }, g))).toEqual({
      1: '1',
      2: '2',
      3: '3',
    });
  });

  test('writeProperty writes each component id back to the vertex', async () => {
    const g = build(
      ['1', '2'],
      [
        ['1', '2'],
        ['2', '1'],
      ],
    );

    await stronglyConnectedComponents({ writeProperty: 'scc' }, g);
    expect(g.getVertexById('2')?.getProperty<string>('scc')).toBe('1');
  });

  test('dual-form: curried application equals direct', async () => {
    const nodes = ['1', '2', '3'];
    const edges: [string, string][] = [
      ['1', '2'],
      ['2', '1'],
    ];

    expect(await stronglyConnectedComponents({})(build(nodes, edges))).toEqual(
      await stronglyConnectedComponents({}, build(nodes, edges)),
    );
  });
});
