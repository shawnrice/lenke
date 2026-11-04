// IS ID LOOKUP ACTUALLY O(1)? An invariant probe for the standing constraint (item 1326).
//
//   bun id-lookup-is-o1-probe.ts <arm> <N>     # ONE arm and ONE size per process
//   bun id-lookup-is-o1-probe.ts               # lists the arms
//
// "Keep good O(1) access to get a vertex or edge by id" is a standing requirement, and items
// 1315-1319 optimized those paths — but every one of them was measured at a SINGLE size. A single
// size cannot distinguish O(1) from O(log N) or from a cliff, so the requirement was never
// actually verified as an invariant. This does that: the per-lookup cost must be FLAT in N.
//
// One arm and one size per process, because four separate readings in this run were inverted by
// measuring several things in one process (items 1320, 1321, 1323, 1325).
//
// ⚠️ HOW TO READ THIS PROBE'S NUMBERS (item 1395). The arms are correct and the invariant HOLDS, but
// the headline figure is NOT the engine's lookup cost and the residual drift is NOT complexity.
// Measured here: `core-getVertexById` reads 105.7 / 112.6 / 129.5 ns over a 16x range (+22.5%) and
// `core-getEdgeById` 99.9 / 111.9 / 130.5 (+30.6%) — and `log2(800000)/log2(50000)` is 1.26, so that
// drift is numerically indistinguishable from O(log N). `id-lookup-hotset-probe.mjs` separates the
// two by holding one variable fixed at a time, and both of its predictions came out on the cache
// side:
//
//   hot set FIXED at 1,000 ids, N varied 16x     5.15 / 4.78 / 4.90 ns   FLAT (non-monotonic)
//   N FIXED at 800,000, hot set varied 800x      5.15 -> 9.05 -> 18.64 -> 17.93 ns   RISES, plateaus
//
// So by-id access is genuinely O(1): ~5 ns with the entry cache-resident, ~18 ns once the working
// set exceeds cache. The cost tracks the WORKING SET, not the structure's size.
//
// The 20x gap to this probe's own 105 ns is this probe's FIXTURE: it calls
// `g.getVertexById(`v${i}`)`, constructing a fresh string per lookup. Measured at ~45-56 ns — ten
// times the lookup — and it drifts +14.5% across the sweep on its own, because ids grow from 5 to 7
// characters. That is a real cost for a caller that builds ids in a loop, and NOT a cost for the
// usual caller, which already holds the id (a query parameter, an edge endpoint). Quote ~5 ns hot
// and ~18 ns cold for the engine's access; quote this probe's figure only as "lookup plus building
// the key".
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { E, V, count, hasId, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.argv[3] ?? 50_000);
const REPS = Number(process.env.PROBE_REPS ?? 2_000);

const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }),
);

for (let i = 0; i + 1 < N; i++) {
  g.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'], properties: { w: i } });
}

// Ids are picked by index so the lookup target MOVES across the keyspace rather than hitting one
// warm entry: a fixed id would measure a single hash bucket and report O(1) for anything.
const vid = (i: number): string => `v${(i * 7919) % N}`;
const eid = (i: number): string => `e${(i * 7919) % (N - 1)}`;

const ARMS: Record<string, (i: number) => unknown> = {
  // The engine primitive, under everything else.
  'core-getVertexById': (i) => g.getVertexById(vid(i)),
  'core-getEdgeById': (i) => g.getEdgeById(eid(i)),

  // GQL: single id, and the id LIST items 1315/1316 added.
  'gql-node-eq': (i) =>
    query(g, 'MATCH (n:P) WHERE element_id(n) = $id RETURN n.n AS v', { id: vid(i) }),
  'gql-node-in': (i) =>
    query(g, 'MATCH (n:P) WHERE element_id(n) IN $ids RETURN n.n AS v', {
      ids: [vid(i), vid(i + 1), vid(i + 2)],
    }),
  'gql-edge-in': (i) =>
    query(g, 'MATCH (a)-[r:E]->(b) WHERE element_id(r) IN $ids RETURN a.n AS v', {
      ids: [eid(i), eid(i + 1)],
    }),

  // Gremlin: single id, and the multi-id form item 1317 admitted under an order-free tail.
  'grm-hasId-one': (i) => toArray(traversal(V(), hasId(vid(i)), values('n')), g),
  'grm-hasId-many-count': (i) =>
    toArray(traversal(V(), hasId(vid(i), vid(i + 1), vid(i + 2)), count()), g),
  'grm-E-hasId-count': (i) => toArray(traversal(E(), hasId(eid(i)), count()), g),
};

const arm = process.argv[2] ?? '';
const f = ARMS[arm];

if (f === undefined) {
  console.log(Object.keys(ARMS).join('\n'));
  process.exit(2);
}

// Warm, then time a BATCH of lookups so a single lookup's cost is above the clock's resolution.
for (let i = 0; i < 200; i++) {
  f(i);
}

const runs: number[] = [];

for (let r = 0; r < 7; r++) {
  const t = performance.now();

  for (let i = 0; i < REPS; i++) {
    f(i);
  }

  runs.push(((performance.now() - t) * 1e6) / REPS);
}

const sorted = [...runs].sort((a, b) => a - b);

console.log(`${arm}\t${N}\t${(sorted[sorted.length >> 1] ?? 0).toFixed(1)}`);
