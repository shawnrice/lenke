/**
 * Does the TS engine pay extra for a PAIR of extrema the way the Rust engine did? (item 1192)
 *
 * Item 1188 found `min(k), max(k)` over a bare scan unserved natively for every non-numeric
 * representation — 8332x the single-aggregate `min(k)` on a boolean — because
 * `try_scan_multi_agg` destructured `Column::Num` alone. The fix landed every representation on
 * ~2x a single aggregate, which is the floor for two folds.
 *
 * The TS engine has no column representations, so this is NOT a transfer of that fix (item 1176's
 * rule). But the QUESTION transfers: does asking for both extrema cost about 2x one of them, or
 * more? Item 1183 established that TS's extremum fold is already free relative to its walk, which
 * predicts ~2x here — so this probe is mostly a CHECK on that prediction, and a cheap one.
 *
 * FLOOR: the SINGLE `min(k)`, doubled. A pair legitimately does two folds, so `pair / (2 x single)`
 * is the number that matters — anything near 1.00 means there is nothing to win.
 *
 *   cd packages/native && bun pair-agg-ts-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.PAIR_N ?? 200_000);
const REPS = Number(process.env.PAIR_REPS ?? 9);

let seed = 0x2f6e2b1;
const nextInt = (bound: number): number => {
  // INTEGER arithmetic — item 702's f64 LCG collapsed its period to ~11k draws.
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;

  return seed % bound;
};

const lines: string[] = [];

for (let i = 0; i < N; i += 1) {
  const n = nextInt(1_000_000);

  lines.push(
    `{"type":"node","id":"v${i}","labels":["Person"],"properties":` +
      `{"num":${n},"str":"u${String(i).padStart(8, '0')}","dict":"g${n % 8}","bool":${n % 2 === 0}}}`,
  );
}

const g = tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());

/** Median of the reps after dropping three as warm-up — item 579's instrument. */
const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const timed = (q: string): number => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    tsQuery(g, q);
    series.push(performance.now() - t);
  }

  return med(series);
};

console.log(`\n# ${N} nodes, ts engine, median of ${REPS} dropping 3\n`);
console.log('  column     pair(ms)   single min(ms)   pair ÷ (2 x single)');

for (const key of ['num', 'str', 'dict', 'bool']) {
  const pair = timed(`MATCH (n:Person) RETURN min(n.${key}) AS lo, max(n.${key}) AS hi`);
  const single = timed(`MATCH (n:Person) RETURN min(n.${key}) AS lo`);

  console.log(
    `  ${key.padEnd(9)} ${pair.toFixed(1).padStart(9)} ${single.toFixed(1).padStart(16)} ` +
      `${(pair / (2 * single)).toFixed(2).padStart(21)}x`,
  );
}
