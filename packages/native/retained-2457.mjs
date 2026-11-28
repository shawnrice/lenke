/*
 * PEAK RETAINED during a lazy walk — the memory question `alloc:*` could not answer.
 *
 * The existing churn instruments measure TOTAL BYTES ALLOCATED, which is a throughput and
 * GC-pressure quantity. It is NOT what bounds how large a traversal can get before the process
 * dies. That bound is PEAK RETAINED: the live set at the walk's high-water mark. Churn is
 * collected as it goes and costs headroom nothing.
 *
 * Item 2455 nearly conflated the two, and item 2457 measured why they are not interchangeable:
 * sampling `heapUsed` WITHOUT a collection reports OCCUPANCY, which counts garbage still waiting
 * for a scavenge. On that reading the untyped hop measured 31.82 MiB against a calibration arm
 * that RETAINS all 200,000 rows at 13.43 MiB — a walk holding nothing appearing to outweigh one
 * holding everything. Forcing a full collection at each sample turns the same probe into a
 * retention measurement and the ordering corrects itself.
 *
 * THE CALIBRATION ARM IS NOT OPTIONAL. It holds every row, so it MUST read far above the
 * streaming arms; if it does not, the sampler is blind and the zeros below mean nothing. This is
 * the "calibrate a new instrument against a known quantity" rule, as an assertion rather than a
 * note — the probe fails loudly instead of printing a reassuring zero. Verified to fire: with
 * `RET_STEP` large enough that no sample is ever taken, every arm reads 0 and the probe exits 1.
 *
 *   RET_N=200000 RET_DEG=1 bun run alloc:retained
 *
 * `--expose-gc` is required; without it the probe cannot force a collection and exits rather
 * than silently reporting occupancy.
 */
import { Graph } from '@lenke/core';
import { V, out, run, traversal, values } from '@lenke/gremlin';

if (typeof global.gc !== 'function') {
  console.error('retained-2457: needs --expose-gc (node --expose-gc retained-2457.mjs)');
  process.exit(1);
}

const N = Number(process.env.RET_N ?? 200000);
const DEG = Number(process.env.RET_DEG ?? 1);
const STEP = Number(process.env.RET_STEP ?? 16384);
const REPS = Number(process.env.RET_REPS ?? 3);

console.log(`retained-2457: N=${N} DEG=${DEG} STEP=${STEP} REPS=${REPS}`);

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[sorted.length >> 1];
};

const graph = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
}

for (let d = 0; d < DEG; d += 1) {
  for (let e = 0; e < N; e += 1) {
    graph.addEdge({
      id: `e${d}_${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3 + d * 104729) % N],
      labels: ['E'],
      properties: {},
    });
  }
}

const peakRetained = (plan, hold) => {
  global.gc();

  const base = process.memoryUsage().heapUsed;
  const keep = hold ? [] : undefined;
  let peak = 0;
  let n = 0;

  for (const row of run(plan, graph)) {
    n += 1;

    if (hold) {
      keep.push(row);
    }

    if (n % STEP === 0) {
      // A full collection BEFORE the reading is what makes this retention, not occupancy.
      global.gc();

      const used = process.memoryUsage().heapUsed - base;

      if (used > peak) {
        peak = used;
      }
    }
  }

  if (hold && keep.length !== n) {
    throw new Error(`calibration arm lost rows: kept ${keep.length} of ${n}`);
  }

  return { peak, n };
};

const CALIBRATION = 'CALIBRATION (holds every row)';
const arms = [
  ['untyped out()', traversal(V(), out(), values('k')), false],
  ['typed   out(E)', traversal(V(), out('E'), values('k')), false],
  [CALIBRATION, traversal(V(), out('E'), values('k')), true],
];
const measured = new Map();

console.log('  arm                              rows   PEAK RETAINED   B/row retained');

for (const [name, plan, hold] of arms) {
  for (let i = 0; i < 2; i += 1) {
    let c = 0;

    for (const _row of run(plan, graph)) {
      c += 1;
    }
  }

  const runs = [...Array(REPS)].map(() => peakRetained(plan, hold));
  const peak = median(runs.map((r) => r.peak));
  const rows = runs[0].n;
  const mib = (peak / 1024 / 1024).toFixed(2).padStart(9);

  measured.set(name, peak / rows);

  console.log(
    `  ${name.padEnd(31)}${String(rows).padStart(8)}   ${mib} MiB   ${(peak / rows).toFixed(1).padStart(10)}`,
  );
}

/*
 * THE GATE. The calibration arm retains every row, so it must dominate the streaming arms by a
 * wide margin. If it does not, the sampler is not seeing live data and every zero above is
 * meaningless — fail rather than report it.
 */
const calibration = measured.get(CALIBRATION);
const streaming = Math.max(measured.get('untyped out()'), measured.get('typed   out(E)'));
const ratio = calibration / Math.max(streaming, 0.001);

console.log(`\n  calibration / streaming = ${ratio.toFixed(1)}x  (must exceed 10x)`);

if (!(ratio > 10)) {
  console.error(
    '  INSTRUMENT BLIND: the arm that retains every row did not outweigh the streaming arms.',
  );
  process.exit(1);
}

console.log(
  '  instrument OK: a retaining walk is visible, so the streaming arms really do stream.',
);
