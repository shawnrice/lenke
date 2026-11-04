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

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.env.SHAPE ?? 'hopcount3';
const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 1);

/**
 * How many DISTINCT far endpoints the edges reach, as a fraction of `NODES` (item 1392).
 *
 * The GQL twin got this at item 1390 for a different reason — pricing `farDrivenHopWalk`'s hoist —
 * and this one needs it to separate two explanations of the SAME number. Item 1392 decomposed the
 * per-row property read on this row and found the `far.properties` ACCESSOR is 70% of it (43.0 ms of
 * 61.2), which is ~215 ns a row for what should be two cached private-field reads. Either the
 * accessor's code is slow, or the cost is the POINTER CHASE to a cold far vertex — and those differ
 * in exactly one observable way: concentrating the edges onto a few endpoints makes the chase
 * cache-resident and leaves the code identical.
 *
 * `FANIN=1` (default) keeps `(k * 104729) % NODES` byte-for-byte. A smaller fraction points every
 * edge into the first `NODES * FANIN` vertices. Item 1066 already measured this family at **9.3x**
 * over a 50,000-wide far pool against a 100-wide one, holding the scan, the edges and the row count
 * fixed.
 */
const FANIN = Number(process.env.FANIN ?? 1);
const FAR_POOL = FANIN >= 1 ? NODES : Math.max(Math.floor(NODES * FANIN), 1);
/**
 * How often an edge carries BOTH `E` and `F`. 0 = never. Item 1375 is why this knob exists: a
 * fixture where every edge carries both labels cannot tell a walk that deduped nothing from one
 * that deduped everything, and a fixture where none do never reaches the deduping path at all.
 */
const MULTILABEL = Number(process.env.MULTILABEL ?? 0);
/**
 * ⚠️ `MULTILABEL=-1` IS DISJOINT: every other edge carries `F` INSTEAD of `E`, so both buckets are
 * non-empty and NO edge is in two of them (item 1413).
 *
 * This knob could not express that before, and the gap invalidated a measurement. `0` means "no `F`
 * at all", so a two-label hop at `MULTILABEL=0` walks an `E` bucket and an EMPTY `F` bucket — which
 * cannot show the cost of anything that happens in the second bucket. Item 1413 priced the
 * earlier-buckets dedupe against exactly that fixture and measured 5.5% with a control moving 4.8%,
 * because in both arms the dedupe loop never executed at all.
 *
 * The GQL twin got this at item 1405 for the same reason and with the same spelling (`-1` rather
 * than `0`, because `0` already means something the controls at items 1375 and 1390 rely on). Two
 * benches, one missing fixture shape, found twice — the second time after it had already cost a
 * reading.
 */
const edgeLabels = (k) => {
  if (MULTILABEL === -1) {
    return k % 2 === 0 ? ['E'] : ['F'];
  }

  return MULTILABEL > 0 && k % MULTILABEL === 0 ? ['E', 'F'] : ['E'];
};
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
      to: vs[(k * 104_729) % FAR_POOL],
      labels: edgeLabels(k),
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

/**
 * ⚠️ WINDOWED, so a profile of this bench is of the TRAVERSAL and not of the fixture build (1392).
 *
 * The GQL twin got this at item 1391 and this one did not, which matters retroactively: item 1389's
 * nomination — `iterLabeled` 20.3% + `iterByLabel` 7.9% + `outEdgesOf` 4.9% = 33.1% — was read off an
 * UNWINDOWED profile, so the load was in the denominator. It was directionally right (the change
 * delivered 25.1%) but the number was not the one it claimed to be. Set `PROF_OUT` and the profile
 * covers only the rep loop; leave it unset and `profileWindow` just runs the body.
 */
const measure = () => {
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = toArray(plan, g);
    const dt = performance.now() - t0;

    series.push(dt);
    sink += Array.isArray(rows) ? rows.length : 1;
    answer = Array.isArray(rows) ? rows[0] : rows;
  }

  return sink;
};

await profileWindow(process.env.PROF_OUT, measure);

// ⚠️ DRAIN before reading: `PerformanceObserver` delivers in a queued callback, so a synchronous
// loop buffers every entry and reports 0 pauses (item 1361's fifth instrument defect).
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

obs.disconnect();

if (sink === 0) {
  throw new Error(`${SHAPE} produced NOTHING across ${REPS} reps — measuring nothing`);
}

/**
 * ⚠️ AND THE GUARD ABOVE DOES NOT CATCH A ZERO COUNT (item 1416).
 *
 * `sink` adds `rows.length` for an array but `1` for a scalar, so a `count()` that answers **0**
 * increments it and sails past — the row ran, found nothing, and reported a time for a dead path.
 * The GQL twin was ranked that way for a whole tick before anyone read the answer: `MULTILABEL=-1`
 * halves the `E` edges, so multi-hop chains answer 0 at out-degree 1, and `chain3` read 21.5 ms
 * dead against 47.1 ms live.
 *
 * A zero count is a legitimate answer for some fixtures, so this FLAGS rather than throws — the
 * `sink === 0` guard above is the one that can be certain.
 */
const zeroAnswer = answer === 0 || (Array.isArray(answer) && answer.length === 0);

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    fanout: FANOUT,
    fanin: FANIN,
    reps: REPS,
    answer: typeof answer === 'object' ? JSON.stringify(answer) : answer,
    ...(zeroAnswer ? { VACUOUS_ZERO_ANSWER: true } : {}),
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
