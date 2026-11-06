// Can two DIFFERENT kinds of id-bearing value meet in ONE dedup set? (item 1584)
//
// `valueKey` keys anything with an `id` as `'@' + String(v.id)`, so today a vertex, an edge and a
// MAP with an `id` field all collapse together when they share an id. Item 1584 moves that whole
// branch into its own container keyed on `String(v.id)` — which preserves the equivalence exactly,
// because the `'@'` is constant within one container. But "preserved" is only a meaningful claim
// about behaviour that can be OBSERVED, so this asks whether such a mixture is reachable at all.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
const a = g.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
const b = g.addVertex({ id: 'y', labels: ['P'], properties: { k: 2 } });

// An EDGE sharing an id with a vertex, if the engine allows it.
try {
  g.addEdge({ id: 'x', from: a, to: b, labels: ['E'] });
  console.log('edge may share a vertex id: true');
} catch (e) {
  console.log('edge may share a vertex id: false —', e.message);
}

g.addEdge({ id: 'e2', from: b, to: a, labels: ['E'] });

for (const q of [
  // A dedup over edges, which is the `ids` branch with a different element kind.
  'MATCH ()-[e:E]->() RETURN DISTINCT e',
  'MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c',
  // A map literal carrying an `id` field — reachable without any element at all.
  "MATCH (n:P) RETURN DISTINCT {id: 'x'}",
  "MATCH (n:P) RETURN count(DISTINCT {id: 'x'}) AS c",
  // A map whose id is a NUMBER against one whose id is the STRING of it: `valueKey` collapses
  // these, and a raw key would not. This is the case the `String(v.id)` coercion is for.
  'MATCH (n:P) RETURN count(DISTINCT {id: 5}) AS c',
  // THE MIXTURE: can a node column and a map-with-id column share one dedup?
  "MATCH (n:P) RETURN DISTINCT n UNION MATCH (m:P) RETURN DISTINCT {id: 'x'}",
  // And a vertex against an edge in one column.
  'MATCH (n:P) RETURN DISTINCT n UNION MATCH ()-[e:E]->() RETURN DISTINCT e',
  // A list, which has no `id` and must still take the structural branch.
  'MATCH (n:P) RETURN count(DISTINCT [n.k, n.k]) AS c',
]) {
  try {
    console.log(`OK    ${JSON.stringify(query(g, q))}\n      ${q}\n`);
  } catch (e) {
    console.log(`THREW ${e.message}\n      ${q}\n`);
  }
}
