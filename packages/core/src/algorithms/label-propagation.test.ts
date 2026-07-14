import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { labelPropagation, labelPropagationAsync } from './label-propagation.js';

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
  test('triangles converge to their smallest-id label', () => {
    expect(map(labelPropagation({}, twoTriangles()))).toEqual({
      1: '1',
      2: '1',
      3: '1',
      4: '4',
      5: '4',
      6: '4',
    });
  });

  test('zero iterations → every vertex keeps its own external id', () => {
    expect(map(labelPropagation({ iterations: 0 }, twoTriangles()))).toEqual({
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
    });
  });

  test('unknown edge type → no propagation, labels stay = own id', () => {
    expect(map(labelPropagation({ edgeLabel: 'NOPE' }, twoTriangles()))).toEqual({
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
    });
  });

  test('writeProperty writes each label back to the vertex', () => {
    const g = twoTriangles();
    labelPropagation({ writeProperty: 'lbl' }, g);
    expect(g.getVertexById('3')?.getProperty<string>('lbl')).toBe('1');
    expect(g.getVertexById('6')?.getProperty<string>('lbl')).toBe('4');
  });

  test('dual-form: curried application equals direct', () => {
    const g = twoTriangles();
    expect(labelPropagation({})(g)).toEqual(labelPropagation({}, twoTriangles()));
  });

  test('labelPropagationAsync resolves to the exact sync result', async () => {
    const sync = labelPropagation({ writeProperty: 'lbl' }, twoTriangles());
    const async = await labelPropagationAsync({ writeProperty: 'lbl' }, twoTriangles());
    expect(JSON.stringify(async)).toBe(JSON.stringify(sync));
  });

  test('labelPropagationAsync yields to the event loop between rounds', async () => {
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    await labelPropagationAsync({}, twoTriangles());
    expect(ticked).toBe(true);
  });
});
