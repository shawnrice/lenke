/**
 * Item 1918 — DOES THE RUST ENGINE SUM IN THE ORDER IT EMITS VALUES?
 *
 * This is the question `fusedorder-matrix-1918.mjs` does NOT answer, and the one that actually
 * decides whether fusing `sum`/`mean` is safe. That probe compared TS-fused against TS-generic —
 * a PROXY. The invariant is TS against **Rust**, and Rust could perfectly well sum in a different
 * internal order than it emits `values` in, in which case matching the emission order buys nothing.
 *
 * WHY THIS MATTERS MORE THAN THE SHAPE COUNT. Item 1831 already ran the TS-vs-TS experiment —
 * 25 cases, identical sequences — and item 1830 deliberately DECLINED to act on it: "That is
 * evidence, not proof, and byte-identity with the Rust engine is a hard invariant rather than a
 * target." More TS-vs-TS cases do not answer that objection; a direct TS-vs-Rust comparison on an
 * order-sensitive fixture does.
 *
 * THE FIXTURE MUST BE ABLE TO SEE SUMMATION ORDER OR THE WHOLE PROBE IS VACUOUS. A reciprocal
 * ramp spans magnitudes so that reversing the multiset changes the f64; integers would add
 * associatively and every arm would agree for reasons that have nothing to do with the engines.
 * The control is printed first and the probe refuses to interpret anything if it fails.
 *
 *     bun sumorder-native-1918.ts
 */
import { existsSync } from 'node:fs';

import { Graph as TsGraph } from '@lenke/core';
import {
  V,
  both,
  dedupe,
  gt,
  has,
  inV,
  in_,
  mean,
  out,
  outE,
  planToGremlin,
  sum,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'dylib',
  win32: 'dll',
};
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXT}`,
  import.meta.url,
).pathname;

if (!existsSync(LIB)) {
  console.error(`no engine library at ${LIB} — build it with --features capi`);
  process.exit(2);
}

const backend = createFfiEngineBackend(LIB);
const decoder = new TextDecoder();

const N = Number(process.env.N ?? 4000);
const FANOUT = 5;

const lines: string[] = [];

for (let i = 0; i < N; i += 1) {
  // The reciprocal ramp. `s` gives the string arm something to fold.
  lines.push(
    `{"type":"node","id":"v${i}","labels":${
      i % 6 === 2 ? '["P","Q"]' : '["P"]'
    },"properties":{"k":${1 / (i + 1)},"n":${i % 50},"s":"s${i % 7}"}}`,
  );
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  lines.push(
    `{"type":"edge","id":"e${e}","labels":${
      hop % 4 === 3 ? '["F"]' : '["E"]'
    },"from":"v${i}","to":"v${(i * 7 + 3 + hop * 2_654_435_761) % N}","properties":{"w":${e % 7}}}`,
  );
}

const ndjson = lines.join('\n');
const bytes = new TextEncoder().encode(ndjson);
const tsGraph = tsDeserialize(ndjson, 'ndjson', new TsGraph());

const nativeRun = (text: string): unknown[] => {
  const handle = backend.graphFromNdjson(bytes);

  try {
    return JSON.parse(decoder.decode(backend.gremlinJson(handle, text))) as unknown[];
  } finally {
    backend.graphFree(handle);
  }
};

/** THE CONTROL: can this fixture see summation order at all? */
const vals = nativeRun("g.V().out('E').values('k')") as number[];
const fwd = vals.reduce((a, b) => a + b, 0);
const rev = [...vals].reverse().reduce((a, b) => a + b, 0);

console.log(`fixture: ${vals.length} values from the native engine`);
console.log(`  sum forward ${fwd.toExponential(20)}`);
console.log(`  sum reverse ${rev.toExponential(20)}`);

if (fwd === rev) {
  console.error(
    'CONTROL VACUOUS: this fixture cannot see summation order, so nothing below means anything.',
  );
  process.exit(1);
}

console.log('  the control differs, so this fixture CAN see summation order\n');

/**
 * The shapes that reach the fused projected residual.
 *
 * THE NATIVE TEXT IS DERIVED FROM THE TS PLAN by `planToGremlin`, not written out beside it.
 * Two hand-maintained spellings of each shape could drift into being two different questions, and
 * then a disagreement would mean nothing. This is also what the differential fuzzer does.
 */
const SHAPES = [
  traversal(V(), out('E'), values('k'), sum()),
  traversal(V(), out('E'), values('k'), mean()),
  traversal(V(), in_('E'), values('k'), sum()),
  traversal(V(), both('E'), values('k'), sum()),
  traversal(V(), out(), values('k'), sum()),
  traversal(V(), out('E', 'F'), values('k'), sum()),
  traversal(V(), out('E'), out('E'), values('k'), sum()),
  traversal(V(), outE('E'), inV(), values('k'), sum()),
  traversal(V(), outE('E'), has('w', gt(3)), inV(), values('k'), sum()),
  traversal(V(), out('E'), has('n', gt(10)), values('k'), sum()),
  traversal(V(), out('E'), dedupe().by('k'), values('k'), sum()),
  traversal(V(), out('E'), values('k'), dedupe(), sum()),
];

/** Full f64 precision for a one-number answer, so a last-ulp difference is visible. */
const show = (v: unknown): string => {
  if (typeof v === 'string') {
    return v;
  }

  const arr = v as unknown[];

  return arr.length === 1 && typeof arr[0] === 'number'
    ? arr[0].toExponential(20)
    : JSON.stringify(arr).slice(0, 40);
};

let bad = 0;
let errs = 0;

for (const plan of SHAPES) {
  const text = planToGremlin(plan);
  let nat: unknown[] | string;
  let ts: unknown[] | string;

  try {
    nat = nativeRun(text);
  } catch (e) {
    nat = `ERR ${String(e).slice(0, 40)}`;
  }

  try {
    ts = toArray(plan, tsGraph);
  } catch (e) {
    ts = `ERR ${String(e).slice(0, 40)}`;
  }

  const a = show(nat);
  const b = show(ts);
  const isErr = a.startsWith('ERR') || b.startsWith('ERR');

  if (isErr) {
    errs += 1;
  } else if (a !== b) {
    bad += 1;
  }

  let mark = '';

  if (isErr) {
    mark = '';
  } else if (a === b) {
    mark = '';
  }

  console.log(`${mark}${text}`);
  console.log(`    native ${a}`);
  console.log(`    ts     ${b}`);
}

const ok = bad === 0 && errs === 0;
const errNote = errs > 0 ? `   ${errs} shape(s) errored and prove nothing` : '';

console.log(
  `\n${ok ? '' : ''} ${SHAPES.length - bad - errs}/${SHAPES.length} bit-identical${errNote}`,
);
process.exit(bad === 0 && errs === 0 ? 0 : 1);
