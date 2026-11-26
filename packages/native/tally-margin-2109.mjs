/*
 * Item 2109 — `TALLY_SEEK_MARGIN = 8`'s crossover, re-measured at 200,000 and for BOTH of its uses.
 *
 * WHAT ITS OWN COMMENT SAYS. The table it was set from, at 20,000 users / 40,000 edges:
 *
 * ```text
 *     seeded-end matches   seeded   full tally
 *                      2     53.2       1328.8   seed, 25x
 *                   1000    428.8       1229.8   seed, 2.9x
 *                  10000   2030.0       1422.3   TALLY, 1.43x
 * ```
 *
 * — "the crossover is near 7,000 of 20,000" = **35%**, while a margin of 8 puts the threshold at
 * 2,500 = **12.5%**. Its own words: the threshold sits "inside the region where seeding still wins
 * about **1.8x** by interpolation". So a documented 1.8x is left on the table by a 2.8x-conservative
 * divisor — the same shape as item 2108's `SEEK_MAX_FRACTION`, which was 2.1x conservative.
 *
 * **BUT THAT TABLE IS AT 20,000, AND CLAUDE.md SAYS SWEEP THE SIZE** — cache-resident and not are
 * different questions and the transition is between 200k and 1M. A crossover measured at 20,000 is not
 * evidence for 200,000, in either direction.
 *
 * AND THE CONSTANT GUARDS TWO DIFFERENT DECISIONS with one divisor: the per-vertex TALLY (seed a
 * narrow vertex set and walk each one's edges, against tallying every edge) and `edgeSeek`, whose
 * denominator is EDGES rather than vertices. Both are swept here, because one number serving two cost
 * models is exactly what item 2108 found wrong between the engines.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 200000);
const DEGREE = Number(process.env.DEGREE ?? 2);
const REPS = Number(process.env.REPS ?? 11);
const MOD = 1000;

/*
 * DEGREE 2 MATCHES THE ORIGINAL TABLE'S FIXTURE ("At degree 2 that trade turns over well before the
 * bucket is exhausted"), because the tally's whole trade is "an adjacency lookup per seeded vertex to
 * save the edges of the vertices it skips" — which scales with degree. Raising it would measure a
 * different question, so `DEGREE` is a knob rather than a change.
 */
const g = new Graph();

for (let u = 0; u < USERS; u += 1) {
  g.addVertex({
    id: `u${u}`,
    labels: ['U'],
    properties: { n: u % 97, sel: (u * 7919) % MOD },
  });
}

let e = 0;

for (let d = 0; d < DEGREE; d += 1) {
  for (let u = 0; u < USERS; u += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`u${u}`),
      // The edge's OWN `esel` key, so the edge-seek arm has something to seek that is independent
      // of the vertex selectivity — otherwise the two arms move together and neither is attributable.
      to: g.getVertexById(`u${(u * 7 + 3 + d * 13) % USERS}`),
      labels: ['E'],
      properties: { w: e % 5, esel: (e * 7919) % MOD },
    });
    e += 1;
  }
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['sel'] });
g.createIndex({ on: 'edge', kind: 'hash', keys: ['esel'] });

const timeIt = (q, params) => {
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

const MARGIN = process.env.MARGIN ?? '?';

console.log(`  MARGIN=${MARGIN}  USERS=${USERS} DEGREE=${DEGREE} edges=${e}, median of ${REPS}`);
console.log(
  `  ${'%seeded'.padStart(8)} ${'vtx tally'.padStart(10)} ${'edge seek'.padStart(10)}   answers asserted`,
);

for (const oneIn of (process.env.ONEIN ?? '100,32,16,8,6,4,3,2').split(',').map(Number)) {
  const hi = Math.max(1, Math.round(MOD / oneIn));

  /*
   * THE VERTEX-TALLY SHAPE: a seekable predicate on the START, whose edges must then be walked.
   * This is the decision the original table measured.
   */
  const tally = timeIt('MATCH (a:U)-[:E]->(b:U) WHERE a.sel < $hi RETURN count(*) AS c', { hi });

  /* THE EDGE-SEEK SHAPE: the predicate is on the EDGE, so the denominator is the edge-type bucket. */
  const edge = timeIt('MATCH (a:U)-[r:E]->(b:U) WHERE r.esel < $hi RETURN count(*) AS c', { hi });

  console.log(
    `  ${((100 * hi) / MOD).toFixed(1).padStart(8)} ${tally.ms.toFixed(3).padStart(10)} ${edge.ms.toFixed(3).padStart(10)}   ${tally.answer.slice(0, 18)} ${edge.answer.slice(0, 18)}`,
  );
}
