import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { createTestTinkerGraph } from '@lenke/gremlin';

import { highlightFromQuery, schemaOf, toModel } from './model.ts';
import { SAMPLES } from './samples.ts';

describe('toModel', () => {
  test('flattens a graph to plain nodes and edges', () => {
    const model = toModel(createTestTinkerGraph());

    expect(model.nodes).toHaveLength(6);
    expect(model.edges).toHaveLength(6);

    const marko = model.nodes.find((n) => n.properties.name === 'marko')!;

    expect(marko.labels).toContain('PERSON');
    expect(model.edges.every((e) => e.from && e.to)).toBe(true);
  });
});

describe('highlightFromQuery', () => {
  const socialGraph = (): Graph => {
    const g = new Graph();
    const marko = g.addVertex({
      id: '1',
      labels: ['Person'],
      properties: { name: 'marko', age: 29 },
    });
    const josh = g.addVertex({
      id: '2',
      labels: ['Person'],
      properties: { name: 'josh', age: 35 },
    });

    g.addEdge({ id: '9', from: marko, to: josh, labels: ['KNOWS'], properties: {} });

    return g;
  };

  test('a returned node lights up its vertex', () => {
    expect(highlightFromQuery(socialGraph(), 'MATCH (p:Person) WHERE p.age > 30 RETURN p')).toEqual(
      new Set(['2']),
    );
  });

  test('element_id() also resolves to the vertex', () => {
    expect(
      highlightFromQuery(socialGraph(), 'MATCH (p:Person) RETURN element_id(p) AS id'),
    ).toEqual(new Set(['1', '2']));
  });

  test('a property-only projection highlights nothing (no node to point at)', () => {
    expect(highlightFromQuery(socialGraph(), 'MATCH (p:Person) RETURN p.name').size).toBe(0);
  });

  test('returning multiple variables lights up all of them (RETURN a, b)', () => {
    expect(highlightFromQuery(socialGraph(), 'MATCH (a:Person)-[:KNOWS]->(b) RETURN a, b')).toEqual(
      new Set(['1', '2']),
    );
    // RETURN * binds every variable, so it lights the whole match too.
    expect(highlightFromQuery(socialGraph(), 'MATCH (a:Person)-[:KNOWS]->(b) RETURN *')).toEqual(
      new Set(['1', '2']),
    );
  });
});

describe('schemaOf', () => {
  test('counts every vertex label and edge type', () => {
    const schema = schemaOf(createTestTinkerGraph());

    expect(schema.vertexLabels).toEqual([
      { label: 'PERSON', count: 4 },
      { label: 'SOFTWARE', count: 2 },
    ]);
    expect(schema.edgeLabels.map((e) => e.label).sort()).toEqual(['CREATED', 'KNOWS']);
    expect(schema.vertexKeys).toContain('name');
  });
});

describe('SAMPLES', () => {
  test('every built-in sample builds a non-empty graph', () => {
    for (const s of SAMPLES) {
      const model = toModel(s.build());

      expect(model.nodes.length).toBeGreaterThan(0);
      expect(model.edges.length).toBeGreaterThan(0);
    }
  });

  test('the Movies sample has three vertex labels and three edge types', () => {
    const movies = SAMPLES.find((s) => s.name === 'Movies')!;
    const schema = schemaOf(movies.build());

    expect(schema.vertexLabels.map((l) => l.label)).toEqual(['Genre', 'Movie', 'Person']);
    expect(schema.edgeLabels.map((l) => l.label)).toEqual(['ACTED_IN', 'DIRECTED', 'IN_GENRE']);
  });
});
