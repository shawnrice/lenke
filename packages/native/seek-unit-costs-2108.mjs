/*
 * Item 2108 — derive the TS engine's seek break-even FROM ITS OWN PER-UNIT COSTS, the way native did.
 *
 * NATIVE'S DERIVATION, from `opt.rs`: "a scan costs 1.88 ns per node scanned and a seek 12.2 ns per
 * row returned, both flat in selectivity, so a seek stops being worth it at 1.88/12.2 = 15.4%". The TS
 * engine's `SEEK_MAX_FRACTION` is 1/8 = 12.5%, close to that number — but it was NOT derived this way: it
 * took `SEEK_MARGIN`'s already-shipped 1/8, bracketed by two curve measurements at 16.25% and 18%.
 *
 * **AND A CURVE SWEEP SAYS THE TS BREAK-EVEN IS MUCH HIGHER.** Measured at five values of the
 * constant on two shapes, raising it to 0.25 won **2.08x at 14.3% selectivity and 1.07-1.19x at 25%**,
 * with 0.35 REGRESSING at 33% (0.79-0.84x). If that is right, the per-unit costs should say so — because
 * a ratio of two measured rates is a reason, where a curve fit is only a result.
 *
 * WHY THE TWO ENGINES SHOULD DIFFER HERE: native scans a COLUMN (a `u32` compare, 1.88 ns/node). The
 * TS engine walks a `Map` iterator and reads a property off a plain object per node. If its scan is
 * relatively more expensive, the break-even moves UP — and the ratio is the whole prediction.
 *
 * BOTH RATES MUST BE MEASURED ON THE SAME GRAPH WITH THE SAME QUERY SHAPE, varying only whether the
 * index exists. Comparing a seek on one fixture against a scan on another measures the fixtures.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const REPS = Number(process.env.REPS ?? 15);
const MOD = 1000;

/** One fixture, built twice: with the index (so a seek is possible) and without (so it must scan). */
const build = (withIndex) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { n: i % 97, sel: (i * 7919) % MOD },
    });
  }

  if (withIndex) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['sel'] });
  }

  return g;
};

const indexed = build(true);
const plain = build(false);

const timeIt = (g, q, params) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, params);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(4).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], rows: Number(rows[0].rows) };
};

const Q = 'MATCH (b:P) WHERE b.sel < $hi RETURN min(b.n) AS c, count(*) AS rows';

console.log(`  NODES=${NODES}, median of ${REPS}\n`);

/*
 * THE SCAN RATE comes from the UNINDEXED graph, where no seek is possible at any selectivity, so the
 * cost is (nodes scanned) x (scan rate) + (rows matched) x (per-row work). Two widely separated
 * selectivities separate those two terms by simultaneous equations rather than assuming either.
 */
const sNarrow = timeIt(plain, Q, { hi: 10 });
const sWide = timeIt(plain, Q, { hi: 900 });
const perRowScan = ((sWide.ms - sNarrow.ms) * 1e6) / (sWide.rows - sNarrow.rows);
const scanFixed = sWide.ms - (perRowScan * sWide.rows) / 1e6;
const scanPerNode = (scanFixed * 1e6) / NODES;

console.log(`  SCAN (no index)`);
console.log(`    ${sNarrow.rows} rows  ${sNarrow.ms.toFixed(3)} ms`);
console.log(`    ${sWide.rows} rows  ${sWide.ms.toFixed(3)} ms`);
console.log(`    => per matched row ${perRowScan.toFixed(2)} ns, fixed ${scanFixed.toFixed(3)} ms`);
console.log(`    => SCAN RATE ${scanPerNode.toFixed(2)} ns/node over ${NODES} nodes\n`);

/*
 * THE SEEK RATE comes from the INDEXED graph at selectivities BELOW the gate, where the seek is taken.
 * Above the gate the indexed graph scans too, so those points measure the scan and would corrupt the
 * rate — which is why only narrow points are used.
 */
const kNarrow = timeIt(indexed, Q, { hi: 10 });
const kMid = timeIt(indexed, Q, { hi: 100 });
const seekPerRow = ((kMid.ms - kNarrow.ms) * 1e6) / (kMid.rows - kNarrow.rows);

console.log(`  SEEK (indexed, below the gate)`);
console.log(`    ${kNarrow.rows} rows  ${kNarrow.ms.toFixed(3)} ms`);
console.log(`    ${kMid.rows} rows  ${kMid.ms.toFixed(3)} ms`);
console.log(`    => SEEK RATE ${seekPerRow.toFixed(2)} ns/row returned\n`);

/*
 * THE DERIVATION, native's own: a seek returning `f * NODES` rows costs `f * NODES * seekPerRow`; the
 * scan it replaces costs `NODES * scanPerNode`. They cross at `f = scanPerNode / seekPerRow`.
 */
const breakEven = scanPerNode / seekPerRow;

console.log(
  `  BREAK-EVEN = ${scanPerNode.toFixed(2)} / ${seekPerRow.toFixed(2)} = ${(breakEven * 100).toFixed(1)}% of the graph`,
);
console.log(
  `  SEEK_MAX_FRACTION is 12.5%.  Native's is 15.4%, derived the same way from 1.88 / 12.2.`,
);
