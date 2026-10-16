// Item 445: what does DECLINING the hop fast path cost, and is any of it about edges?
//
// The question started as "projecting an edge costs 100x projecting a node", from the
// cross-engine bench: `project the edge` 607.1 ms lazy against `project the element` 5.7. That
// framing was wrong twice over, and both corrections are the reason this probe exists.
//
//   - WRONG FIXTURE. Those two bench rows use DIFFERENT documents — `nodesDoc` is 200,000 nodes
//     and `graphDoc` is 1,000,000 edges — so the per-row figures are 28.5 ns and 607 ns, about
//     21x rather than 100x. Matching the fixture to the claim is the standing rule and the 100x
//     was 5x of fixture.
//   - WRONG ATTRIBUTION, which is the real finding. `MATCH (:Person)-[r:KNOWS]->(b) RETURN b`
//     measured 104 ns/row and `RETURN r` 595 — but those are not the same ROUTE: item 444 admits
//     a named-but-unmentioned rel to `detectHopProjection`, and `RETURN r` mentions it, so that
//     6x was fast-path-versus-general-path wearing an edge costume. Comparing two projections
//     that BOTH decline settles it: `RETURN b, r.w` is 727 ns/row and `RETURN r, r.w` is 722.
//     Identical. Rendering an edge costs nothing measurable.
//
// So the real quantity is the ROUTE, and it is worth about 6.9x: ~105 ns/row on the fast path
// against ~720 off it, over an identical traversal with identical row counts. Every case below
// is one process (item 423), min of 9, and the fixture is the bench's own 5-edges-per-node shape.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.PN ?? 40_000);
const DEG = 5;
const REPS = Number(process.env.PR ?? 9);

const fresh = (): Graph => {
  const g = new Graph();
  const ids = Array.from({ length: N }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }),
  );

  for (let k = 0; k < N * DEG; k++) {
    g.addEdge({
      id: `e${k}`,
      from: ids[(k * 7919) % N],
      to: ids[(k * 104_729) % N],
      labels: ['KNOWS'],
      properties: { w: k % 7 },
    });
  }

  return g;
};

const queries: Record<string, string> = {
  // The pair that isolates the question: identical traversal, identical row count, and the only
  // difference is whether the projected element is the far NODE or the EDGE.
  node: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b',
  edge: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r',
  // One PROPERTY off each, to separate binding and traversal from rendering the whole element.
  nodeprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age',
  edgeprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r.w',
  // The bench's own spelling, with both endpoints anonymous.
  benchedge: 'MATCH (:Person)-[r:KNOWS]->() RETURN r',
  // CONTROL: the same row count with NO element projected at all, so whatever this costs is the
  // traversal that both sides pay and neither change can remove.
  control: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN 1 AS one',
  // The ANONYMOUS spelling of `node`, which cannot be anything but the fast path.
  anonnode: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b',
  // A node projection that DECLINES the fast path, because the item it projects mentions the
  // rel. This is the apples-to-apples partner for `edge`: same traversal, same rows, same
  // route, and the only difference is which element is rendered.
  gennode: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b, r.w AS w',
  // And its edge twin, so the pair differs only in the SECOND projected item.
  genedge: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r, r.w AS w',
  // A node-only projection forced off the fast path by a second segment, which declines for a
  // reason that has nothing to do with edges at all.
  twohopnode: 'MATCH (:Person)-[r:KNOWS]->(b) WHERE r.w < 100 RETURN b',
};
const key = process.env.PCASE ?? 'node';
const q = queries[key];

if (q === undefined) {
  throw new Error(`no such case: ${key}`);
}

const g = fresh();
const times: number[] = [];
let rows = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  // Materialized with a length read: these queries are LAZY in the TS engine, and timing a
  // generator that is never drained measures building the generator.
  const out = tsQuery(g, q);

  rows = Array.isArray(out) ? out.length : [...(out as Iterable<unknown>)].length;
  times.push(performance.now() - t0);
}

times.sort((p, n) => p - n);
console.log(
  `${key.padEnd(10)}min ${times[0].toFixed(1).padStart(8)}  p25 ${times[Math.floor(times.length / 4)].toFixed(1).padStart(8)}  med ${times[Math.floor(times.length / 2)].toFixed(1).padStart(8)}  rows ${rows}  ns/row ${((times[0] * 1e6) / Math.max(rows, 1)).toFixed(0)}`,
);
