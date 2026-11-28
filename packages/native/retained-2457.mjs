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
 * note — the probe fails loudly instead of printing a reassuring zero.
 *
 * ⚠️ THE OLD TEETH-CHECK NO LONGER BLINDS IT, and that is a correction rather than a regression
 * (item 2473). At item 2457 the check was "set `RET_STEP` so large that no sample is taken, and
 * every arm reads 0". Adding the unconditional RESULT reading defeats that: with no samples at all
 * the gate still measures 256.8x and passes, because the result reading is always taken. The
 * instrument is harder to blind than it was, and the documented check is simply stale — to verify
 * the gate still fires, make the CALIBRATION arm stop holding (`hold` -> false) and confirm the
 * ratio collapses below 10x.
 *
 *   RET_N=200000 RET_DEG=1 bun run alloc:retained
 *
 * `--expose-gc` is required; without it the probe cannot force a collection and exits rather
 * than silently reporting occupancy.
 */
import { Graph } from '@lenke/core';
import {
  V,
  dedupe,
  fold,
  groupCount,
  order,
  out,
  repeat,
  run,
  simplePath,
  traversal,
  values,
} from '@lenke/gremlin';

if (typeof global.gc !== 'function') {
  console.error('retained-2457: needs --expose-gc (node --expose-gc retained-2457.mjs)');
  process.exit(1);
}

const N = Number(process.env.RET_N ?? 200000);
const DEG = Number(process.env.RET_DEG ?? 1);
const STEP = Number(process.env.RET_STEP ?? 16384);
const REPS = Number(process.env.RET_REPS ?? 3);
/*
 * CARDINALITY is a SECOND axis, and the one that separates the buffering shapes (item 2473).
 * `order` and `fold` must hold every ROW, so they scale with N. `dedupe` and `groupCount` hold a
 * key set / a map, so they scale with the number of DISTINCT values and should be flat in N. Vary
 * this, not RET_N, to tell the two apart.
 */
const CARD = Number(process.env.RET_CARD ?? 97);

console.log(`retained-2457: N=${N} DEG=${DEG} STEP=${STEP} REPS=${REPS} CARD=${CARD}`);

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[sorted.length >> 1];
};

const graph = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % CARD } }));
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

/*
 * TWO QUANTITIES, because sampling by OUTPUT ROW has a hole that only a folding shape reveals
 * (item 2473). `fold()` and `groupCount()` emit ONE row and `dedupe()` emitted 97, all far below
 * `STEP`, so the in-loop sampler never fired once and reported 0.00 MiB for a `fold()` that must
 * hold every value. A zero from an instrument that never sampled is not a measurement.
 *
 *   peak    the maximum live set observed DURING the walk, sampled every STEP rows. Meaningful for
 *           a shape that emits many rows; blind to one that emits few.
 *   result  the live set while the LAST row is still referenced, read after the walk. For a folding
 *           shape that IS the peak — the fold's own accumulator — and for a streaming shape it is
 *           one row, so it stays near zero.
 *
 * `samples` is reported so a zero can be told apart from an unsampled arm.
 */
const peakRetained = (plan, hold) => {
  global.gc();

  const base = process.memoryUsage().heapUsed;
  const keep = hold ? [] : undefined;
  let peak = 0;
  let n = 0;
  let samples = 0;
  let lastRow;

  for (const row of run(plan, graph)) {
    n += 1;
    lastRow = row;

    if (hold) {
      keep.push(row);
    }

    if (n % STEP === 0) {
      // A full collection BEFORE the reading is what makes this retention, not occupancy.
      global.gc();

      samples += 1;

      const used = process.memoryUsage().heapUsed - base;

      if (used > peak) {
        peak = used;
      }
    }
  }

  // Always read once with the last row still reachable, so a one-row arm is measured at all.
  global.gc();

  const result = process.memoryUsage().heapUsed - base;

  if (hold && keep.length !== n) {
    throw new Error(`calibration arm lost rows: kept ${keep.length} of ${n}`);
  }

  if (lastRow === undefined && n > 0) {
    throw new Error('lastRow was dropped, so the result reading is meaningless');
  }

  return { peak, n, samples, result };
};

const CALIBRATION = 'CALIBRATION (holds every row)';
/*
 * THE BUFFERING ARMS (item 2473). This probe was built at item 2457 to ask "does shape X stream or
 * buffer?" and then only ever aimed at hop walks, which stream. These are the shapes it was for.
 *
 * The GQL side of the question is already covered — `alloc:peak`'s shape table carries `hop1collect`
 * and `hop1distinct`, and items 2419-2424 worked that ground. The GREMLIN buffering steps had no
 * memory row at all, and this probe is a Gremlin instrument (it drives `run(plan, graph)`).
 *
 * `dedupe` is the interesting prediction rather than the obvious one: its live set is a key SET, so
 * it should be bounded by the number of DISTINCT values (97 on this fixture) and therefore FLAT in N,
 * while `order` and `fold` must hold every row.
 */
/*
 * THE FRONTIER ARMS (item 2474). `alloc:peak` MECH=cap could not resolve this question at all — its
 * 8 MiB bisection step swallowed the signal at every size tried, and the LINEAR control said so
 * (`hop1` read 8 MiB at both fanout 1 and 3 while the graph-alone baseline moved 47 -> 71 MiB). This
 * probe resolves 0.01 MiB, so it can.
 *
 * `repeat(out).times(3)` walks a frontier; adding `simplePath()` forces per-path state, which is the
 * Gremlin analogue of the mechanism `acyclic-reachset-2003.mjs` describes on the GQL side (a reached
 * SET is bounded by |V| whatever the branching; a path enumeration is not). Sweep RET_DEG — the
 * out-degree — because a frontier scales with BRANCHING, not with N (item 2473) or cardinality.
 *
 * This measures the GREMLIN surface. It is NOT a measurement of GQL's TRAIL/ACYCLIC modes, which
 * remain unresolved for want of a fine enough GQL-side instrument.
 */
const arms = [
  ['streaming values()  [control]', traversal(V(), values('k')), false],
  ['repeat(out).times(3)', traversal(V(), repeat(out('E')).times(3)), false],
  ['repeat(out,simplePath).x3', traversal(V(), repeat(out('E'), simplePath()).times(3)), false],
  ['order()', traversal(V(), values('k'), order()), false],
  ['dedupe()', traversal(V(), values('k'), dedupe()), false],
  ['fold()', traversal(V(), values('k'), fold()), false],
  ['groupCount()', traversal(V(), values('k'), groupCount()), false],
  [CALIBRATION, traversal(V(), values('k')), true],
];
const measured = new Map();

console.log('  arm                              rows  smpl   during    result    WORST');

for (const [name, plan, hold] of arms) {
  for (let i = 0; i < 2; i += 1) {
    let c = 0;

    for (const _row of run(plan, graph)) {
      c += 1;
    }
  }

  const runs = [...Array(REPS)].map(() => peakRetained(plan, hold));
  const peak = median(runs.map((r) => r.peak));
  const result = median(runs.map((r) => r.result));
  const [{ n: rows, samples }] = runs;
  const worst = Math.max(peak, result);

  measured.set(name, worst / Math.max(rows, 1));

  console.log(
    `  ${name.padEnd(31)}${String(rows).padStart(8)} ${String(samples).padStart(4)}  ${(peak / 1024 / 1024).toFixed(2).padStart(8)}  ${(result / 1024 / 1024).toFixed(2).padStart(8)}  ${(worst / 1024 / 1024).toFixed(2).padStart(7)} MiB`,
  );
}

/*
 * THE GATE. The calibration arm retains every row, so it must dominate the streaming arms by a
 * wide margin. If it does not, the sampler is not seeing live data and every zero above is
 * meaningless — fail rather than report it.
 */
const calibration = measured.get(CALIBRATION);
const streaming = measured.get('streaming values()  [control]');
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
