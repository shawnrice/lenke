/**
 * Does the TS engine pay the same `collect` egress cost the Rust engine just stopped paying? (1196)
 *
 * Item 1194 priced ungrouped `collect` in Rust against the right floor — `RETURN a.k`, the identical
 * N values through the projection path — and item 1195 found the cost was `resolve_elem` REBUILDING
 * the whole result list at egress to rewrite element refs that were not there, then removed it for
 * 1.25x. The TS engine is a separate implementation with no `resolve_elem`, so whether it has the
 * same shape is a question, not an inference.
 *
 * SAME TWO FLOORS, same reasons (items 1187/1189: a control must not be subject to the hole it
 * measures):
 *
 *   count(a.k)   the SCAN floor — touches the column, materializes nothing.
 *   RETURN a.k   the MATERIALIZATION floor — the identical N values, projected instead of folded.
 *                `collect` cannot beat the cost of producing its own output, so anything above
 *                this is fold/egress overhead.
 *
 * ⚠️ `size(collect(a.k))` is deliberately NOT a floor here. That was item 1194's instrument and
 * item 1195 showed it INVALID in Rust: `size`/`cardinality` has a borrow-not-clone path that reads
 * `len()` without a pass, so the floor skipped work the real egress cannot and overstated the gap
 * ~3.5x. It is measured below only to see whether TS has an analogous shortcut.
 *
 * ESTIMATOR: median of the reps after dropping the first three, not min — the TS per-row path
 * plateaus high and emits a rare fast rep, so min estimates two arms differently (the repo's
 * documented rule). The per-rep series is printed so a bimodal row is visible rather than hidden
 * behind a summary.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.SPELL_N ?? 200_000);
const REPS = Number(process.env.BENCH_REPS ?? 11);
const DROP = 3;

// A deterministic LCG in INTEGER math. The repo's item 702 records an f64 LCG whose period
// collapsed from 2^31 to ~11k draws because `s * 1103515245` passes 2^53 — nothing about the
// output looks wrong, so the arithmetic has to be right by construction.
let seed = 0x2545_f491;
const next = (m: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

  return seed % m;
};

const g = new TsGraph();

for (let i = 0; i < N; i++) {
  const n = next(1_000_000);

  g.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: {
      num: n,
      str: `u${String(i).padStart(8, '0')}`,
      dict: `g${n % 8}`, // eight distinct values, so a dictionary-shaped column
      bool: n % 2 === 0,
    },
  });
}

const timeOne = (q: string): number => {
  const t0 = performance.now();

  tsQuery(g, q);

  return performance.now() - t0;
};

/** Median of the reps after dropping the warm-up ones (see the header on estimators). */
const measure = (q: string): { ms: number; series: number[] } => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r++) {
    series.push(timeOne(q));
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], series };
};

console.log(`\n# ts engine, ${N} nodes, median of ${REPS - DROP} after dropping ${DROP}\n`);
console.log('  column    collect   size(coll)   count(k)   materialize   collect/mat');

const rows: Record<string, number[]> = {};

for (const key of ['num', 'str', 'dict', 'bool']) {
  const collect = measure(`MATCH (a:Person) RETURN collect(a.${key}) AS c`);
  const sized = measure(`MATCH (a:Person) RETURN size(collect(a.${key})) AS c`);
  const count = measure(`MATCH (a:Person) RETURN count(a.${key}) AS c`);
  const mat = measure(`MATCH (a:Person) RETURN a.${key} AS c`);

  rows[key] = collect.series;
  console.log(
    `  ${key.padEnd(8)} ${collect.ms.toFixed(1).padStart(9)} ${sized.ms.toFixed(1).padStart(12)} ` +
      `${count.ms.toFixed(1).padStart(10)} ${mat.ms.toFixed(1).padStart(13)} ` +
      `${(collect.ms / mat.ms).toFixed(2).padStart(12)}x`,
  );
}

console.log(
  '\n  per-rep collect series (a BIMODAL row is a reason to distrust any single summary):',
);

for (const [key, series] of Object.entries(rows)) {
  console.log(`    ${key.padEnd(6)} ${series.map((x) => x.toFixed(0)).join(' ')}`);
}

console.log(
  '\n  collect/mat near 1.0 => TS does NOT have the rebuild item 1195 removed from Rust,\n' +
    '  and there is no target here however large the ts/ffi ratio looks.',
);
