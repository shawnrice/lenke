/**
 * Does running OTHER query shapes first make a spelling slower? (item 1558)
 *
 * The GQL spelling probe flags `node count: inline vs clause WHERE` at 2.56x and then 2.51x across
 * two full sweeps, yet the same group converges at ~1.2x when run ALONE (item 1557, three runs).
 * The probe's own advice is to treat an in-sweep-only flag as the harness — and that advice is
 * right for a one-off reading, but a flag that reproduces to within 0.05x twice is not noise.
 *
 * ⚠️ AND THE USUAL READING MAY BE BACKWARDS HERE. "Isolated is the true number" assumes the
 * isolated state is the realistic one. A long-lived server is the POLLUTED state: it has already
 * compiled and run dozens of query shapes through the same closures and megamorphic call sites. If
 * a spelling is more sensitive to that pollution than its twin, the in-sweep gap is the honest one
 * and the isolated convergence is the artifact.
 *
 * This probe measures exactly that, with the pollution as the independent variable:
 *
 *   POLLUTE=0 node dispatch-pollution-probe.mjs    # fresh process, nothing else run first
 *   POLLUTE=1 node dispatch-pollution-probe.mjs    # the warm-up shapes run first
 *
 * `ts-closure-size-is-load-bearing` and item 762 are the two standing records of this family: a
 * walk inlined into a returned closure gave UNRELATED queries a new slow mode, and a two-dist
 * in-process A/B flatters whichever arm redistributes its call sites.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const POLLUTE = process.env.POLLUTE !== '0';

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i % 97, n: i, s: `s${i % 50}`, flag: i % 3 === 0 },
    }),
  );
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: vs[i],
    to: vs[(i * 104_729 + 1) % NODES],
    labels: ['E'],
    properties: { w: i % 13 },
  });
}

// ⚠️ An INDEX on `k`, because the spelling probe's own fixture has one (item 579) and that is the
// difference between both spellings SEEKING and both SCANNING. `INDEXED=0` removes it.
if (process.env.INDEXED !== '0') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

/**
 * Shapes that come BEFORE the measured group in the real sweep — different clause kinds, different
 * predicate families, different projections. Each is run a few times so its route is compiled and
 * its call sites are live, which is what a server's engine looks like after a minute of traffic.
 */
const POLLUTERS = [
  'MATCH (n:P) WHERE NOT n.flag RETURN count(*) AS c',
  'MATCH (n:P) WHERE n.flag = false RETURN count(*) AS c',
  'MATCH (n:P) WHERE n.k > 1 RETURN count(*) AS c',
  'MATCH (n:P) FILTER n.k > 1 RETURN count(*) AS c',
  'MATCH (n:P) RETURN max(n.k) AS m',
  'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
  'MATCH (a:P) MATCH (a)-[:E]->(b) RETURN count(*) AS c',
  'MATCH (n:P) RETURN COUNT { MATCH (n)-[:E]->(x) } AS c',
  'MATCH (a:P)-[:E]->(b) WHERE b.k = 2 RETURN count(*) AS c',
  'MATCH (n:P) WHERE n.s = $s RETURN count(*) AS c',
  'MATCH (n:P) ORDER BY n.k RETURN count(*) AS c',
  'MATCH (a:P), (b:P) WHERE b.k = 7 RETURN count(*) AS c',
];

/** The measured group — the three spellings of one question. */
const ARMS = {
  'inline  {k: 2}': 'MATCH (n:P {k: 2}) RETURN count(*) AS c',
  'clause  n.k = 2': 'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
  'pattern WHERE': 'MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c',
};

if (POLLUTE) {
  for (const q of POLLUTERS) {
    for (let r = 0; r < 4; r += 1) {
      query(g, q, { s: 's1' });
    }
  }
}

const out = [];

// ⚠️ ONE SHAPE PER PROCESS is the only honest way to read this group, and item 1558 learned it the
// hard way: all three arms in one process reported the lifted build making the CLAUSE arm 1.39x
// SLOWER (1.74 -> 2.42 ms), which is not a cost of lifting at all. It is item 762's redistribution
// artifact — once the lift routes the inline spelling through the clause's route, the clause arm is
// measured SECOND through call sites the inline arm has just made polymorphic. `ONLY=clause`
// isolates one arm so no other spelling can pollute its dispatch.
const only = process.env.ONLY;

for (const [name, q] of Object.entries(ARMS)) {
  if (only !== undefined && !name.includes(only)) {
    continue;
  }

  for (let w = 0; w < 3; w += 1) {
    query(g, q);
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, q);
    series.push(performance.now() - t0);
  }

  series.sort((a, b) => a - b);
  out.push({ name, ms: series[0] });
}

const fastest = Math.min(...out.map((r) => r.ms));

console.log(
  `dispatch pollution — NODES=${NODES} REPS=${REPS} POLLUTE=${POLLUTE ? 'yes' : 'no'} (min)\n`,
);

for (const r of out) {
  console.log(
    `${r.name.padEnd(18)} ${r.ms.toFixed(2).padStart(8)} ms   ${(r.ms / fastest).toFixed(2)}x`,
  );
}
