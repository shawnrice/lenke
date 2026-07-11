import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { deserialize, parse, serialize } from './index.js';

describe('serialize/deserialize entry points', () => {
  const doc = ['{"type":"node","id":"a","labels":["Person"],"properties":{"name":"marko"}}'].join(
    '\n',
  );

  test('parse() reads into a fresh graph (no target to construct)', () => {
    const g = parse(doc, 'ndjson');
    expect(g).toBeInstanceOf(Graph);
    expect(g.vertexCount).toBe(1);
    expect(g.getVertexById('a')?.getProperty('name')).toBe('marko');
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
});
