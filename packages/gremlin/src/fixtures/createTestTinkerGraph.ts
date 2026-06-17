import { Graph } from '@pl-graph/core';

/**
 * The canonical Apache TinkerPop "Modern" graph used throughout the Gremlin
 * reference documentation. Six vertices, six edges, mixed labels.
 *
 * Vertices (insertion order — persons first, then software):
 *   1 marko  (PERSON, age 29)
 *   2 vadas  (PERSON, age 27)
 *   4 josh   (PERSON, age 32)
 *   6 peter  (PERSON, age 35)
 *   3 lop    (SOFTWARE, java)
 *   5 ripple (SOFTWARE, java)
 *
 * Edges:
 *    7  marko —knows  → vadas   (weight 0.5)
 *    8  marko —knows  → josh    (weight 1.0)
 *    9  marko —created→ lop     (weight 0.4)
 *   10  josh  —created→ ripple  (weight 1.0)
 *   11  josh  —created→ lop     (weight 0.4)
 *   12  peter —created→ lop     (weight 0.2)
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#graph-computing
 * @see https://tinkerpop.apache.org/docs/current/images/tinkerpop-modern.png
 */
export const createTestTinkerGraph = (): Graph => {
  const g = new Graph();
  g.disableEvents();

  const marko = g.addVertex({
    id: '1',
    labels: ['PERSON'],
    properties: { name: 'marko', age: 29 },
  });
  const vadas = g.addVertex({
    id: '2',
    labels: ['PERSON'],
    properties: { name: 'vadas', age: 27 },
  });
  const josh = g.addVertex({ id: '4', labels: ['PERSON'], properties: { name: 'josh', age: 32 } });
  const peter = g.addVertex({
    id: '6',
    labels: ['PERSON'],
    properties: { name: 'peter', age: 35 },
  });
  const lop = g.addVertex({
    id: '3',
    labels: ['SOFTWARE'],
    properties: { name: 'lop', lang: 'java' },
  });
  const ripple = g.addVertex({
    id: '5',
    labels: ['SOFTWARE'],
    properties: { name: 'ripple', lang: 'java' },
  });

  g.addEdge({ id: '7', from: marko, to: vadas, labels: ['KNOWS'], properties: { weight: 0.5 } });
  g.addEdge({ id: '8', from: marko, to: josh, labels: ['KNOWS'], properties: { weight: 1.0 } });
  g.addEdge({ id: '9', from: marko, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });
  g.addEdge({ id: '10', from: josh, to: ripple, labels: ['CREATED'], properties: { weight: 1.0 } });
  g.addEdge({ id: '11', from: josh, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });
  g.addEdge({ id: '12', from: peter, to: lop, labels: ['CREATED'], properties: { weight: 0.2 } });

  // Suppress unused warnings — the vertex references are used implicitly through addEdge.
  void peter;

  g.enableEvents();

  return g;
};
