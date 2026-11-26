/*
 * Item 2085 — `get labels()` ends in `this.#lbox?.set ?? new Set()`. Does an UNLABELLED vertex take
 * that fallback, and does it allocate a Set on EVERY read?
 *
 * REAL ENGINE VERTICES, from the engine's own container — item 2084's lesson: a floor over plain
 * objects priced a different machine and hid 25% of a query.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 14);

const labelled = new Graph();
const bare = new Graph();

for (let i = 0; i < N; i++) {
  labelled.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
  bare.addVertex({ id: `v${i}`, labels: [], properties: { n: i } });
}

const labelledVs = [...labelled.verticesById.values()];
const bareVs = [...bare.verticesById.values()];

// IDENTITY CHECK FIRST, not a timing guess: if the fallback allocates, two reads of the same
// vertex return DIFFERENT Set objects. That is the mechanism, stated as an assertion.
const [b0] = bareVs;
const [l0] = labelledVs;
// TWO SEPARATE READS INTO CONSTS, not `x.labels === x.labels` — that trips `no-self-compare`,
// and the point is precisely that these are two DISTINCT reads of the same accessor.
const bareFirst = b0.labels;
const bareSecond = b0.labels;
const labelledFirst = l0.labels;
const labelledSecond = l0.labels;
const bareSame = bareFirst === bareSecond;
const labelledSame = labelledFirst === labelledSecond;

const matchesLabel = (v, l) => l === undefined || v.labels.has(l);

const arms = {
  // The seeded loop's per-row test, on vertices that HAVE the label.
  'labelled-has': () => {
    let kept = 0;

    for (const v of labelledVs) {
      if (matchesLabel(v, 'P')) {
        kept += 1;
      }
    }

    return kept === N ? kept : -1;
  },
  // The same test on vertices with NO labels — every read takes the `?? new Set()` fallback if
  // there is no box, so this arm is the allocation's price.
  'bare-has': () => {
    let kept = 0;

    for (const v of bareVs) {
      if (matchesLabel(v, 'P')) {
        kept += 1;
      }
    }

    return kept === 0 ? N : -1;
  },
  // The getter alone, no `.has`, to split the two terms.
  'labelled-getter': () => {
    let seen = 0;

    for (const v of labelledVs) {
      if (v.labels !== undefined) {
        seen += 1;
      }
    }

    return seen === N ? seen : -1;
  },
  'bare-getter': () => {
    let seen = 0;

    for (const v of bareVs) {
      if (v.labels !== undefined) {
        seen += 1;
      }
    }

    return seen === N ? seen : -1;
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

arms[arm](); // warm the #lbox cache — the first read per element populates it (item 2084)

const series = [];
let out;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  out = arms[arm]();
  series.push(performance.now() - t0);
}

if (out !== N) {
  throw new Error(`${arm} answered ${out}, expected ${N}`);
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  `${arm.padEnd(16)} median=${median.toFixed(3)} ms  ${((median * 1e6) / N).toFixed(2)} ns/row   [identity: bare ${bareSame ? 'STABLE' : 'NEW SET EACH READ'}, labelled ${labelledSame ? 'STABLE' : 'NEW SET EACH READ'}]`,
);
