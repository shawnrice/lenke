import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

const personGraph = (): Graph => {
  const graph = new Graph({ eagerSnapshot: false });
  graph.addVertex({ id: 'a', labels: ['Person'], properties: { name: 'marko', age: 29 } });
  graph.addVertex({ id: 'b', labels: ['Person'], properties: { name: 'vadas', age: 27 } });
  graph.addVertex({ id: 'c', labels: ['Person'], properties: { name: 'josh', age: 32 } });
  graph.addVertex({ id: 'd', labels: ['Person'], properties: { name: 'peter', age: 35 } });
  return graph;
};

const ids = (vs: Iterable<{ id: string }>): string[] => Array.from(vs, (v) => v.id).sort();

describe('PropertyIndex equality', () => {
  test('createIndex backfills existing vertices', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual(['a']);
    expect(ids(graph.getVerticesByProperty('age', 27))).toEqual(['b']);
  });

  test('unindexed keys return an empty set', () => {
    const graph = personGraph();
    // name was never indexed -> no seed, falls back to scan elsewhere
    expect(ids(graph.getVerticesByProperty('name', 'marko'))).toEqual([]);
  });

  test('insert after index keeps it current', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.addVertex({ id: 'e', labels: ['Person'], properties: { age: 29 } });
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual(['a', 'e']);
  });

  test('type-tagged values do not collide', () => {
    const graph = new Graph({ eagerSnapshot: false });
    graph.createVertexIndex('v');
    graph.addVertex({ id: 'num', labels: [], properties: { v: 1 } });
    graph.addVertex({ id: 'str', labels: [], properties: { v: '1' } });
    graph.addVertex({ id: 'bool', labels: [], properties: { v: true } });
    expect(ids(graph.getVerticesByProperty('v', 1))).toEqual(['num']);
    expect(ids(graph.getVerticesByProperty('v', '1'))).toEqual(['str']);
    expect(ids(graph.getVerticesByProperty('v', true))).toEqual(['bool']);
  });

  test('setProperty moves a vertex between buckets', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.getVertexById('a')!.setProperty('age', 27);
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual([]);
    expect(ids(graph.getVerticesByProperty('age', 27))).toEqual(['a', 'b']);
  });

  test('removeProperty de-indexes the value', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.getVertexById('a')!.removeProperty('age');
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual([]);
  });

  test('removeVertex de-indexes its properties', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.removeVertex('c');
    expect(ids(graph.getVerticesByProperty('age', 32))).toEqual([]);
  });

  test('setProperties maintains every changed key', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.createVertexIndex('name');
    graph.getVertexById('a')!.setProperties({ age: 40, name: 'marco' });
    expect(ids(graph.getVerticesByProperty('age', 40))).toEqual(['a']);
    expect(ids(graph.getVerticesByProperty('name', 'marco'))).toEqual(['a']);
    expect(ids(graph.getVerticesByProperty('name', 'marko'))).toEqual([]);
  });

  test('a prevented mutation does not touch the index', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.on('@graph/VertexPropertyChanged', (event) => event.preventDefault());
    graph.getVertexById('a')!.setProperty('age', 99);
    expect(ids(graph.getVerticesByProperty('age', 99))).toEqual([]);
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual(['a']);
  });
});

describe('PropertyIndex range', () => {
  test('open lower bound stays within the numeric type', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    expect(ids(graph.getVerticesByPropertyRange('age', { gt: 30 }))).toEqual(['c', 'd']);
    expect(ids(graph.getVerticesByPropertyRange('age', { gte: 32 }))).toEqual(['c', 'd']);
  });

  test('closed range is inclusive on both ends', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    expect(ids(graph.getVerticesByPropertyRange('age', { gte: 27, lte: 32 }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ids(graph.getVerticesByPropertyRange('age', { gt: 27, lt: 35 }))).toEqual(['a', 'c']);
  });

  test('a numeric bound never bleeds into string values', () => {
    const graph = new Graph({ eagerSnapshot: false });
    graph.createVertexIndex('v');
    graph.addVertex({ id: 'n', labels: [], properties: { v: 5 } });
    graph.addVertex({ id: 's', labels: [], properties: { v: 'zzz' } });
    expect(ids(graph.getVerticesByPropertyRange('v', { gt: 0 }))).toEqual(['n']);
  });

  test('range reflects mutations', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.getVertexById('b')!.setProperty('age', 50);
    expect(ids(graph.getVerticesByPropertyRange('age', { gt: 30 }))).toEqual(['b', 'c', 'd']);
  });
});

describe('PropertyIndex snapshots and edges', () => {
  test('clone does not alias the source buckets', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    const snapshot = graph.clone({ eagerSnapshot: false });

    // Mutating the original must not change the snapshot's view.
    graph.getVertexById('a')!.setProperty('age', 100);
    expect(ids(snapshot.getVerticesByProperty('age', 29))).toEqual(['a']);
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual([]);
  });

  test('edge property indexes work the same way', () => {
    const graph = new Graph({ eagerSnapshot: false });
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = graph.addVertex({ id: 'b', labels: ['P'], properties: {} });
    graph.createEdgeIndex('weight');
    graph.addEdge({ id: 'e1', from: a, to: b, labels: ['knows'], properties: { weight: 5 } });
    graph.addEdge({ id: 'e2', from: a, to: b, labels: ['knows'], properties: { weight: 9 } });
    expect(Array.from(graph.getEdgesByProperty('weight', 5), (e) => e.id)).toEqual(['e1']);
    expect(
      Array.from(graph.getEdgesByPropertyRange('weight', { gte: 5 }), (e) => e.id).sort(),
    ).toEqual(['e1', 'e2']);
  });

  test('vertexIndexes / edgeIndexes report declared keys', () => {
    const graph = personGraph();
    graph.createVertexIndex('name');
    graph.createVertexIndex('age');
    graph.createEdgeIndex('weight');
    expect(graph.vertexIndexes().sort()).toEqual(['age', 'name']);
    expect(graph.edgeIndexes()).toEqual(['weight']);
    graph.dropVertexIndex('age');
    expect(graph.vertexIndexes()).toEqual(['name']);
  });

  test('truncate empties buckets but keeps declarations', () => {
    const graph = personGraph();
    graph.createVertexIndex('age');
    graph.truncate();
    expect(graph.vertexPropertyIndex.isIndexed('age')).toBe(true);
    graph.addVertex({ id: 'z', labels: [], properties: { age: 29 } });
    expect(ids(graph.getVerticesByProperty('age', 29))).toEqual(['z']);
  });
});
