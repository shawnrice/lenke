/**
 * IS `count 3-hop` ACTUALLY SLOWER AFTER ITEM 1689, OR IS A 5-10 ms ROW JUST NOISY?
 *
 * Item 1689 added a second flat-array arm behind a dispatcher, and the A/B's control — `count
 * 3-hop`, item 1685's unfiltered arm, which shares the file — read 5.6 PRE against 7.3 POST in both
 * rounds. Two readings of a 5.6 ms row are not an answer: the bench reports the MIN of 7 reps and
 * nothing else, and this repo's own note says `min` is the wrong estimator on the TS per-row path
 * because it plateaus high and emits a rare fast rep.
 *
 * So this prints the SERIES, and summarises it the way that note prescribes: drop the first three
 * reps as warm-up (visibly the JIT tiering up), take the MEDIAN of the rest.
 *
 * ⚠️ ONE SHAPE PER PROCESS. A second query shape in the same process pollutes the dispatch — item
 * 762's redistribution trap is exactly a change that moves which call sites are polymorphic, which
 * is what this is measuring.
 *
 *   node gql-threehop-control-probe.mjs            # the unfiltered row
 *   SHAPE=interior node gql-threehop-control-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 14);
const SHAPE = process.env.SHAPE ?? 'plain';
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
    g.addEdge({ id: `e${e}`, from: vs[i], to: vs[mix % N], labels: ['KNOWS'], properties: {} });
    e += 1;
  }
}

if (targets.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${targets.size} distinct endpoints over ${N} vertices`);
}

const Q =
  SHAPE === 'interior'
    ? `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE c.age > ${CUT} RETURN count(*) AS c`
    : 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN count(*) AS c';

const series = [];
let count = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  count = Number(query(g, Q)[0].c);
  series.push(performance.now() - t0);
}

const warm = series.slice(3).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)];

console.log(
  `SHAPE=${SHAPE} N=${N} count=${count} median=${median.toFixed(2)} min=${Math.min(...series).toFixed(2)} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
