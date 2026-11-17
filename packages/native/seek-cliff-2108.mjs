/*
 * Item 2108 — binary-search the CLIFF: 2x the rows for 7.8x the time, then FLAT.
 *
 * 🔑 WHAT THE SWEEP FOUND. One hop, a predicate on the far node, an index on its key. Collected count
 * against time, confirmed in both sweep orders and with item 2107 KILLED (so it is pre-existing):
 *
 * ```text
 *      75,000 rows    52.7 ms
 *     150,000        410.4        <- 2x the rows, 7.8x the time
 *     300,000        426.4        <- and then FLAT
 *     600,000        437.4
 * ```
 *
 * ⚠️ LARGE-BUT-FLAT-IN-N MEANS A CEILING WAS HIT, not that the work scales. `min` shows the same cliff
 * (19.7 -> 97.6), so it is in the WALK rather than in either fold.
 *
 * 🔑 THE HYPOTHESIS IS A SEED-SIDE DECISION FLIPPING: at 1-in-8 selectivity the index seek is taken and
 * at 1-in-4 it is not, with the fallback far worse than the seek it replaced. ⚠️ The powers-of-two
 * fixture cannot separate "the threshold is here" from "the cost doubled", so this probe varies
 * selectivity CONTINUOUSLY and prints the per-row rate on both sides.
 *
 * ⚠️ THE WALK IS IDENTICAL AT EVERY POINT — same graph, same pattern, same index. ONLY the predicate's
 * selectivity moves, which is what makes a step in the curve attributable to the decision and not to
 * the fixture.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);
const MOD = Number(process.env.MOD ?? 1000);

const g = new Graph();

/*
 * ⚠️ `sel` IS A RESIDUE IN [0, MOD), so `sel < X` selects X/MOD of the vertices — any selectivity, not
 * just a power of two. A hash index on `sel` makes each distinct value seekable, and the query asks for
 * a RANGE so the number of seeded vertices can be tuned finely.
 */
for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { n: i % 97, sel: (i * 7919) % MOD },
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

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['sel'] });

const timeIt = (q, params) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, params);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer: rows[0] };
};

console.log(`  NODES=${NODES} FANOUT=${FANOUT} MOD=${MOD}, median of ${REPS}\n`);
console.log(
  `  ${'1-in-N'.padStart(8)} ${'vertices'.padStart(9)} ${'rows'.padStart(8)} ${'min ms'.padStart(9)} ${'ns/row'.padStart(8)}   step`,
);

/*
 * ⚠️ `sel < hi` with `hi` swept: an IN-list of hi values would be a different predicate form, and item
 * 2101's lesson is that the FORM decides the route. One form, many widths.
 */
let prevRate = 0;

for (const oneIn of [64, 32, 16, 12, 10, 8, 7, 6, 5, 4, 3, 2]) {
  const hi = Math.max(1, Math.round(MOD / oneIn));
  const q = `MATCH (a:P)-[:E]->(b:P) WHERE b.sel < $hi RETURN min(a.n) AS c, count(*) AS rows`;
  const r = timeIt(q, { hi });
  const rows = Number(r.answer.rows);
  const rate = (r.ms * 1e6) / rows;
  const step = prevRate === 0 ? '' : `${(rate / prevRate).toFixed(2)}x/row`;

  console.log(
    `  ${String(oneIn).padStart(8)} ${String(hi).padStart(9)} ${String(rows).padStart(8)} ${r.ms.toFixed(3).padStart(9)} ${rate.toFixed(1).padStart(8)}   ${step}${rate / (prevRate || rate) > 2 ? '  ⚠️ STEP' : ''}`,
  );
  prevRate = rate;
}
