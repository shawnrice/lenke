/**
 * WHICH ROUTE ANSWERS `count 3-hop + interior filter`, AND WHERE DOES ITS TIME GO?
 *
 * ⚠️ THIS QUESTION IS ASKED BECAUSE A NOTE SAYS TO ASK IT FIRST. Item 1683's route map found the row
 * never enters `sweepChain` (counters: 0 entries, 66,156 `side` calls), and item 1683 itself is the
 * entry that ignored its own predecessor's "find the route before editing" note, relaxed a memo gate
 * on an assumption, got incoherent results and had to revert. Item 1688 then took the start and end
 * filters at 33.9x and 28.8x while this row moved 1.05x, which confirms the row is somewhere else.
 *
 * So: no edit until the profile names the function.
 *
 *   node --cpu-prof --cpu-prof-dir=<dir> gql-interior-filter-route-probe.mjs
 *   N=200000 FANOUT=5 CALLS=20 node ... (the defaults)
 *
 * ⚠️ The fixture is item 1684's third-trap-free shape: the target is NONLINEAR in `i`, so in-degree
 * varies rather than being constant under a linear bijection, and a 3-walk count is not `N * F^k` by
 * arithmetic. The distinct-endpoint count is asserted before anything is timed.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const CALLS = Number(process.env.CALLS ?? 20);
const REPS = Number(process.env.REPS ?? 7);
const CUT = Number(process.env.CUT ?? 60);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

let e = 0;
const targets = new Set();

for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    targets.add(mix % N);
    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[mix % N],
      labels: ['KNOWS'],
      properties: {},
    });
    e += 1;
  }
}

// ⚠️ The fixture's own statistics, not its output: a degenerate generator returns the RIGHT answer.
if (targets.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${targets.size} distinct endpoints over ${N} vertices`);
}

const ROWS = {
  interior: `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE c.age > ${CUT} RETURN count(*) AS c`,
  // The two item 1688 took, as the controls that say the instrument is pointed at the right place.
  start: `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE a.age > ${CUT} RETURN count(*) AS c`,
  end: `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE d.age > ${CUT} RETURN count(*) AS c`,
  // The MIDDLE position written as an inline gate rather than a clause — equivalent spellings must
  // cost the same, and a rung that takes one and not the other is this repo's opening defect class.
  interiorInline: `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c WHERE c.age > ${CUT})-[:KNOWS]->(d) RETURN count(*) AS c`,
};

const counts = {};

for (const [name, q] of Object.entries(ROWS)) {
  counts[name] = Number(query(g, q)[0].c);
}

if (counts.interior !== counts.interiorInline) {
  throw new Error(
    `SPELLINGS DISAGREE: clause ${counts.interior} vs inline ${counts.interiorInline}`,
  );
}

const timed = (q) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, q);
    series.push(performance.now() - t0);
  }

  // ⚠️ MEDIAN of the warm reps, not min: the TS per-row path plateaus high and emits a rare fast
  // rep, so `min` estimates the two arms differently.
  const warm = series.slice(3).sort((a, b) => a - b);

  return { med: warm[Math.floor(warm.length / 2)], series };
};

console.log(`\nROUTE PROBE — ${N}v / ${g.edgeCount}e, ${targets.size} distinct endpoints\n`);
console.log('row              ms (median of warm)   count');

for (const [name, q] of Object.entries(ROWS)) {
  const { med, series } = timed(q);

  console.log(
    `${name.padEnd(16)} ${med.toFixed(1).padStart(8)}  ${String(counts[name]).padStart(12)}   series ${series.map((x) => x.toFixed(0)).join(' ')}`,
  );
}

// The profiled region: ONE shape per process would be better, but the point here is attribution
// across the four rows at once, and the dominant row is the one being profiled.
for (let i = 0; i < CALLS; i += 1) {
  query(g, ROWS.interior);
}
