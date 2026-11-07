/**
 * How much GC does a write shape actually cause, and of what kind?
 *
 * THE INSTRUMENT ITEM 1360 NAMED WAS WRONG. It said the write path's 12.4-20.7% `(garbage collector)`
 * share needed `--heap-prof`. Calibrated in `heap-prof-calibrate.mjs`, `--heap-prof` reports **0.7 MiB
 * for a process that allocates 128 MiB through one named function**, in both a retained and a garbage
 * arm, and never names the allocating function — so it cannot answer the question at all.
 *
 * This measures the quantity directly instead of inferring it from bytes: `PerformanceObserver` on
 * `'gc'` entries gives GC PAUSES with their duration and kind, which is exactly what the CPU
 * profile's `(garbage collector)` frame is made of. Minor (scavenge) versus major (mark-sweep) is the
 * load-bearing distinction — nursery garbage is cheap per byte, promotion is not — and bytes alone
 * cannot tell them apart.
 *
 *     ARM=addVertexProps REPS=10 node gc-cost-probe.mjs
 *
 * Reported per arm: wall ms, total GC ms and its share, the pause count and total by kind, and the
 * heap delta from `v8.getHeapStatistics()`. The share is the number to compare against the CPU
 * profile's `(garbage collector)` row — they are two instruments on one quantity, so they agreeing
 * is the check that either is trustworthy.
 */
import { PerformanceObserver, constants } from 'node:perf_hooks';
import v8 from 'node:v8';

import { Graph } from '@lenke/core';

const ARM = process.env.ARM ?? 'addVertexProps';
const REPS = Number(process.env.REPS ?? 10);
const N = Number(process.env.N ?? 20_000);
const FANOUT = 5;

const KIND = new Map([
  [constants.NODE_PERFORMANCE_GC_MINOR, 'minor(scavenge)'],
  [constants.NODE_PERFORMANCE_GC_MAJOR, 'major(mark-sweep)'],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weak-callback'],
]);

const pauses = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    pauses.push({ kind: e.detail?.kind, ms: e.duration });
  }
});

obs.observe({ entryTypes: ['gc'] });

const addVertexProps = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  return g.vertexCount;
};

const addVertexBare = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'] });
  }

  return g.vertexCount;
};

const addEdgeOnly = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'] }));
  }

  for (let k = 0; k < N * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: vs[(k * 7919) % N],
      to: vs[((k % N) * 104_729 + Math.floor(k / N) * 977) % N],
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g.edgeCount;
};

const ARMS = { addVertexProps, addVertexBare, addEdgeOnly };
const fn = ARMS[ARM];

if (fn === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

/**
 * ⚠️ YIELD BETWEEN REPS, and the default is `true` because NOT yielding changes what is measured.
 *
 * A `Graph` schedules `queueMicrotask(drainMutations)` on its first write and
 * `setTimeout(this.notify, 1)` through `scheduleNotify`. A pending timer holds `this.notify`, which
 * holds the Graph. A tight synchronous rep loop never yields, so NEITHER ever runs and **every rep's
 * graph stays live until the loop ends** — the heap grows linearly in reps (148 -> 614 -> 1242 MiB at
 * 10/45/90), GC finds nothing collectable, and a 256 MiB cap OOM-crashes outright.
 *
 * That is what item 1360's CPU profiles were running, which is why `(garbage collector)` read
 * 12.4-20.7%: GC working repeatedly over a heap where nothing can be freed. It is a property of the
 * harness, not of the write path.
 */
const YIELD = process.env.YIELD !== '0';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const before = v8.getHeapStatistics();
let sink = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  sink += fn();

  if (YIELD) {
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
}

const wall = performance.now() - t0;
const after = v8.getHeapStatistics();

/**
 * ⚠️ DRAIN THE OBSERVER BEFORE READING IT. `PerformanceObserver` delivers entries in a queued
 * callback, so a fully SYNCHRONOUS rep loop (`YIELD=0`) buffers every `'gc'` entry and none is
 * delivered before `disconnect()` — the probe then reports **0 pauses and 0.0% GC** for a run whose
 * CPU profile shows `(garbage collector)` at 12-21%. Two instruments disagreeing was the signal; the
 * fault was this one. Yielding twice lets the queued callback run before the count is read.
 */
await tick();
await tick();

obs.disconnect();

if (sink === 0) {
  throw new Error(`${ARM} produced NOTHING — the measurement would be of nothing`);
}

const byKind = new Map();

for (const p of pauses) {
  const k = KIND.get(p.kind) ?? `kind:${String(p.kind)}`;
  const cur = byKind.get(k) ?? { n: 0, ms: 0 };

  byKind.set(k, { n: cur.n + 1, ms: cur.ms + p.ms });
}

const gcMs = pauses.reduce((a, p) => a + p.ms, 0);
const mib = (b) => (b / (1024 * 1024)).toFixed(1);

console.log(`ARM=${ARM}  REPS=${REPS}  N=${N}  sink=${sink}
  wall            ${wall.toFixed(1)} ms
  GC total        ${gcMs.toFixed(1)} ms   ${((100 * gcMs) / wall).toFixed(1)}% of wall
  GC pauses       ${pauses.length}
  heap used       ${mib(before.used_heap_size)} -> ${mib(after.used_heap_size)} MiB
  heap limit      ${mib(after.heap_size_limit)} MiB`);

for (const [k, v] of [...byKind].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(
    `  ${k.padEnd(18)} ${v.n} pauses  ${v.ms.toFixed(1)} ms  avg ${(v.ms / v.n).toFixed(2)} ms`,
  );
}
