/**
 * Does the TypeScript engine carry item 1137's spelling gap too? (item 1138)
 *
 * Item 1137 found that in the Rust engine `out().has(k).count()` cost 3.17x `out().values(k).count()`
 * — two spellings of ONE question, both answering correctly, differing only in which fast path
 * claimed them. That is the exact shape every historical index-seeding bug had, and the reason
 * `spelling_probe` exists.
 *
 * The TypeScript engine is a SEPARATE implementation with no `ir::Plan` to canonicalize, so the
 * claim has to be measured there rather than read off a plan. Nothing about fixing the Rust side
 * says anything about this one.
 *
 * Three spellings that must cost the same, plus a control neither can reach:
 *
 *   S1  V().out(K).has(age).count()        the presence filter
 *   S2  V().out(K).values(age).count()     the projection, which counts the same rows here
 *   C   V().out(K).count()                 no presence test at all — the floor
 *
 * S1 and S2 are one question ONLY because every node in the fixture carries `age`; the probe
 * asserts the two answers are equal before comparing times, so a divergence shows up as a failure
 * rather than as a misleading ratio.
 *
 *   cd packages/native && bun present-spelling-probe.ts
 *   PRESENT_N=400000 PRESENT_REPS=9 bun present-spelling-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { V, count, has, out, planToGremlin, toArray, traversal, values } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'dylib',
  win32: 'dll',
};
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const N = Number(process.env.PRESENT_N ?? 200_000);
const REPS = Number(process.env.PRESENT_REPS ?? 9);

const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
);

for (let k = 0; k < N; k += 1) {
  lines.push(
    `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${(k * 104_729) % N}","properties":{}}`,
  );
}

const doc = lines.join('\n');
const backend = createFfiEngineBackend(LIB);
const tsG = tsDeserialize(doc, 'ndjson', new TsGraph());
const natG = graphFromNdjson(backend, doc);

const SHAPES: [string, Plan][] = [
  ['S1 out.has(age).count', traversal(V(), out('KNOWS'), has('age'), count())],
  ['S2 out.values(age).count', traversal(V(), out('KNOWS'), values('age'), count())],
  ['C  out.count      [ctl]', traversal(V(), out('KNOWS'), count())],
];

/** Median of the reps after dropping three as warm-up — the TS path's `min` hides a plateau
 * (item 579's instrument: the general scalar path emits a RARE fast rep, so `min` estimates the
 * two arms differently). */
const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const series = (f: () => unknown): number[] => {
  const samples: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    f();
    samples.push(performance.now() - t);
  }

  return samples;
};

console.log(`\n# ${N} nodes / ${N} KNOWS edges, median of ${REPS} dropping 3\n`);
console.log('  shape                        ts_ms      ffi_ms      answer');

const answers = new Map<string, string>();

for (const [name, plan] of SHAPES) {
  const text = planToGremlin(plan);
  const tsAns = JSON.stringify(toArray(plan, tsG));
  const natAns = JSON.stringify(natG.gremlin(text));

  if (tsAns !== natAns) {
    throw new Error(`${name}: ts and native disagree — ${tsAns} vs ${natAns}`);
  }

  answers.set(name, tsAns);

  const ts = med(series(() => toArray(plan, tsG)));
  const ffi = med(series(() => natG.gremlin(text)));

  console.log(
    `  ${name.padEnd(26)} ${ts.toFixed(1).padStart(8)}  ${ffi.toFixed(1).padStart(10)}      ${tsAns}`,
  );
}

const s1 = answers.get('S1 out.has(age).count');
const s2 = answers.get('S2 out.values(age).count');

if (s1 !== s2) {
  throw new Error(`S1 and S2 are NOT one question on this fixture: ${s1} vs ${s2}`);
}

console.log(
  '\n  S1 and S2 return the same answer, so any time gap between them is a spelling gap.',
);
