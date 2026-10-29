/**
 * Does the TS engine pay for `min`/`max` over a HOP the way the Rust engine did? (item 1183)
 *
 * Item 1182 widened `try_frontier_prop_agg` from `Column::Num` alone to five representations and
 * measured 8.25x (dict) / 4.76x (str) / 3.77x (bool) on a one-hop `min`. The mechanism was NOT the
 * column representation — it was collapsing the frontier to DISTINCT nodes, which is sound because
 * min/max over a multiset equals min/max over its distinct set.
 *
 * That distinction decides whether the win can transfer. Item 1176 found that a fast path gated on
 * a COLUMN REPRESENTATION has no TS twin at all, because the TS engine stores property bags and has
 * no column encodings to specialize. But this one is gated on query SHAPE, and shape-gated wins
 * HAVE transferred (items 1140/1141/1163). TS routes `min`/`max` through `extremumFold` over
 * materialized per-group values, and `shortcuts.ts` carries hop COUNT shortcuts but no
 * distinct-frontier collapse for an extremum — so the gap plausibly exists here too.
 *
 * MEASURE THE FLOOR BEFORE BUILDING (items 234/1162). Three floors, because they fail differently:
 *
 *   count(*) over the hop    the pure walk — no property is read at all
 *   count(b.k) over the hop  the walk plus one presence read per PATH
 *   min(a.k) over the scan   the same fold with no hop, as the served reference
 *
 * If `min(b.k)` already costs about what `count(b.k)` costs, the fold is not the expense and the
 * target dies here rather than after a day's work. If it costs materially more, the headroom is
 * real and is bounded by the walk floor — a collapse cannot beat enumerating the edges.
 *
 * Every row asserts the TS and NATIVE answers are EQUAL, which independently exercises the arms
 * item 1182 shipped, from an engine that reaches the answer by entirely different means.
 *
 *   cd packages/native && bun hop-extremum-ts-probe.ts
 *   HOP_N=200000 HOP_DEG=5 HOP_REPS=9 bun hop-extremum-ts-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.HOP_N ?? 50_000);
const DEG = Number(process.env.HOP_DEG ?? 5);
const REPS = Number(process.env.HOP_REPS ?? 9);

let seed = 0x2f6e2b1;
const nextInt = (bound: number): number => {
  // INTEGER arithmetic — item 702's f64 LCG collapsed its period to ~11k draws and produced a
  // fixture whose answer looked right while 93% of the edges sat on 7% of the vertices.
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

// Edges get IDS: `encode` emits them, so every reloaded snapshot has them, and omitting them
// skips the external-id path entirely (a documented way to measure the wrong thing).
let e = 0;

for (let i = 0; i < N; i += 1) {
  for (let d = 0; d < DEG; d += 1) {
    lines.push(
      `{"type":"edge","id":"e${e}","from":"v${i}","to":"v${nextInt(N)}","labels":["KNOWS"],"properties":{}}`,
    );
    e += 1;
  }
}

const doc = lines.join('\n');
const g = tsDeserialize(doc, 'ndjson', new TsGraph());

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

/**
 * Median of the reps after dropping three as warm-up — item 579's instrument. `min`-of-N is the
 * WRONG estimator on this path: the general scalar fold plateaus high and emits a rare fast rep,
 * so `min` reports the outlier for one arm and the plateau for the other.
 */
const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const timed = (q: string): { ms: number; answer: string; series: number[] } => {
  const answer = JSON.stringify(tsQuery(g, q));
  const natAnswer = JSON.stringify(nat.query(q));

  if (answer !== natAnswer) {
    throw new Error(`${q}\n  ts ${answer}\n  native ${natAnswer}\n  ENGINES DISAGREE`);
  }

  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    tsQuery(g, q);
    series.push(performance.now() - t);
  }

  return { ms: med(series), answer, series };
};

console.log(`\n# ${N} nodes / degree ${DEG} (${e} edges), ts engine, median of ${REPS} dropping 3`);

const walk = timed('MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c');

console.log(`\n  the pure-walk floor: count(*) over the hop = ${walk.ms.toFixed(1)} ms\n`);
console.log('  column     hop min(ms)  hop count(k)(ms)  scan min(ms)   x walk   x presence');

for (const key of ['num', 'str', 'dict', 'bool']) {
  const hopMin = timed(`MATCH (a:Person)-[:KNOWS]->(b) RETURN min(b.${key}) AS c`);
  const hopCnt = timed(`MATCH (a:Person)-[:KNOWS]->(b) RETURN count(b.${key}) AS c`);
  const scanMin = timed(`MATCH (a:Person) RETURN min(a.${key}) AS c`);

  console.log(
    `  ${key.padEnd(9)} ${hopMin.ms.toFixed(1).padStart(11)} ${hopCnt.ms.toFixed(1).padStart(17)} ` +
      `${scanMin.ms.toFixed(1).padStart(13)}   ${(hopMin.ms / walk.ms).toFixed(2)}x   ` +
      `${(hopMin.ms / hopCnt.ms).toFixed(2)}x`,
  );
}

// THE PER-REP SERIES, printed because a summary of a bimodal path is not trustworthy on its own
// (item 1167 reported a median that sat on a 50/50 boundary and never moved).
console.log('\n  per-rep series, hop min over num and str:');

for (const key of ['num', 'str']) {
  const s = timed(`MATCH (a:Person)-[:KNOWS]->(b) RETURN min(b.${key}) AS c`).series;

  console.log(`    ${key.padEnd(5)} ${s.map((x) => x.toFixed(1)).join(' ')}`);
}
