import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  describe as summarize,
  formatElement,
  formatGraph,
  formatRows,
  type Inspectable,
} from './index.js';

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

// A stand-in for a native/wasm store: no `stats`, but it can `query` itself.
const nativeLike = (): Inspectable => {
  const answers: Record<string, Array<Record<string, unknown>>> = {
    'MATCH (n) RETURN labels(n) AS labels': [
      { labels: ['Person'] },
      { labels: ['Person'] },
      { labels: ['Software'] },
    ],
    'MATCH ()-[r]->() RETURN type(r) AS type': [{ type: 'KNOWS' }, { type: 'CREATED' }],
  };

  return {
    vertexCount: 3,
    edgeCount: 2,
    version: 7,
    query: (text: string) => answers[text] ?? [],
  };
};

describe('describe', () => {
  test('summarizes a pure-TS graph via its stats + indexes', () => {
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

  test('summarizes a native-style store via label/type queries; indexes are null', () => {
    const s = summarize(nativeLike());

    expect(s.vertices).toBe(3);
    expect(s.edges).toBe(2);
    expect(s.version).toBe(7);
    expect(s.vertexLabels).toEqual([
      { label: 'Person', count: 2 },
      { label: 'Software', count: 1 },
    ]);
    expect(s.edgeLabels).toEqual([
      { label: 'CREATED', count: 1 },
      { label: 'KNOWS', count: 1 },
    ]);
    expect(s.vertexIndexes).toBeNull();
  });

  test('unwraps a Store (`.graph`)', () => {
    const s = summarize({ graph: nativeLike() as never });

    expect(s.vertices).toBe(3);
    expect(s.vertexIndexes).toBeNull();
  });
});

describe('formatGraph', () => {
  test('renders a readable summary (TS graph)', () => {
    const out = formatGraph(make(), { color: false });

    expect(out).toContain('3 vertices, 2 edges');
    expect(out).toContain('Person');
    expect(out).toContain('vertices: (none)');
  });

  test('a native backend reports indexes as not introspectable', () => {
    expect(formatGraph(nativeLike(), { color: false })).toContain('not introspectable');
  });
});

describe('formatRows', () => {
  test('draws a bordered, aligned table and counts rows', () => {
    const out = formatRows(
      [
        { name: 'marko', age: 29 },
        { name: 'vadas', age: 27 },
      ],
      { color: false },
    );

    expect(out).toContain('┌');
    expect(out).toContain('│');
    expect(out).toContain('└');
    expect(out).toContain('marko');
    expect(out.endsWith('(2 rows)')).toBe(true);
  });

  test('empty result', () => {
    expect(formatRows([])).toBe('(0 rows)');
  });

  test('a stored null is shown, not blanked', () => {
    expect(formatRows([{ x: null }], { color: false })).toContain('null');
  });

  test('long cells are truncated with an ellipsis', () => {
    const out = formatRows([{ s: 'x'.repeat(100) }], { maxColWidth: 10, color: false });

    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(100));
  });

  test('color: true emits ANSI escapes', () => {
    expect(formatRows([{ a: 1 }], { color: true })).toContain('\x1b[');
  });
});

describe('formatElement', () => {
  test('a vertex with its labels and quoted string props', () => {
    const [v] = [...make().vertices];

    expect(formatElement(v, { color: false })).toBe('(#1 :Person { name: "marko", age: 29 })');
  });

  test('an edge shows its endpoints', () => {
    const e = [...make().edges].find((x) => [...x.labels].includes('KNOWS'))!;

    expect(formatElement(e, { color: false })).toBe('[#7 :KNOWS { weight: 0.5 }] (#1 → #2)');
  });

  test('color: true emits ANSI escapes', () => {
    const [v] = [...make().vertices];

    expect(formatElement(v, { color: true })).toContain('\x1b[');
  });
});
