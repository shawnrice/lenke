import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { describe as summarize, formatElement, formatGraph, formatRows } from './index.js';

const make = (): Graph => {
  const g = new Graph();
  const marko = g.addVertex({
    id: '1',
    labels: ['Person'],
    properties: { name: 'marko', age: 29 },
  });
  const vadas = g.addVertex({
    id: '2',
    labels: ['Person'],
    properties: { name: 'vadas', age: 27 },
  });
  const lop = g.addVertex({ id: '3', labels: ['Software'], properties: { name: 'lop' } });

  g.addEdge({ id: '7', from: marko, to: vadas, labels: ['KNOWS'], properties: { weight: 0.5 } });
  g.addEdge({ id: '9', from: marko, to: lop, labels: ['CREATED'], properties: {} });

  return g;
};

describe('describe / formatGraph', () => {
  test('summarizes counts, labels (most-populated first), and version', () => {
    const s = summarize(make());

    expect(s.vertices).toBe(3);
    expect(s.edges).toBe(2);
    expect(s.vertexLabels).toEqual([
      { label: 'Person', count: 2 },
      { label: 'Software', count: 1 },
    ]);
    expect(s.edgeLabels).toEqual([
      { label: 'CREATED', count: 1 },
      { label: 'KNOWS', count: 1 },
    ]);
    expect(s.vertexIndexes).toEqual([]);
  });

  test('renders a readable summary', () => {
    const out = formatGraph(make());

    expect(out).toContain('3 vertices, 2 edges');
    expect(out).toContain('Person');
    expect(out).toContain('vertices: (none)');
  });
});

describe('formatRows', () => {
  test('aligns columns and counts rows', () => {
    const out = formatRows([
      { name: 'marko', age: 29 },
      { name: 'vadas', age: 27 },
    ]);

    expect(out).toContain('name');
    expect(out).toContain('marko');
    expect(out.endsWith('(2 rows)')).toBe(true);
  });

  test('empty result', () => {
    expect(formatRows([])).toBe('(0 rows)');
  });

  test('a stored null is shown, not blanked', () => {
    expect(formatRows([{ x: null }])).toContain('null');
  });

  test('long cells are truncated with an ellipsis', () => {
    const out = formatRows([{ s: 'x'.repeat(100) }], { maxColWidth: 10 });

    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(100));
  });
});

describe('formatElement', () => {
  test('a vertex with its labels and quoted string props', () => {
    const [v] = [...make().vertices];

    expect(formatElement(v)).toBe('(#1 :Person { name: "marko", age: 29 })');
  });

  test('an edge shows its endpoints', () => {
    const e = [...make().edges].find((x) => [...x.labels].includes('KNOWS'))!;

    expect(formatElement(e)).toBe('[#7 :KNOWS { weight: 0.5 }] (#1 → #2)');
  });
});
