/*
 * Item 2085 — item 1599 priced `v.labels.has(name)` at 5.5 ns a candidate over 400 candidates and
 * refuted two levers against it. This item measured 15.8 ns over 200,000. BOTH CAN BE RIGHT:
 * CLAUDE.md's first rule is "sweep the size — cache-resident and not are different questions; the
 * transition is between 200k and 1M elements". 400 vertices and their label boxes fit in cache; the
 * whole graph does not, and the test is a POINTER CHASE (vertex -> #lbox -> .set -> hash bucket).
 *
 * If the cost grows with the candidate count, 1599's refutations were measured on the cache-resident
 * arm and do not settle the realistic one.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const CANDS = Number(process.env.CANDS ?? N);
const REPS = Number(process.env.REPS ?? 14);

const g = new Graph();

for (let i = 0; i < N; i++) {
  g.addVertex({ id: `v${i}`, labels: [i % 3 === 0 ? 'P' : 'Q'], properties: { n: i } });
}

const all = [...g.verticesById.values()];

/*
 * THE CANDIDATES ARE SPREAD ACROSS THE WHOLE GRAPH, not the first CANDS vertices. A seeded scan's
 * hits are scattered by the index, so taking a contiguous prefix would be cache-friendlier than the
 * engine's real access pattern and would understate exactly the term under test.
 */
const stride = Math.max(1, Math.floor(N / CANDS));
const cands = [];

for (let i = 0; i < N && cands.length < CANDS; i += stride) {
  cands.push(all[i]);
}

/*
 * A parallel sole-label map, standing in for a `sole` field on the box. A `Map.get(object)` is
 * STRICTLY MORE work than a field read, so this arm UNDERSTATES the real lever — which makes it a
 * conservative floor rather than an optimistic one.
 */
const soleOf = new Map();

for (const v of all) {
  const [one] = [...v.labels];

  soleOf.set(v, v.labels.size === 1 ? one : undefined);
}

// Warm every box so the first-read Map lookup is not in the measurement (item 2084).
for (const v of cands) {
  v.labels.has('P');
}

const reps = Math.max(1, Math.ceil(200000 / cands.length));

const arms = {
  // What the engine does today.
  'getter-has': () => {
    let kept = 0;

    for (let r = 0; r < reps; r++) {
      for (const v of cands) {
        if (v.labels.has('P')) {
          kept += 1;
        }
      }
    }

    return kept;
  },
  /*
   * THE LEVER ITEM 1599 DID NOT TRY. Its two refuted levers were the DISPATCH (compiling the test
   * per query — flat) and the BUCKET (`verticesByLabel.get(n).has(v)` — slower, and blocked by a
   * stale index). This is a third: `LabelBox` carries `{ set }` only, so the test is a pointer chase
   * **vertex -> #lbox -> .set -> hash bucket**. A `sole` field on the box makes the single-label case
   * **vertex -> #lbox -> .sole -> compare** — one fewer object dereference and no string hash.
   *
   * Simulated here on a PARALLEL structure, because the real one needs a core change. The parallel
   * objects are built in the same order and read through the same indirection depth as the engine's,
   * so the DIFFERENCE is the lever; the absolute is not the engine's.
   */
  'sole-compare': () => {
    let kept = 0;

    for (let r = 0; r < reps; r++) {
      for (const v of cands) {
        if (soleOf.get(v) === 'P') {
          kept += 1;
        }
      }
    }

    return kept;
  },
  // THE NULL CONTROL: the same loop, no test. Item 1599 reported 0.34 ns for this.
  'no-test': () => {
    let kept = 0;

    for (let r = 0; r < reps; r++) {
      for (const v of cands) {
        if (v !== undefined) {
          kept += 1;
        }
      }
    }

    return kept;
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

arms[arm]();

const series = [];

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  arms[arm]();
  series.push(performance.now() - t0);
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];
const tests = cands.length * reps;

console.log(
  `cands=${String(cands.length).padStart(7)}  ${arm.padEnd(11)} ${((median * 1e6) / tests).toFixed(2)} ns/test  (${tests} tests, median ${median.toFixed(2)} ms)`,
);
