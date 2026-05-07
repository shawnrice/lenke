import fs from 'node:fs';
import path from 'node:path';

import { Graph } from '../core/Graph.js';

const idFrom = (type: string, id: string) => [type, id].join(':');

const movies = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'movies.json'), 'utf-8'));

export const vertexId = (id: string): string => idFrom('vertex', id);

export const edgeId = (id: string): string => idFrom('edge', id);

export const createTestGraph = (): Graph => {
  const graph = new Graph();
  graph.disableEvents();

  for (const x of movies) {
    if (x.type === 'node') {
      graph.addVertex({
        id: vertexId(x.id),
        labels: x.labels,
        properties: x.properties,
      });
      continue;
    }

    if (x.type === 'relationship') {
      graph.addEdge({
        id: edgeId(x.id),
        from: graph.getVertexById(vertexId(x.start.id))!,
        to: graph.getVertexById(vertexId(x.end.id))!,
        properties: x.properties,
        labels: [x.label as string],
      });
    }
  }

  graph.enableEvents();

  return graph;
};
