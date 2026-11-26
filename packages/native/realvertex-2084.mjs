// Item 2084 — the same loop over REAL engine vertices instead of plain objects.
//
// THE FLOOR MUST USE THE DATA STRUCTURE THE ENGINE USES. Every arm of the decomposition built
// `{ properties: {...} }` — a plain FIELD read. A real `Vertex` exposes `get properties()`, and that
// getter was visible in the profile at 3.7%. A floor over plain objects prices a different machine.
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 14);

const g = new Graph();

for (let i = 0; i < N; i++) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
}

const bucket = g.verticesByLabel.get('P');
const plain = [...bucket].map((v) => ({
  id: v.id,
  labels: v.labels,
  properties: { n: v.properties.n },
}));
const isNullish = (v) => v === null || v === undefined;
const propOf = (el, key) => (el === undefined || el === null ? null : el.properties[key]);
const numArg = (v) => (typeof v === 'number' ? v : Number(v));
const SV = 'n';
const accs = [{ kind: 'values', argFn: (env) => propOf(env.binding.get(SV), 'n') }];

const envelope = (source) => () => {
  const binding = new Map();
  const env = { binding, params: {}, graph: {} };
  const state = [[]];
  let n = 0;

  for (const v of source) {
    binding.set(SV, v);
    n += 1;

    for (let i = 0; i < accs.length; i += 1) {
      const a = accs[i];

      if (a.kind === 'rows') {
        continue;
      }

      const value = a.argFn(env);

      if (isNullish(value)) {
        continue;
      }

      state[i].push(value);
    }
  }

  return n === N ? state[0].reduce((s, v) => s + numArg(v), 0) : -1;
};

const arms = {
  // The decomposition's arm: a plain object with a FIELD called `properties`.
  plainobj: envelope(plain),
  // THE SAME LOOP OVER THE ENGINE'S OWN Vertex INSTANCES, from the same container the engine reads.
  realvertex: envelope(bucket),
  // Just the getter, nothing else — is `get properties` itself the term?
  getteronly: () => {
    let sum = 0;

    for (const v of bucket) {
      sum += v.properties.n;
    }

    return sum;
  },
  // The same, on plain objects, as its control.
  fieldonly: () => {
    let sum = 0;

    for (const v of plain) {
      sum += v.properties.n;
    }

    return sum;
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

const series = [];
let out;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  out = arms[arm]();
  series.push(performance.now() - t0);
}

const expect = (N * (N - 1)) / 2;

if (out !== expect) {
  throw new Error(`${arm} answered ${out}, expected ${expect} — arms not equivalent`);
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  `${arm.padEnd(11)} median=${median.toFixed(3)} ms  ${((median * 1e6) / N).toFixed(2)} ns/row  series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
