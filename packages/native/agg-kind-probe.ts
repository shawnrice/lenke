/**
 * Does the TS engine have the AGGREGATE-KIND gap item 1161 closed natively? (item 1161)
 *
 * Natively, `min`/`max` over a dense numeric column cost 435/473 us against `sum`/`avg`/
 * `stddev_pop` at 122 on the SAME column — 3.6-3.9x — because the fold carried an `Option<f64>`
 * through the loop. Item 1161 made all of them ~103 us. The TS engine is a separate
 * implementation with its own `extremumFold`, which also starts from `undefined` and tests it
 * per value, so the question transfers; item 1156 is the precedent for a negative answer being
 * worth the four queries.
 *
 * Every row asserts the TS and NATIVE answers are EQUAL, which is what made items 1156 and 1159
 * worth more than their headline — the assertion independently exercises code shipped the same
 * tick. Here it checks item 1161's NaN counting against an engine that gets there by comparing.
 *
 *   cd packages/native && bun agg-kind-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.AGG_N ?? 200_000);
const REPS = Number(process.env.AGG_REPS ?? 9);

let seed = 0x2f6e2b1;
const next = (bound: number): number => {
  // The repo's dep-free LCG, in INTEGER arithmetic — item 702's f64 version collapsed its period
  // to ~11k draws and nothing about the output looked wrong.
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;

  return seed % bound;
};

const lines = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"n":${next(1_000_000)}}}`,
);
const doc = lines.join('\n');

const g = tsDeserialize(doc, 'ndjson', new TsGraph());

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

/** Median of the reps after dropping three as warm-up — item 579's instrument. */
const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

console.log(`\n# ${N} nodes, one dense numeric property, median of ${REPS} dropping 3\n`);
console.log('  aggregate kind                       ts_ms     answer (ts === native, asserted)');

for (const [label, q] of [
  ['A1 count(a.n)        covered', 'MATCH (a:Person) RETURN count(a.n) AS c'],
  ['A2 sum(a.n)', 'MATCH (a:Person) RETURN sum(a.n) AS c'],
  ['A3 min(a.n)', 'MATCH (a:Person) RETURN min(a.n) AS c'],
  ['A4 max(a.n)', 'MATCH (a:Person) RETURN max(a.n) AS c'],
  ['A5 avg(a.n)', 'MATCH (a:Person) RETURN avg(a.n) AS c'],
  ['A6 stddev_pop(a.n)', 'MATCH (a:Person) RETURN stddev_pop(a.n) AS c'],
  ['A7 min(a.n), max(a.n)  MULTI', 'MATCH (a:Person) RETURN min(a.n) AS a, max(a.n) AS b'],
  ['A8 count(*)              [ctl]', 'MATCH (a:Person) RETURN count(*) AS c'],
] as const) {
  const answer = JSON.stringify(tsQuery(g, q));
  const natAnswer = JSON.stringify(nat.query(q));

  if (answer !== natAnswer) {
    throw new Error(`${label}: ts and native DISAGREE — ts ${answer} vs native ${natAnswer}`);
  }

  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    tsQuery(g, q);
    series.push(performance.now() - t);
  }

  console.log(`  ${label.padEnd(34)} ${med(series).toFixed(1).padStart(7)}   ${answer}`);
}
