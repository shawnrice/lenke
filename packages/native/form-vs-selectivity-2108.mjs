/*
 * Item 2108 — the cliff is the PREDICATE FORM, not the selectivity.
 *
 * WHAT NARROWED IT. A sweep over `b.bK = 'hit'` (equality on a TWO-VALUED key) jumped 52 -> 410 ms
 * between 75,000 and 150,000 rows and then went FLAT. The same sweep written as a RANGE (`b.sel < $hi`)
 * is SMOOTH across the same range — 51.8 at 75,000 rows and 58.5 at 150,000, where equality read 410.
 *
 * SO THE TWO FORMS ARE COMPARED AT IDENTICAL SELECTIVITY, on ONE fixture that carries both keys, with
 * the SAME answer asserted. A difference is then the form and nothing else — which is this repo's named
 * bug class ("equivalent spellings must cost the same").
 *
 * BOTH KEYS ARE INDEXED and both predicates select the same vertices by construction: `dense` is
 * `'hit'` exactly when `sel < hi`, so `dense = 'hit'` and `sel < $hi` are the same set every time.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);
const MOD = 1000;

/** Build a graph whose `dense` flag marks exactly the vertices with `sel < hi`. */
const build = (hi) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const sel = (i * 7919) % MOD;

    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { n: i % 97, sel, dense: sel < hi ? 'hit' : 'miss' },
    });
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

  if (process.env.NOINDEX !== '1') {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['sel'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['dense'] });
  }

  return g;
};

const timeIt = (g, q, params) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, params);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer: JSON.stringify(rows) };
};

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, median of ${REPS}\n`);
console.log(
  `  ${'1-in-N'.padStart(7)} ${'vertices'.padStart(9)} ${'range <'.padStart(9)} ${"= 'hit'".padStart(9)} ${'ratio'.padStart(8)}`,
);

for (const oneIn of (process.env.ONEIN ?? '16,10,8,7,6,5,4,3,2').split(',').map(Number)) {
  const hi = Math.max(1, Math.round(MOD / oneIn));
  const g = build(hi);
  const range = timeIt(g, 'MATCH (a:P)-[:E]->(b:P) WHERE b.sel < $hi RETURN min(a.n) AS c', { hi });
  const equal = timeIt(g, "MATCH (a:P)-[:E]->(b:P) WHERE b.dense = 'hit' RETURN min(a.n) AS c", {});

  // THE TWO FORMS MUST SELECT THE SAME SET, or this is two questions and the ratio is meaningless.
  if (range.answer !== equal.answer) {
    throw new Error(`1-in-${oneIn}: the forms disagree — ${range.answer} vs ${equal.answer}`);
  }

  const ratio = equal.ms / range.ms;

  console.log(
    `  ${String(oneIn).padStart(7)} ${String(Math.round((NODES * hi) / MOD)).padStart(9)} ${range.ms.toFixed(3).padStart(9)} ${equal.ms.toFixed(3).padStart(9)} ${ratio.toFixed(2).padStart(7)}x${ratio > 2 ? '  FORM GAP' : ''}`,
  );
}
