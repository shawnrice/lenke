/**
 * Is the vertex/edge id collision an NDJSON-INGEST problem or a STORAGE one? (item 1588)
 *
 * The oracle probe found, over `{node x}, {node y}, {edge x: x->y}` ingested from NDJSON:
 *
 *     MATCH (n:P) WHERE n.k = 1 RETURN count(DISTINCT n)      ts 0   nat 1
 *
 * TS says ZERO for a vertex that exists. That is a wrong answer, not the rendering oddity item 1584
 * noted and set aside. This separates the two possible causes by building the SAME graph through the
 * direct API instead, and by asking questions that do not involve a dedup at all — if `vertexCount`
 * and a plain `count(*)` are already wrong, nothing downstream is to blame.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
const a = g.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
const b = g.addVertex({ id: 'y', labels: ['P'], properties: { k: 2 } });

console.log('--- before the colliding edge ---');
console.log('vertexCount', g.vertexCount, ' edgeCount', g.edgeCount);
console.log('count(*) on :P      ', JSON.stringify(query(g, 'MATCH (n:P) RETURN count(*) AS c')));
console.log(
  'count(*) k=1        ',
  JSON.stringify(query(g, 'MATCH (n:P) WHERE n.k = 1 RETURN count(*) AS c')),
);

g.addEdge({ id: 'x', from: a, to: b, labels: ['E'] });

console.log('\n--- after adding an EDGE whose id is the vertex id "x" ---');
console.log('vertexCount', g.vertexCount, ' edgeCount', g.edgeCount);
console.log('count(*) on :P      ', JSON.stringify(query(g, 'MATCH (n:P) RETURN count(*) AS c')));
console.log(
  'count(*) k=1        ',
  JSON.stringify(query(g, 'MATCH (n:P) WHERE n.k = 1 RETURN count(*) AS c')),
);
console.log(
  'count(DISTINCT n)   ',
  JSON.stringify(query(g, 'MATCH (n:P) WHERE n.k = 1 RETURN count(DISTINCT n) AS c')),
);
console.log('\n--- what the id maps hold ---');
console.log('verticesById.get("x") labels', JSON.stringify(g.verticesById.get('x')?.labels));
console.log('edgesById.get("x")    labels', JSON.stringify(g.edgesById.get('x')?.labels));
console.log('a (the original vertex) labels', JSON.stringify(a.labels), ' k =', a.properties.k);
// O(1) access by id is a stated project invariant, so it is checked explicitly.
console.log('verticesById.get("x") === a  ', g.verticesById.get('x') === a);
console.log('\n--- the label index, which the elisions trust ---');
console.log('verticesByLabel P size', g.verticesByLabel?.get('P')?.size ?? 'n/a');
console.log(
  'verticesByLabel P ids ',
  JSON.stringify([...(g.verticesByLabel?.get('P') ?? [])].map((v) => v.id)),
);
