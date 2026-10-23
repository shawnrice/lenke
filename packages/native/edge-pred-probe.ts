// Does the item-631 pattern repeat on the EDGE side?
//
// 631 fixed `matchNode`: it allocated a binding per candidate VERTEX before testing the
// predicate. `edgePasses` has the same shape for a relationship —
//
//     return satisfies(edge, rel.pred, withBinding(binding, rel.variable, edge), params, graph);
//
// — and it is called per EDGE, including from the var-length BFS, so the exposure is wider
// per query. "Same shape" is not "same cost" though (item 625 is the standing reminder), so
// this prices it before anything is changed.
//
//   cd packages/native && bun edge-pred-probe.ts
//   PROBE_N=20000 PROBE_DEG=10 bun edge-pred-probe.ts
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.PROBE_N ?? 20_000);
const DEG = Number(process.env.PROBE_DEG ?? 10);
const OPS = Number(process.env.PROBE_OPS ?? 30);
const REPS = Number(process.env.PROBE_REPS ?? 5);
const WARMUP = 2;

const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, k: i } }),
);

for (let i = 0; i < N; i++) {
  for (let d = 0; d < DEG; d++) {
    g.addEdge({
      id: `e${i}_${d}`,
      from: vs[i],
      to: vs[(i * 7 + d + 1) % N],
      labels: ['KNOWS'],
      // `w` is selective: only 1 in 1000 edges clears `w > 998`.
      properties: { w: (i * DEG + d) % 1000 },
    });
  }
}

const cases: [string, string, Record<string, unknown>][] = [
  // NOT A FLOOR, and the row is kept labelled as such: `count(*)` with no predicate takes the
  // count shortcut and never enumerates an edge at all, so its 0.02 ns/edge is the shortcut's
  // cost and not the per-edge cost of a hop. A floor for a per-edge filter has to enumerate.
  [
    'hop, no pred (SHORTCUT, not a floor)',
    'MATCH (a:User)-[r:KNOWS]->(b) RETURN count(*) AS c',
    {},
  ],
  // The real floor: a predicate every edge satisfies, so the walk enumerates and filters but
  // rejects nothing.
  [
    'hop, vacuous edge pred (floor)',
    'MATCH (a:User)-[r:KNOWS]->(b) WHERE r.w >= $v RETURN count(*) AS c',
    { v: 0 },
  ],
  // A SELECTIVE edge predicate: nearly every edge is rejected, which is where a per-edge
  // allocation before the test would hurt most.
  [
    'hop, selective edge pred',
    'MATCH (a:User)-[r:KNOWS]->(b) WHERE r.w > $v RETURN count(*) AS c',
    { v: 998 },
  ],
  [
    'hop, selective edge eq',
    'MATCH (a:User)-[r:KNOWS]->(b) WHERE r.w = $v RETURN count(*) AS c',
    { v: 999 },
  ],
  // An inline rel predicate, the other spelling of the same question.
  [
    'hop, inline edge pred',
    'MATCH (a:User)-[r:KNOWS {w: $v}]->(b) RETURN count(*) AS c',
    { v: 999 },
  ],
  // VAR-LENGTH, where `edgePasses` is called from the BFS and the edge count per query is
  // much larger.
  [
    'varlen {1,2}, edge pred',
    'MATCH (a:User {name: $n})-[r:KNOWS WHERE r.w > $v]->{1,2}(b) RETURN count(*) AS c',
    { n: 'user0', v: 500 },
  ],
];

const best = new Map<string, number>();

for (let round = 0; round < REPS + WARMUP; round++) {
  for (const [label, text, params] of cases) {
    const t = performance.now();

    for (let i = 0; i < OPS; i++) {
      void [...(query(g, text, params) as Iterable<unknown>)];
    }

    const us = ((performance.now() - t) * 1000) / OPS;

    if (round >= WARMUP) {
      best.set(label, Math.min(best.get(label) ?? Number.POSITIVE_INFINITY, us));
    }
  }
}

console.log(`\n=== TS edge predicate, ${N} users x ${DEG} edges, min of ${REPS} ===`);
console.log(`${'case'.padEnd(30)}${'us/op'.padStart(12)}${'ns/edge'.padStart(10)}`);

for (const [label] of cases) {
  const us = best.get(label) ?? Number.NaN;

  console.log(
    `${label.padEnd(30)}${us.toFixed(1).padStart(12)}${((us * 1000) / (N * DEG)).toFixed(2).padStart(10)}`,
  );
}
