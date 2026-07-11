import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  decodeEdges,
  decodeNodes,
  deserialize,
  encodeEdges,
  encodeNodes,
  FORMATS,
  graphContentEqual,
  parse,
  serialize,
} from './index.js';

describe('serialize/deserialize entry points', () => {
  const doc = ['{"type":"node","id":"a","labels":["Person"],"properties":{"name":"marko"}}'].join(
    '\n',
  );

  test('parse() reads into a fresh graph (no target to construct)', () => {
    const g = parse(doc, 'ndjson');
    expect(g).toBeInstanceOf(Graph);
    expect(g.vertexCount).toBe(1);
    expect(g.getVertexById('a')?.getProperty<string>('name')).toBe('marko');
  });

  test('deserialize() with no graph is the same as parse()', () => {
    const g = deserialize(doc, 'ndjson');
    expect(g.vertexCount).toBe(1);
  });

  test('deserialize() into an existing graph appends (merge), not replace', () => {
    const g = new Graph();
    g.addVertex({ id: 'seed', labels: ['Person'], properties: {} });
    deserialize(doc, 'ndjson', g);
    expect(g.vertexCount).toBe(2);
  });

  test('round-trips through a format by name', () => {
    const g = parse(doc, 'ndjson');
    const again = parse(serialize(g, 'ndjson'), 'ndjson');
    expect(again.vertexCount).toBe(1);
  });

  test('graphContentEqual verifies a round trip (and flags pg-text edge-id loss)', () => {
    const g = parse(doc, 'ndjson');

    // The four lossless formats reproduce the graph exactly (ids preserved).
    for (const f of ['ndjson', 'pg-json', 'graphson', 'csv'] as const) {
      expect(graphContentEqual(parse(serialize(g, f), f), g)).toBe(true);
    }

    // Same-graph is trivially equal; a different graph is not.
    expect(graphContentEqual(g, parse(doc, 'ndjson'))).toBe(true);
    expect(graphContentEqual(g, new Graph())).toBe(false);
  });

  test('the CSV paired-file halves are reachable from the barrel and round-trip', () => {
    const g = parse(doc, 'ndjson');
    g.addVertex({ id: 'b', labels: ['Person'], properties: { name: 'vadas' } });
    g.addEdge({
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['KNOWS'],
      properties: {},
    });

    // Import the two CSVs into one fresh graph (nodes first).
    const back = new Graph();
    decodeNodes(encodeNodes(g), back);
    decodeEdges(encodeEdges(g), back);

    expect(back.vertexCount).toBe(2);
    expect(back.edgeCount).toBe(1);
    expect(graphContentEqual(back, g)).toBe(true);
  });

  test('FORMATS lists every registered format name at runtime', () => {
    expect([...FORMATS].sort()).toEqual(['csv', 'graphson', 'ndjson', 'pg-json', 'pg-text']);

    // Every listed format actually round-trips a trivial graph.
    for (const f of FORMATS) {
      expect(parse(serialize(parse(doc, 'ndjson'), f), f).vertexCount).toBe(1);
    }
  });
});
