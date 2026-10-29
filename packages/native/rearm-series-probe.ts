/**
 * Does the CSR re-arm actually heal item 1120's filtered-typed-count 6x, read by read? (item 1167)
 *
 * Item 1120 priced a FILTERED typed count at **6.0x** after one adjacency write (FRESH 257.9us,
 * STALE 1556.9, STALE+rebuild 207.2) on the shape `reverse.rs` names:
 *
 *     200,000 nodes / 80,000 sparse F edges / MATCH (a)-[:F]->(b) WHERE b.age >= 77 RETURN count(*)
 *
 * and left it open as "the half item 1118 did not fix". **But item 1120 predates items 1121/1122**,
 * which measured the rebuild's break-even at ~2 reads and shipped `rearm_if_warranted` at the QUERY
 * BOUNDARY with `REARM_AFTER = 4`. So the standing 6x may no longer be standing at all — it may be
 * a transient over the first few reads after each write, which is a different (and much smaller)
 * claim. `CLOSED.md` still carries it as open, and item 1166's status pass missed it.
 *
 * An AGGREGATE timing cannot answer this: averaged over N reads, a penalty that heals after 4 and
 * one that never heals look like the same number for small N and diverge only in the limit. So this
 * prints the **PER-READ SERIES**, which is where the heal is visible as a step:
 *
 *   - read 1..4 on a stale overlay should be slow (the 4th triggers the rebuild)
 *   - read 5 onward should be at the FRESH cost
 *   - and a second write should reproduce the whole step, not just the first time
 *
 * It runs through the FFI (`lnk_query`), which is the ONLY path with the re-arm wired in — an
 * in-process Rust probe measures the engine WITHOUT it, which is exactly why item 1120's number
 * reads as permanent. Comparing the two is the point.
 *
 *   cd packages/native && bun rearm-series-probe.ts
 */
import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.REARM_N ?? 200_000);
const EDGES = Number(process.env.REARM_E ?? 80_000);
const READS = Number(process.env.REARM_READS ?? 12);

let seed = 0x5eed_0f;
const nextInt = (bound: number): number => {
  // INTEGER arithmetic — item 702's f64 LCG collapsed its period to ~11k draws.
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;

  return seed % bound;
};

const lines: string[] = [];

for (let i = 0; i < N; i += 1) {
  lines.push(
    `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${nextInt(100)}}}`,
  );
}

// SPARSE `F` edges — one in 2.5 nodes carries one — because the penalty is proportional to how
// SELECTIVE the queried type is (CLAUDE.md: 1.96x at 1 edge in 2, 24.07x at 1 in 50). A dense
// fixture would understate it.
for (let e = 0; e < EDGES; e += 1) {
  lines.push(
    `{"type":"edge","id":"e${e}","labels":["F"],"from":"v${nextInt(N)}","to":"v${nextInt(N)}","properties":{}}`,
  );
}

const doc = lines.join('\n');

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const g = graphFromNdjson(createFfiEngineBackend(LIB), doc);

const Q = 'MATCH (a)-[:F]->(b) WHERE b.age >= 77 RETURN count(*) AS c';
const WRITE = 'INSERT (:Person {age: 50})-[:F]->(:Person {age: 90})';

/** One read, timed, with the answer returned so a change in it cannot hide behind the timing. */
const read = (): { ms: number; answer: unknown } => {
  const t = performance.now();
  const rows = g.query(Q) as Record<string, unknown>[];

  return { ms: performance.now() - t, answer: rows[0]?.c };
};

console.log(`\n# ${N} nodes / ${EDGES} sparse F edges, ${READS} reads per phase\n`);

// Warm: get past any first-call effects so the FRESH baseline is the steady state, not a cold run.
for (let i = 0; i < 5; i += 1) {
  read();
}

// A MEDIAN of nine, not one reading. The ratio columns below divide by this, and a single sample
// as the denominator made them wobble (5.8x vs 6.0x for the same mean) while the `% at baseline`
// column — which divides by nothing — was identical to the percent across rounds. A noisy
// denominator is a noisy table, and the fix is cheaper than the caveat.
const freshSamples: number[] = [];
let freshAnswer: unknown;

for (let i = 0; i < 9; i += 1) {
  const { ms, answer } = read();

  freshSamples.push(ms);
  freshAnswer = answer;
}

const fresh = {
  ms: freshSamples.toSorted((a, b) => a - b)[4],
  answer: freshAnswer,
};

console.log(
  `  FRESH baseline            ${fresh.ms.toFixed(2)} ms   answer ${String(fresh.answer)}`,
);
console.log(
  '\n  Two write-then-read cycles. REARM_AFTER = 4, so if the re-arm works the 4th read on a\n' +
    '  stale overlay triggers the rebuild and the 5th onward is back at the baseline.\n',
);

for (const cycle of [1, 2]) {
  g.query(WRITE); // one adjacency write -> clears csr_fresh

  const series: string[] = [];
  let answer: unknown;

  for (let i = 0; i < READS; i += 1) {
    const { ms, answer: a } = read();

    series.push(ms.toFixed(1));
    answer = a;
  }

  console.log(`  cycle ${cycle} reads 1..${READS}:  ${series.join('  ')}`);
  console.log(
    `           answer ${String(answer)} (grows by 1 per cycle — the write adds an F edge)`,
  );
}

console.log(
  '\n  A flat series means the re-arm is NOT reaching this shape; a step after the 4th read means\n' +
    "  it is, and item 1120's 6x is a transient over a handful of reads rather than a standing cost.",
);

// THE RESIDUAL, which the series above implies and which is the genuinely open part. `REARM_AFTER`
// is 4 BY DESIGN — item 1121 measured a rebuild at ~2x a stale read, so rebuilding to serve one or
// two reads loses — which means a workload that interleaves ONE read per write never rebuilds at
// all and pays the stale cost on EVERY read, permanently. Item 1122 said as much from the other
// side ("nothing measurable below five"), as a limit on its win rather than as a standing cost.
// This measures it as the cost it is.
console.log(
  '\n  INTERLEAVED, one read per write — the ratio at which the re-arm deliberately never fires\n',
);

for (const perWrite of [1, 2, 4, 8, 16, 32, 64]) {
  // A fresh start for each ratio, so a previous ratio's rebuild cannot carry over.
  g.query(WRITE);

  for (let i = 0; i < 6; i += 1) {
    read();
  }

  const samples: number[] = [];

  for (let round = 0; round < 8; round += 1) {
    g.query(WRITE);

    for (let i = 0; i < perWrite; i += 1) {
      samples.push(read().ms);
    }
  }

  // THE MEAN, not the median, and the first draft of this block got it wrong in the way
  // CLAUDE.md warns about: print the per-rep series before trusting any summary of it. Each
  // cycle is BIMODAL — the first four reads are stale (the fourth also paying the rebuild) and
  // the rest are at the fresh baseline — so at a ratio of 8 the median lands exactly on the
  // 50/50 boundary and reports the SLOW mode, hiding a heal the series above shows plainly. It
  // read 5.8x at every ratio, which is the giveaway: a summary that does not move when the thing
  // it summarizes does.
  //
  // Amortized cost per read IS the mean, and it is also the decision-relevant number: what a
  // workload at this ratio actually pays.
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const atBaseline = samples.filter((x) => x < fresh.ms * 2).length;

  console.log(
    `  ${String(perWrite).padStart(2)} read(s) per write   mean ${mean.toFixed(2)} ms` +
      `   ${(mean / fresh.ms).toFixed(1)}x baseline` +
      `   ${((100 * atBaseline) / samples.length).toFixed(0)}% of reads at baseline`,
  );
}
