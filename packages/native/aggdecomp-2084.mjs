// Item 2084 — WHERE IS aggsum's RESIDUE? Item 2083 priced the binding (4.2 ns), the push (5.5) and
// the three passes (1.4) against a measured 38.8 ns a row, leaving ~70% unattributed.
//
// THIS IS A CONSTRUCTIVE DECOMPOSITION, NOT AN ABLATION. Item 2067: replacing a computed value
// with a constant measures a different loop. So each arm ADDS one term the engine actually has, every
// arm is asserted to the same sum, and the arm names say what was added.
//
// ONE ARM PER PROCESS (item 2058).
const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 14);

const arrayOf = new Array(N);
const byId = new Map();
const byLabel = new Set();

for (let i = 0; i < N; i++) {
  const v = { id: `v${i}`, labels: new Set(['P']), properties: { n: i } };

  arrayOf[i] = v;
  byId.set(v.id, v);
  byLabel.add(v);
}

const isNullish = (v) => v === null || v === undefined;
const propOf = (el, key) => (el === undefined || el === null ? null : el.properties[key]);
const numArg = (v) => (typeof v === 'number' ? v : Number(v));
const matchesLabel = (v, l) => l === undefined || v.labels.has(l);
const SV = 'n';

// THE ACCUMULATOR SHAPE THE ENGINE BUILDS: an array of records, each with a `kind` and a compiled
// `argFn` closure that reads through the binding.
const accs = [{ kind: 'values', argFn: (env) => propOf(env.binding.get(SV), 'n') }];

const finish = (state) => state[0].reduce((s, v) => s + numArg(v), 0);

const arms = {
  // 1. The container, iterated. Nothing else.
  'a-array': () => {
    let sum = 0;

    for (const v of arrayOf) {
      sum += v.properties.n;
    }

    return sum;
  },
  // 2. THE SAME LOOP OVER A `Set` — which is what `verticesByLabel.get(name)` actually hands back.
  'b-set': () => {
    let sum = 0;

    for (const v of byLabel) {
      sum += v.properties.n;
    }

    return sum;
  },
  // 3. And over a Map's values iterator — the UNLABELLED scan's container.
  'c-mapvalues': () => {
    let sum = 0;

    for (const v of byId.values()) {
      sum += v.properties.n;
    }

    return sum;
  },
  // 4. Set + the label test the engine runs per row.
  'd-set-label': () => {
    let sum = 0;

    for (const v of byLabel) {
      if (!matchesLabel(v, 'P')) {
        continue;
      }

      sum += v.properties.n;
    }

    return sum;
  },
  /*
   * 5. **THE ENGINE'S ACTUAL ENVELOPE FOR THIS SHAPE — AND IT HAS NO LABEL TEST.** The dist reads
   *    `if (seeded !== void 0 && !matchesLabel(v, labelEff)) continue;` and `aggsum` has no WHERE, so
   *    `seeded` is undefined and the test is SKIPPED. Arm `d` above adds a term this path does not
   *    pay — kept only because it prices the test for the SEEDED shapes that do.
   */
  'e-envelope-noLabel': () => {
    const binding = new Map();
    const env = { binding, params: {}, graph: {} };
    const state = [[]];
    let n = 0;

    for (const v of byLabel) {
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

    return n === N ? finish(state) : -1;
  },
  // 6. The same envelope WITH the label test, for the seeded shapes that run it.
  'f-envelope-label': () => {
    const binding = new Map();
    const env = { binding, params: {}, graph: {} };
    const state = [[]];
    let n = 0;

    for (const v of byLabel) {
      if (!matchesLabel(v, 'P')) {
        continue;
      }

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

    return n === N ? finish(state) : -1;
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
  `${arm.padEnd(16)} median=${median.toFixed(3)} ms  ${((median * 1e6) / N).toFixed(2)} ns/row  series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
