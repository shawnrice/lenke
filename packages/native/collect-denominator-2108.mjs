/*
 * Item 2108 — is `collect`'s 0.175 ms a DEFECT or just 300 values' worth of work?
 *
 * ⚠️⚠️ **DIVIDE BY THE RIGHT DENOMINATOR, BEFORE PROFILING ANYTHING.** Item 2107 left `size(collect(a.n))`
 * at 0.175 ms where `min(a.n)` now costs 0.032 — 5.5x. But `collect` MATERIALIZES every value and `min`
 * folds to one, so some gap is the job rather than a defect. Item 2096's headline was 8x ROW COUNT and
 * item 2099 normalized a hop row by input edges; the same discipline applies here before a profile is
 * worth taking.
 *
 * 🔑 SO IT SWEEPS THE COLLECTED COUNT. A fixed overhead shows as a cost that barely moves; a per-value
 * cost shows as a flat ns/value. ⚠️ And `min` is swept BESIDE it over the same rows, so the comparison is
 * two folds over ONE walk rather than two different queries.
 *
 * ⚠️ THE TAG SELECTIVITY IS THE KNOB, so the WALK is identical at every point and only the number of
 * values collected changes. Varying the fixture instead would change both at once.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 15);

const g = new Graph();

/*
 * ⚠️ EACH VERTEX GETS A `bucket` AT EVERY SCALE, so one fixture serves the whole sweep. Selecting
 * `bucket{k}` collects roughly NODES*FANOUT/2^k values from an otherwise identical walk.
 */
for (let i = 0; i < NODES; i += 1) {
  const props = { n: i % 97, tag: `t${i % 2000}` };

  for (let k = 0; k < 12; k += 1) {
    props[`b${k}`] = i % 2 ** k === 0 ? 'hit' : 'miss';
  }

  g.addVertex({ id: `v${i}`, labels: ['P'], properties: props });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

for (let k = 0; k < 12; k += 1) {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: [`b${k}`] });
}

const timeIt = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, {});
    series.push(performance.now() - t0);
  }

  const kept = series.slice(4).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer: rows[0] };
};

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, median of ${REPS}\n`);
console.log(
  `  ${'rows walked'.padStart(12)} ${'collect ms'.padStart(11)} ${'ns/value'.padStart(9)} ${'min ms'.padStart(8)} ${'ratio'.padStart(7)}`,
);

/* ⚠️ Descending k so the LARGEST selection runs first — a warm-up artefact would then flatter the small
 * rows, which is the opposite of the conclusion being tested. */
for (const k of (process.env.KS ?? '11,9,7,5,3,1,0').split(',').map(Number)) {
  const where = `WHERE b.b${k} = 'hit'`;
  const col = timeIt(`MATCH (a:P)-[:E]->(b:P) ${where} RETURN size(collect(a.n)) AS c`);
  const fold = timeIt(`MATCH (a:P)-[:E]->(b:P) ${where} RETURN min(a.n) AS c`);
  const n = Number(col.answer.c);

  console.log(
    `  ${String(n).padStart(12)} ${col.ms.toFixed(3).padStart(11)} ${((col.ms * 1e6) / n).toFixed(1).padStart(9)} ${fold.ms.toFixed(3).padStart(8)} ${(col.ms / fold.ms).toFixed(2).padStart(6)}x`,
  );
}
