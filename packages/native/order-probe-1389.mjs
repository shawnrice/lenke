/**
 * Does the multi-label hop yield rows in the SAME SEQUENCE as before (item 1389)?
 *
 * `iterLabeled` walks the named buckets in LABEL-ARG order and `graph-queries.ts` documents that
 * deliberately, so a hand walk that replaces it must reproduce the sequence, not just the multiset.
 * The GQL twin sorts largest-bucket-first (item 1384) and this one must not.
 *
 * ⚠️ THE OBVIOUS FIXTURE CANNOT SEE IT. One out-edge per vertex makes vertex iteration order
 * dominate, so `out('E','F')` and `out('F','E')` print the identical sequence whatever the bucket
 * order is — my first check was vacuous for exactly that reason. Here each vertex has THREE
 * out-edges whose label sets differ, so bucket order is observable.
 */
import { Graph } from '@lenke/core';
import { hasLabel, out, toArray, traversal, V, values } from '@lenke/gremlin';

const N = 300;
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
}

for (let i = 0; i < N; i += 1) {
  const from = g.getVertexById(`v${i}`);
  // E only, F only, and BOTH — so the three buckets differ in size and membership overlaps.
  g.addEdge({ id: `a${i}`, from, to: g.getVertexById(`v${(i + 1) % N}`), labels: ['E'] });
  g.addEdge({ id: `b${i}`, from, to: g.getVertexById(`v${(i + 2) % N}`), labels: ['F'] });
  g.addEdge({ id: `c${i}`, from, to: g.getVertexById(`v${(i + 3) % N}`), labels: ['E', 'F'] });
}

const seq = (...ls) => toArray(traversal(V(), hasLabel('P'), out(...ls), values('k')), g).join(',');
const ef = seq('E', 'F');
const fe = seq('F', 'E');

console.log(
  JSON.stringify({
    efLen: ef.split(',').length,
    feLen: fe.split(',').length,
    ef,
    fe,
    efIsFe: ef === fe,
  }),
);
