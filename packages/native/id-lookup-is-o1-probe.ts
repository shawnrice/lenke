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
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { E, V, count, hasId, toArray, traversal, values } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

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
  'grm-hasId-one': (i) => toArray(traversal(V(), hasId(vid(i)), values('n')) as Plan, g),
  'grm-hasId-many-count': (i) =>
    toArray(traversal(V(), hasId(vid(i), vid(i + 1), vid(i + 2)), count()) as Plan, g),
  'grm-E-hasId-count': (i) => toArray(traversal(E(), hasId(eid(i)), count()) as Plan, g),
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
