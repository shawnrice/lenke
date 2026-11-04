/**
 * ONE Gremlin traversal row, measured well enough to see a sub-10% change. The Gremlin twin of
 * `isolated-row-bench.mjs`, and it exists because that one is GQL-only — the same gap item 1359
 * found in the profile screen, one layer up.
 *
 * SAME METHOD, for the reasons item 1367 measured rather than assumed:
 *
 *   * per-rep timing, never a loop total (one GC pause then costs one sample, not the reading);
 *   * `p25` of the kept reps as the headline, because the noise on a 200k row is PROCESS-level —
 *     each process builds its own fixture and gets its own heap layout — so `p25` discards the
 *     GC-hit tail within a process and the PROCESS is the unit of sampling;
 *   * the whole distribution printed, because a summary of a bimodal series is a lie;
 *   * GC inside the measured window accounted, and the observer DRAINED before reading (item 1361);
 *   * one shape per process (item 762), deterministic fixture, answer in the output so an A/B
 *     driver can assert the arms agree.
 *
 *     SHAPE=hopcount3 NODES=200000 FANOUT=1 REPS=14 DROP=3 node isolated-gremlin-bench.mjs
 *
 * ⚠️ `toArray(plan, graph)` IN THAT ORDER. Item 1349 lost a round to the reverse, which throws
 * nothing useful and simply measures something else.
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { Graph } from '@lenke/core';
import {
  V,
  count,
  dedupe,
  groupCount,
  gt,
  has,
  hasLabel,
  order,
  out,
  outE,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const SHAPE = process.env.SHAPE ?? 'hopcount3';
const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 1);
/**
 * How often an edge carries BOTH `E` and `F`. 0 = never. Item 1375 is why this knob exists: a
 * fixture where every edge carries both labels cannot tell a walk that deduped nothing from one
 * that deduped everything, and a fixture where none do never reaches the deduping path at all.
 */
const MULTILABEL = Number(process.env.MULTILABEL ?? 0);
/**
 * How often a VERTEX carries a second label `Q`. 0 = never. The vertex twin of MULTILABEL, for the
 * same reason: `labelledCount` declines EVERY multi-label `hasLabel` outright, and its own doc says
 * the right answer is the union of the buckets. Whether that decline costs anything needs a row.
 */
const VLABEL = Number(process.env.VLABEL ?? 0);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);

const SHAPES = {
  // The largest row in `bench:gremlin`. `expandSlot` + `slotChainCount` + `degreeOfTypes` +
  // `bucketsOf` are ~76% of its profile at 200k.
  hopcount3: () => traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count()),
  // Two hops, answered by the degree inner product with no edge walk — the CONTROL for the row
  // above, because a change to the walk must not move this one.
  hopcount2: () => traversal(V(), hasLabel('P'), out('E'), out('E'), count()),
  filterchain: () => traversal(V(), hasLabel('P'), has('k', gt(44)), count()),
  grouped: () => traversal(V(), groupCount({ by: 'k' })),
  hopbare: () => traversal(V(), out('E')),
  hoporder: () => traversal(V(), out('E'), values('k'), order()),
  hopdedupe: () => traversal(V(), out('E'), dedupe(), count()),
  // THE MULTI-LABEL EDGE-STEP PAIR (item 1378). `iterLabeled` in `graph-queries.ts` builds a
  // `seen` Set and pays has+add per edge once more than one label is named — the same shape the
  // GQL twin had before items 1376-1377 removed it for 62.5%. Every edge carries `E`, so these two
  // count the SAME edges and only the route differs.
  edgesingle: () => traversal(V(), outE('E'), count()),
  edgemulti: () => traversal(V(), outE('E', 'F'), count()),
  // THE VERTEX-LABEL PAIR. Every vertex carries `P` and a fraction also carry `Q`, so these two
  // count the SAME vertices and only the route differs — the same design as the edge pair above.
  labelsingle: () => traversal(V(), hasLabel('P'), count()),
  labelmulti: () => traversal(V(), hasLabel('P', 'Q'), count()),
  // ORDER-REVERSED TWINS. Bucket 0 of a union walk is free and later buckets are iterated, so an
  // UNSORTED union makes these cost differently from the pair above while answering identically —
  // which is exactly the equivalent-spelling class CLAUDE.md says costs 100-300x and returns the
  // right answer. These rows exist to catch that.
  labelmultirev: () => traversal(V(), hasLabel('Q', 'P'), count()),
  edgemultirev: () => traversal(V(), outE('F', 'E'), count()),
  // THE YIELD TWINS (item 1387). The pairs above all end in `count()`, where the answer is a number
  // and items 1379/1382/1386 could replace the walk with a union of buckets outright. A projection
  // must actually PRODUCE every selected element, so it cannot take that route - this is the
  // instrument for whatever disparity survives on the yield side, where the GQL twin measured
  // 38.9 ms against 379.6 for the same edge set (9.8x).
  hopyieldsingle: () => traversal(V(), hasLabel('P'), out('E'), values('k')),
  hopyieldmulti: () => traversal(V(), hasLabel('P'), out('E', 'F'), values('k')),
  hopyieldmultirev: () => traversal(V(), hasLabel('P'), out('F', 'E'), values('k')),
};

const make = SHAPES[SHAPE];

if (make === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

/** Deterministic, so every process in an A/B builds byte-identical input. */
const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: VLABEL > 0 && i % VLABEL === 0 ? ['P', 'Q'] : ['P'],
        properties: { k: i % 97, s: `s${i % 1000}`, n: i },
      }),
    );
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: vs[(k * 7919) % NODES],
      to: vs[(k * 104_729) % NODES],
      labels: MULTILABEL > 0 && k % MULTILABEL === 0 ? ['E', 'F'] : ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();
const plan = make();

// Armed AFTER the fixture, so build-time collection is not attributed to the measured reps.
let gcMs = 0;
let gcCount = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    gcCount += 1;
  }
});

obs.observe({ entryTypes: ['gc'] });

const series = [];
let sink = 0;
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const rows = toArray(plan, g);
  const dt = performance.now() - t0;

  series.push(dt);
  sink += Array.isArray(rows) ? rows.length : 1;
  answer = Array.isArray(rows) ? rows[0] : rows;
}

// ⚠️ DRAIN before reading: `PerformanceObserver` delivers in a queued callback, so a synchronous
// loop buffers every entry and reports 0 pauses (item 1361's fifth instrument defect).
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

obs.disconnect();

if (sink === 0) {
  throw new Error(`${SHAPE} produced NOTHING across ${REPS} reps — measuring nothing`);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    fanout: FANOUT,
    reps: REPS,
    answer: typeof answer === 'object' ? JSON.stringify(answer) : answer,
    median: Number(at(0.5).toFixed(3)),
    p25: Number(at(0.25).toFixed(3)),
    p75: Number(at(0.75).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    max: Number(kept[kept.length - 1].toFixed(3)),
    gcMs: Number(gcMs.toFixed(1)),
    gcCount,
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
