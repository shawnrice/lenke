import type { Graph } from '../core/Graph.js';
import type { PGFormat } from './types.js';

export const graph2PGJSON = (graph: Graph): PGFormat => {
  const nodes: PGFormat['nodes'] = [];
  const edges: PGFormat['edges'] = [];

  for (const vertex of graph.vertices) {
    nodes.push({
      id: vertex.id,
      labels: [...vertex.labels],
      properties: vertex.properties as PGFormat['nodes'][number]['properties'],
    });
  }

  for (const edge of graph.edges) {
    edges.push({
      id: edge.id,
      from: edge.from.id,
      to: edge.to.id,
      undirected: false,
      labels: [...edge.labels],
      properties: edge.properties as PGFormat['edges'][number]['properties'],
    });
  }

  return { nodes, edges };
};

export const serialize = (graph: Graph, space?: string | number): string =>
  JSON.stringify(graph2PGJSON(graph), null, space);
