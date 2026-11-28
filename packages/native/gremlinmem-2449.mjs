/*
 * THE GREMLIN SURFACE'S FIRST MEMORY INSTRUMENT (item 2449).
 *
 * Items 2416-2448 built churn, retained bytes, GC share, total allocation counts, peak live, a
 * minimum-heap bisection, the wasm high-water, write-path waste and a fan-in sweep. **Every one of
 * them measures GQL.** `bench:gremlin` and `spelling:gremlin` exist but are TIME only, and the only
 * Gremlin allocation numbers anywhere are Rust-side (`alloc_count_probe`'s `gremlin::lex` /
 * `gremlin::parse` cases). The TS Gremlin EXECUTOR — a separate implementation with its own steps
 * and generator chain — has never had a byte measured.
 *
 * WHY MEMORY AND NOT MORE TIME: [[gremlin-values-is-the-floor]] records that on this surface "the
 * reduce is free; the cost is the generator chain", and a generator chain is exactly the structure
 * whose cost is allocation rather than arithmetic — one frame and one `{value, done}` per element
 * per step. Time has been measured and partly taken (fused at item 1586 for 1.90x). Bytes have not.
 *
 * CHURN ACCOUNTING, the same mechanism item 2416 calibrated:
 *
 *   churn = SUM over GC cycles of (usedBefore_i - usedAfter_{i-1}) + (usedEnd - usedAfter_n)
 *
 * A plain `heapUsed` delta cannot work — `new_space` starts at 1 MiB and grows adaptively, so a
 * workload that allocates less than one nursery shows ZERO. `v8.GCProfiler` gives the per-cycle
 * before/after pairs this needs.
 *
 * CALIBRATION IS NOT OPTIONAL. Seven instruments in this stretch were caught lying before any
 * engine number was read from them, two of them mine (item 2432's harness reported a 2151.93x waste
 * ratio by measuring an unreachable graph; item 2447's sweep reported a 2.5x band that was a warm-up
 * transient). `MECH=cal` allocates a KNOWN number of KNOWN-size objects and prints bytes/object: a
 * plain `{a,b,c}` is ~80 bytes in V8, and item 2416 measured this same meter at 80.1-81.6 B. If the
 * calibration row is not in that band, no Gremlin number below it means anything.
 */
import { GCProfiler } from 'node:v8';

import { Graph } from '@lenke/core';
import { E, V, count, dedupe, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.GM_N ?? 200000);
const REPS = Number(process.env.GM_REPS ?? 7);
const MECH = process.env.MECH ?? 'churn';
const SHAPE = process.env.GM_SHAPE ?? 'all';

/** Kept so nothing under measurement is collected mid-window ([[graph-pinned-until-microtask-drain]]). */
const KEEP = { graph: undefined, sink: undefined };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[s.length >> 1];
};

/**
 * Bytes allocated during `fn`, from the GC profiler's per-cycle pairs.
 *
 * `global.gc()` runs before the window so the nursery starts in a known state, and that forced
 * collection is NOT inside the measured region — item 2416 found a forced collection contributing
 * 112.5 ms of pause to a ~75 ms window when it was.
 */
const churnOf = (fn) => {
  global.gc();

  const p = new GCProfiler();

  p.start();

  const before = process.memoryUsage().heapUsed;

  fn();

  const after = process.memoryUsage().heapUsed;
  const { statistics } = p.stop();

  let total = 0;
  let prevAfter = before;

  for (const s of statistics) {
    total += Math.max(0, s.beforeGC.heapStatistics.usedHeapSize - prevAfter);
    prevAfter = s.afterGC.heapStatistics.usedHeapSize;
  }

  total += Math.max(0, after - prevAfter);

  return { bytes: total, cycles: statistics.length };
};

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  for (let e = 0; e < N; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3) % N],
      labels: ['E'],
      properties: { w: e % 13 },
    });
  }

  KEEP.graph = g;

  return g;
};

/*
 * THE SHAPES, chosen to be the Gremlin twins of rows already priced on the GQL side so the two
 * surfaces are comparable rather than merely both measured.
 *
 *   vcount    `g.V().count()`              a closed form on both surfaces; the CONTROL that should
 *                                          allocate almost nothing regardless of N.
 *   vvalues   `g.V().values('k')`          the scan-rooted projection. [[gremlin-values-is-the-floor]]
 *                                          fused this at item 1586; its BYTES are unmeasured.
 *   outvalues `g.V().out().values('k')`    the one-hop twin of `MATCH (a:P)-[:E]->(x:P) RETURN x.k`,
 *                                          which items 2439/2443 priced in detail on the GQL side.
 *   evalues   `g.E().values('w')`          the edge-rooted projection (item 2321's shortcut).
 *   dedup     `g.V().out().dedupe()`       [[element-dedup-identity-vs-key]]: Gremlin keeps NO dedup
 *                                          set at all on a far-driven walk, which is a claim about
 *                                          ALLOCATION that was never measured in bytes.
 *   labelled  `g.V().hasLabel('P').count()` a filtered closed form.
 */
const SHAPES = {
  vcount: () => traversal(V(), count()),
  vvalues: () => traversal(V(), values('k')),
  outvalues: () => traversal(V(), out(), values('k')),
  evalues: () => traversal(E(), values('w')),
  dedup: () => traversal(V(), out(), dedupe()),
  labelled: () => traversal(V(), hasLabel('P'), count()),
};

if (MECH === 'cal') {
  /*
   * A KNOWN quantity: `REPS * 100_000` objects of a shape whose V8 size is known (~80 B for a
   * three-field object with small-integer fields). The sink is module-level because ESCAPE ANALYSIS
   * deleted an earlier calibration's garbage outright — item 2416 watched bytes/object fall from
   * 51.3 to 29.7 when the objects could not escape.
   */
  const COUNT = 100_000;
  const per = [];

  for (let r = 0; r < REPS; r += 1) {
    const { bytes } = churnOf(() => {
      const sink = [];

      for (let i = 0; i < COUNT; i += 1) {
        sink.push({ a: i, b: i + 1, c: i + 2 });
      }

      KEEP.sink = sink;
    });

    per.push(bytes / COUNT);
  }

  const b = median(per);

  const verdict =
    b >= 70 && b <= 95
      ? 'PLAUSIBLE (item 2416 measured 80.1-81.6 for this object)'
      : 'OUT OF BAND — do not trust any number below this line';

  console.log(`  cal      ${String(COUNT)} x {a,b,c}   ${b.toFixed(1)} B/object  ${verdict}`);
} else {
  const g = build();
  const names = SHAPE === 'all' ? Object.keys(SHAPES) : [SHAPE];

  for (const name of names) {
    const make = SHAPES[name];

    if (make === undefined) {
      throw new Error(
        `unknown GM_SHAPE=${name}; expected ${Object.keys(SHAPES).join(', ')} or all`,
      );
    }

    const plan = make();

    // Warm: these routes tier up, and item 2447 cost an item by medianing inside the transient.
    for (let i = 0; i < 3; i += 1) {
      toArray(plan, g);
    }

    const rows = toArray(plan, g).length;
    const per = [];
    const cyc = [];

    for (let r = 0; r < REPS; r += 1) {
      const { bytes, cycles } = churnOf(() => {
        KEEP.sink = toArray(plan, g);
      });

      per.push(bytes);
      cyc.push(cycles);
    }

    const b = median(per);

    console.log(
      `  ${name.padEnd(9)} N=${N} rows=${String(rows).padEnd(7)} churn ${(b / 1024 / 1024).toFixed(2).padStart(7)} MiB` +
        `  ${(b / Math.max(1, rows)).toFixed(1).padStart(7)} B/row   ${median(cyc)} GC cycles`,
    );
  }
}
