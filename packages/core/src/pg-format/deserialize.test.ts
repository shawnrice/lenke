import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/index.js';
import { deserialize } from './deserialize.js';

const testGraph = `
{
  "nodes":[
    {
     "id":101,
     "labels":["Person"],
     "properties":{"name":["Alice"], "age":[15], "country":["United States"]}
    },
    {
     "id":102,
     "labels":["Person", "Student"],
     "properties":{"name":["Bob"], "country":["Japan", "Germany"]}
    }
  ],
  "edges":[
    {
     "from":101,
     "to":102,
     "undirected":false,
     "labels":["sameSchool", "sameClass"],
     "properties":{"since":[2012]}
    },
    {
     "from":102,
     "to":101,
     "labels":["likes"],
     "properties":{"since":[2015]}
    }
  ]
}`;

describe('graph/pg-format/deserialize', () => {
  test('should deserialize a pg-format string into a graph', () => {
    const graph = deserialize(testGraph, new Graph());
    expect(graph).toBeDefined();
    expect(graph.getVertexById(101)).toBeDefined();
    expect(graph.getVertexById(102)).toBeDefined();
    expect(graph.getEdgeById(101)).toBeDefined();
    expect(graph.getEdgeById(102)).toBeDefined();
    expect(graph.getVertexById(101)?.hasLabel('Person')).toBe(true);
    expect(graph.getVertexById(102)?.hasLabel('Person')).toBe(true);
    expect(graph.getVertexById(102)?.hasLabel('Student')).toBe(true);
    expect(graph.getEdgeById(`101-[sameSchool,sameClass]->102`)?.hasLabel('sameSchool')).toBe(true);
    expect(graph.getEdgeById(`101-[sameSchool,sameClass]->102`)?.hasLabel('sameClass')).toBe(true);
    expect(graph.getEdgeById(`102-[likes]->101`)?.hasLabel('likes')).toBe(true);
  });

  // graph.traverse() was a v1 API; v2 traversal lives in @pl-graph/gremlin and
  // operates against the Graph indexes directly via run(plan, graph). Restore
  // this test once the deserialize test fixture is rewritten for v2.
  test.skip('should traverse a deserialized graph', () => {
    const graph = deserialize(input, new Graph());
    expect(
      (graph as any)
        .traverse((g: any) => g.V().hasLabel('Person').outE('likes').inV().values('name'))
        .toArray(),
    ).toEqual([['Alice']]);
    expect(
      (graph as any).traverse((g: any) =>
        g.V().hasLabel('Student').inE('sameSchool').outV().values('country').toArray(),
      ),
    ).toEqual([['United States']]);
  });
});
