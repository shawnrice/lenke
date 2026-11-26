/*
 * Item 2107 — re-price item 2106's one-hop scalar-fold gap ISOLATED, one shape per process.
 *
 * **A SCREEN RANKS, IT DOES NOT PRICE — IN BOTH DIRECTIONS.** Item 2106's sweep flagged five
 * one-hop aggregates at 2.8-5.95x, but every row ran in ONE process, and the absolute times are small
 * (0.13-0.48 ms against 0.02-0.08). Item 2086's sweep UNDERSTATED a row by 4x and item 2099's INVENTED
 * three candidates out of five. So nothing here is believed until it is re-measured alone.
 *
 * ONE SHAPE PER PROCESS (`SHAPE=` picks it), because a two-distribution in-process A/B flatters any
 * change that redistributes call sites, and because these rungs share one dispatch.
 *
 * THE ESTIMATOR IS THE MEDIAN OF THE POST-WARM-UP REPS, not the min: the TS per-row path emits a rare
 * fast rep, and `min` reported a 0.72x control at item 2080 where medians read 1.00x. The per-rep SERIES
 * is printed so a step or a bimodal split is visible rather than averaged away.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 24);
const SHAPE = process.argv[2] ?? process.env.SHAPE ?? 'min';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, tag: `t${i % 2000}` } });
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

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });

const RETURNS = {
  min: 'min(a.n)',
  max: 'max(a.n)',
  sum: 'sum(a.n)',
  avg: 'avg(a.n)',
  cdist: 'count(DISTINCT a.n)',
  /* THE CONTROLS: item 2106 measured these CLEAN at one hop (1.10-1.44x). */
  star: 'count(*)',
  collect: 'size(collect(a.n))',
};

const ret = RETURNS[SHAPE];

if (ret === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; one of ${Object.keys(RETURNS).join(', ')}`);
}

const FWD = `MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN ${ret} AS c`;
const REV = `MATCH (b:P)<-[:E]-(a:P) WHERE b.tag = $t RETURN ${ret} AS c`;

const run = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { t: 't7' });
    series.push(performance.now() - t0);
  }

  // Four warm-up reps dropped — the first are visibly the JIT tiering up (item 2100 saw the FIRST
  // shape read 1.138 ms while a strictly harder one below it read 0.584).
  const kept = series.slice(4);
  const sorted = [...kept].sort((a, b) => a - b);

  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    series: kept.map((v) => v.toFixed(2)).join(' '),
    answer: JSON.stringify(rows),
  };
};

/*
 * ALTERNATED, not one block each: whichever runs second benefits from a warm allocator and warm
 * caches, so two rounds in opposite order and the better reading of each is what gets compared.
 */
const a1 = run(FWD);
const b1 = run(REV);
const b2 = run(REV);
const a2 = run(FWD);

if (a1.answer !== b1.answer) {
  throw new Error(`the spellings disagree — ${a1.answer} vs ${b1.answer}`);
}

const fwd = Math.min(a1.median, a2.median);
const rev = Math.min(b1.median, b2.median);

console.log(`\n  SHAPE=${SHAPE}  (${ret})   NODES=${NODES} FANOUT=${FANOUT}  answer=${a1.answer}`);
console.log(
  `  as written   median ${fwd.toFixed(3)} ms   [round1 ${a1.median.toFixed(3)} round2 ${a2.median.toFixed(3)}]`,
);
console.log(
  `  reversed     median ${rev.toFixed(3)} ms   [round1 ${b1.median.toFixed(3)} round2 ${b2.median.toFixed(3)}]`,
);
console.log(`  ratio        ${(fwd / rev).toFixed(2)}x\n`);
console.log(`  as written series: ${a1.series}`);
console.log(`  reversed   series: ${b1.series}`);
