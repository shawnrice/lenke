import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { labelPropagation } from './label-propagation.js';

// Two disjoint triangles {1,2,3} and {4,5,6}. Each triangle is a clique, so
// synchronous LPA converges it to its smallest-id label and stays there —
// {1,2,3}→"1", {4,5,6}→"4". Mirrors the Rust `two_triangles` test.
const twoTriangles = (): Graph => {
  const g = new Graph();

  for (const id of ['1', '2', '3', '4', '5', '6']) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [from, to] of [
    ['1', '2'],
    ['2', '3'],
    ['1', '3'],
    ['4', '5'],
    ['5', '6'],
    ['4', '6'],
  ] as const) {
    g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: ['E'] });
  }

  return g;
};

const map = (rows: { node: string; label: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.node, r.label]));

describe('label propagation', () => {
  test('triangles converge to their smallest-id label', async () => {
    expect(map(await labelPropagation({}, twoTriangles()))).toEqual({
      1: '1',
      2: '1',
      3: '1',
      4: '4',
      5: '4',
      6: '4',
    });
  });

  test('zero iterations → every vertex keeps its own external id', async () => {
    expect(map(await labelPropagation({ iterations: 0 }, twoTriangles()))).toEqual({
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
    });
  });

  test('unknown edge type → no propagation, labels stay = own id', async () => {
    expect(map(await labelPropagation({ edgeLabel: 'NOPE' }, twoTriangles()))).toEqual({
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
    });
  });

  test('writeProperty writes each label back to the vertex', async () => {
    const g = twoTriangles();
    await labelPropagation({ writeProperty: 'lbl' }, g);
    expect(g.getVertexById('3')?.getProperty<string>('lbl')).toBe('1');
    expect(g.getVertexById('6')?.getProperty<string>('lbl')).toBe('4');
  });

  test('dual-form: curried application equals direct', async () => {
    const g = twoTriangles();
    expect(await labelPropagation({})(g)).toEqual(await labelPropagation({}, twoTriangles()));
  });

  test('seedProperty anchors pin communities (mirrors native)', async () => {
    // Triangle {1,2,3}: unsupervised collapses to min "1"; anchoring 3 breaks the
    // collapse into three distinct communities (byte-identical to native).
    const build = (): Graph => {
      const g = new Graph();
      g.addVertex({ id: '1', labels: ['N'] });
      g.addVertex({ id: '2', labels: ['N'] });
      g.addVertex({ id: '3', labels: ['N'], properties: { anchor: true } });
      const v = (id: string) => g.getVertexById(id)!;
      g.addEdge({ from: v('1'), to: v('2'), labels: ['E'] });
      g.addEdge({ from: v('2'), to: v('3'), labels: ['E'] });
      g.addEdge({ from: v('1'), to: v('3'), labels: ['E'] });

      return g;
    };
    const map = (r: { node: string; label: string }[]): Record<string, string> =>
      Object.fromEntries(r.map((x) => [x.node, x.label]));

    expect(map(await labelPropagation({}, build()))).toEqual({ 1: '1', 2: '1', 3: '1' });
    expect(map(await labelPropagation({ seedProperty: 'anchor' }, build()))).toEqual({
      1: '1',
      2: '2',
      3: '3', // the seed keeps its own id
    });
    // A seed key no vertex carries → unsupervised.
    expect(map(await labelPropagation({ seedProperty: 'nope' }, build()))).toEqual({
      1: '1',
      2: '1',
      3: '1',
    });
  });
});
