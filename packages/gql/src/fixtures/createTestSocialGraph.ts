import { Graph } from '@pl-graph/core';

/**
 * The TinkerPop "Modern" graph, relabeled in GQL conventions:
 * PascalCase node labels (`Person`, `Software`) and SCREAMING_SNAKE
 * relationship types (`KNOWS`, `CREATED`). Mirrors the gremlin package's
 * fixture so cross-language behavior can be compared on the same data.
 *
 *   marko  (Person, age 29) -KNOWS->   vadas  (Person, age 27)
 *   marko                   -KNOWS->   josh   (Person, age 32)
 *   marko                   -CREATED-> lop    (Software, java)
 *   josh                    -CREATED-> ripple (Software, java)
 *   josh                    -CREATED-> lop
 *   peter  (Person, age 35) -CREATED-> lop
 */
export const createTestSocialGraph = (): Graph => {
  const g = new Graph();
  g.disableEvents();

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
  const josh = g.addVertex({ id: '4', labels: ['Person'], properties: { name: 'josh', age: 32 } });
  const peter = g.addVertex({
    id: '6',
    labels: ['Person'],
    properties: { name: 'peter', age: 35 },
  });
  const lop = g.addVertex({
    id: '3',
    labels: ['Software'],
    properties: { name: 'lop', lang: 'java' },
  });
  const ripple = g.addVertex({
    id: '5',
    labels: ['Software'],
    properties: { name: 'ripple', lang: 'java' },
  });

  g.addEdge({ id: '7', from: marko, to: vadas, labels: ['KNOWS'], properties: { weight: 0.5 } });
  g.addEdge({ id: '8', from: marko, to: josh, labels: ['KNOWS'], properties: { weight: 1.0 } });
  g.addEdge({ id: '9', from: marko, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });
  g.addEdge({ id: '10', from: josh, to: ripple, labels: ['CREATED'], properties: { weight: 1.0 } });
  g.addEdge({ id: '11', from: josh, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });
  g.addEdge({ id: '12', from: peter, to: lop, labels: ['CREATED'], properties: { weight: 0.2 } });

  void ripple;
  void peter;

  g.enableEvents();
  return g;
};
