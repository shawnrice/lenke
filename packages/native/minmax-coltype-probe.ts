/**
 * Does the TS engine have the COLUMN-TYPE extremum gap item 1172 closed natively? (item 1172)
 *
 * Natively, `min`/`max` over a BOOL column cost 932 us against the numeric arm's 101 and its own
 * `count(<key>)` floor of 101 — 9x and 10x — because `Column::Bool` had no extremum arm and fell
 * to the general grouped fold, which boxes every cell. A dedicated arm with a SHORT CIRCUIT
 * (`false < true`, so `min` stops on the first present `false`) took it to 0.3 us, ~3107x.
 *
 * The TS engine is a separate implementation with no column representations at all — it stores
 * property bags per vertex — so the question is genuinely open rather than a transfer: there is no
 * `Column::Bool` to specialize, but `extremumFold` could still short-circuit on a boolean, and
 * whether it is slow for the same REASON (boxing) or fast for a different one is a measurement.
 *
 * Every row asserts the TS and NATIVE answers are EQUAL, which is what made items 1156/1159/1161
 * worth more than their headline: the assertion independently exercises the arm shipped this tick,
 * from an engine that reaches the answer by different means.
 *
 *   cd packages/native && bun minmax-coltype-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.COL_N ?? 200_000);
const REPS = Number(process.env.COL_REPS ?? 9);

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
      `{"num":${n},"str":"u${String(i).padStart(8, '0')}","dict":"g${n % 8}","bool":${n % 2 === 0},"date":${n % 30_000}}}`,
  );
}

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

console.log(`\n# ${N} nodes, median of ${REPS} dropping 3\n`);
console.log('  column       min(ms)   max(ms)  count(k)(ms)   answer (ts === native, asserted)');

for (const key of ['num', 'str', 'dict', 'bool', 'date']) {
  const timed = (agg: string): { ms: number; answer: string } => {
    const q = `MATCH (a:Person) RETURN ${agg}(a.${key}) AS c`;
    const answer = JSON.stringify(tsQuery(g, q));
    const natAnswer = JSON.stringify(nat.query(q));

    if (answer !== natAnswer) {
      throw new Error(
        `${agg}(${key}): ts and native DISAGREE — ts ${answer} vs native ${natAnswer}`,
      );
    }

    const series: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      const t = performance.now();

      tsQuery(g, q);
      series.push(performance.now() - t);
    }

    return { ms: med(series), answer };
  };

  const mn = timed('min');
  const mx = timed('max');
  const cnt = timed('count');
  const shown = mn.answer.length > 30 ? `${mn.answer.slice(0, 27)}...` : mn.answer;

  console.log(
    `  ${key.padEnd(10)} ${mn.ms.toFixed(1).padStart(8)} ${mx.ms.toFixed(1).padStart(9)} ` +
      `${cnt.ms.toFixed(1).padStart(12)}   ${shown}`,
  );
}
