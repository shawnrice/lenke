/**
 * ONE question, both routes, instrumented step by step (item 1590).
 *
 * `MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b)` against
 * `V().hasLabel(P).out(E).dedupe().count()` — same answer (50,000), ~7-9 ms in GQL against 0.527 in
 * Gremlin. Five mechanisms have been tested and rejected as the cause (items 1584/1587/1589:
 * `valueKey` string building was the only one that ever paid, identity keying is worse in both
 * arrangements, the per-element binding is flat, the polymorphic adjacency read is at the noise
 * floor). The walk is already the optimal SHAPE.
 *
 * ⚠️ SO STOP GUESSING AT MECHANISMS. This runs each surface alone, under a profile, so the frames
 * say where each one's time goes — and prints the ANSWER plus the per-vertex cost so a route that
 * is fast because it is doing less work cannot be mistaken for one that is fast.
 *
 *     ARM=gql   node --cpu-prof --cpu-prof-dir=DIR hop-distinct-route-compare.mjs
 *     ARM=grem  node --cpu-prof --cpu-prof-dir=DIR hop-distinct-route-compare.mjs
 *     ARM=both  node hop-distinct-route-compare.mjs      # answers + timings, no profile
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 40);
const ARM = process.env.ARM ?? 'both';

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
}

for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${rep}_${i}`,
      from: vs[i],
      to: vs[(i * 7919 + rep * 104_729 + 1) % NODES],
      labels: ['E'],
    });
  }
}

{
  const seen = new Set();

  for (const e of g.edges) {
    seen.add(e.to.id);
  }

  if (seen.size < NODES * 0.5) {
    throw new Error(`fixture is degenerate: ${seen.size} distinct targets of ${NODES}`);
  }
}

const GQL = 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c';
// `hasLabel('P')` is VACUOUS here (every vertex carries it) and `dropVacuousLabels` removes it, so
// this is the same plan the cross-surface probe measured.
const PLAN = G.traversal(G.V(), G.hasLabel('P'), G.out('E'), G.dedupe(), G.count());

const runGql = () => {
  const rows = query(g, GQL);

  return Array.isArray(rows) ? Object.values(rows[0] ?? {})[0] : null;
};
const runGrem = () => {
  const rows = G.toArray(PLAN, g);

  return Array.isArray(rows) ? Number(rows[0]) : null;
};

const time = (fn) => {
  const s = [];

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    fn();
    s.push(performance.now() - t0);
  }

  const kept = s.slice(3).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)] ?? 0;
};

if (ARM === 'gql') {
  console.log(
    JSON.stringify({ arm: 'gql', answer: runGql(), ms: Number(time(runGql).toFixed(3)) }),
  );
} else if (ARM === 'grem') {
  console.log(
    JSON.stringify({ arm: 'grem', answer: runGrem(), ms: Number(time(runGrem).toFixed(3)) }),
  );
} else {
  // Both, in each order, so neither is flattered by position.
  const a1 = runGql();
  const a2 = runGrem();
  const q1 = time(runGql);
  const r1 = time(runGrem);
  const r2 = time(runGrem);
  const q2 = time(runGql);
  const q = Math.min(q1, q2);
  const r = Math.min(r1, r2);

  console.log(
    JSON.stringify({
      answersAgree: a1 === a2,
      gqlAnswer: a1,
      gremAnswer: a2,
      gqlMs: Number(q.toFixed(3)),
      gremMs: Number(r.toFixed(3)),
      ratio: Number((q / r).toFixed(2)),
      gqlNsPerVertex: Number(((q * 1e6) / NODES).toFixed(1)),
      gremNsPerVertex: Number(((r * 1e6) / NODES).toFixed(1)),
    }),
  );
}
