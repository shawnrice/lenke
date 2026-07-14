import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { degree } from './degree.js';

// The TinkerPop "modern" graph. KNOWS: marko→vadas, marko→josh. CREATED:
// marko→lop, josh→ripple, josh→lop, peter→lop. Nodes added in id order so
// result rows come out 1,2,3,4,5,6 (insertion order). This mirrors the Rust
// `algo::degree` known-answer test one-for-one.
const modern = (): Graph => {
  const g = new Graph();

  for (const [id, label, name] of [
    ['1', 'Person', 'marko'],
    ['2', 'Person', 'vadas'],
    ['3', 'Software', 'lop'],
    ['4', 'Person', 'josh'],
    ['5', 'Software', 'ripple'],
    ['6', 'Person', 'peter'],
  ] as const) {
    g.addVertex({ id, labels: [label], properties: { name } });
  }

  for (const [from, to, type] of [
    ['1', '2', 'KNOWS'],
    ['1', '4', 'KNOWS'],
    ['1', '3', 'CREATED'],
    ['4', '5', 'CREATED'],
    ['4', '3', 'CREATED'],
    ['6', '3', 'CREATED'],
  ] as const) {
    g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: [type] });
  }

  return g;
};

const map = (rows: { node: string; degree: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.node, r.degree]));

describe('degree centrality', () => {
  test('out-degree (default) over all edge types', () => {
    expect(map(degree({}, modern()))).toEqual({ 1: 3, 2: 0, 3: 0, 4: 2, 5: 0, 6: 1 });
  });

  test('in-degree over all edge types', () => {
    expect(map(degree({ direction: 'in' }, modern()))).toEqual({
      1: 0,
      2: 1,
      3: 3,
      4: 1,
      5: 1,
      6: 0,
    });
  });

  test('both directions — self-loop-free graph sums out + in', () => {
    expect(map(degree({ direction: 'both' }, modern()))).toEqual({
      1: 3,
      2: 1,
      3: 3,
      4: 3,
      5: 1,
      6: 1,
    });
  });

  test('typed: out KNOWS only marko', () => {
    expect(map(degree({ direction: 'out', edgeLabel: 'KNOWS' }, modern()))).toEqual({
      1: 2,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
    });
  });

  test('unknown edge type → every vertex zero', () => {
    expect(Object.values(map(degree({ edgeLabel: 'NOPE' }, modern()))).every((d) => d === 0)).toBe(
      true,
    );
  });

  test('rows are in insertion order', () => {
    expect(degree({}, modern()).map((r) => r.node)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  test('writeProperty writes each degree back to the vertex', () => {
    const g = modern();
    degree({ direction: 'both', writeProperty: 'deg' }, g);
    expect(g.getVertexById('3')?.getProperty<number>('deg')).toBe(3);
    expect(g.getVertexById('1')?.getProperty<number>('deg')).toBe(3);
    expect(g.getVertexById('2')?.getProperty<number>('deg')).toBe(1);
  });

  test('dual-form: curried application equals direct', () => {
    const g = modern();
    const out = degree({ direction: 'in' });
    expect(out(g)).toEqual(degree({ direction: 'in' }, modern()));
  });
});
