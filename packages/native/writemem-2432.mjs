/**
 * WHAT DOES A WRITE COST IN MEMORY, and how much of it is GARBAGE rather than stored data?
 *
 * ## THE GAP THIS FILLS
 *
 * Items 2416-2425 built five memory instruments — churn, retained bytes, GC share, peak live, the
 * minimum-heap bisection, and the wasm high-water — and **every one of them measures a READ.** The
 * only write figure anywhere in the repo is `alloc:wasm`'s LOAD row (27-37 MiB for 20,000-50,000
 * nodes), which is a bulk ingest and tells you nothing about a single `addVertex`.
 *
 * That is the wrong way round for this engine. `bench:usage` exists because serving is interleaved
 * reads and writes, and the write path is where the repo's sharpest recorded cliffs live:
 *
 *   - item 680: `rebuild_csr` runs only at LOAD and every adjacency write clears `csr_fresh` with
 *     NOTHING to re-arm it, so ONE `addEdge` demotes EVERY later read for the rest of the session —
 *     1.96x at one edge in two carrying the queried type, **24.07x at one in fifty**;
 *   - [[ts-set-is-o-width]]: a TS `SET` makes three O(K) passes per write against native's O(1)
 *     columnar store;
 *   - [[write-cost-deferred-checks]]: native `SET` was O(row width) from commit-time constraint
 *     recheck.
 *
 * None of those were found by a memory instrument, because there wasn't one.
 *
 * ## TWO QUANTITIES, AND FOR A WRITE THEIR RATIO IS THE INTERESTING ONE
 *
 * A read's churn is nearly all garbage. A write's churn is partly the stored structure — which is
 * SUPPOSED to persist — so the useful figure is how much transient garbage a write makes per byte it
 * actually keeps:
 *
 *     retained / op   the data structure's own cost. Irreducible, and the thing you pay to store.
 *     churn / op      every byte allocated, kept or not.
 *     churn/retained  the WASTE RATIO. 1.0 means every allocated byte was kept; 5.0 means four
 *                     fifths of the work was thrown away.
 *
 * Both come from item 2416's calibrated accounting (`v8.GCProfiler` summed across the collections in
 * the window), which is the only churn mechanism here that calibrated: a `heapUsed` delta cannot
 * work because `new_space` starts at 1 MiB and V8 grows it adaptively.
 *
 * ## THE TRAP THIS PROBE IS SHAPED BY
 *
 * [[graph-pinned-until-microtask-drain]]: a discarded `Graph` is retained IN FULL by its pending
 * `drainMutations` microtask, because its first write schedules `setTimeout(this.notify, 1)` and a
 * pending timer holds the closure that holds the Graph. A synchronous build-and-discard loop
 * therefore retains every graph it ever made — measured at 148 / 614 / 1242 MiB over 10 / 45 / 90
 * reps, with a 256 MiB cap OOM-crashing. **So this probe awaits a MACROTASK between phases**, and
 * without that every phase after the first would report the previous phases' graphs as its own
 * retained bytes.
 *
 *     node --expose-gc writemem-2432.mjs                 # calibrate, then every phase
 *     PHASE=addEdge node --expose-gc writemem-2432.mjs   # one phase per process
 *     OPS=100000 node --expose-gc writemem-2432.mjs
 */
import v8 from 'node:v8';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const OPS = Number(process.env.OPS ?? 50_000);
/**
 * How many properties a vertex already carries when `setProp` writes one more.
 *
 * [[ts-set-is-o-width]] records that a TS `SET` makes THREE O(K) passes per write against native's
 * O(1) columnar store, so the waste ratio should grow with K — and at the default K=1 the three
 * passes are over one key, which is the cheapest the shape can look. Sweeping this is what decides
 * whether `setProp`'s ratio is a TARGET or a constant factor.
 */
const PROPS = Number(process.env.PROPS ?? 1);
const PHASE = process.env.PHASE ?? 'all';
const MIB = 1024 * 1024;

const SINK = new Array(1024).fill(null);

/** The calibration's allocation site: escapes (really allocated) and is overwritten (really garbage). */
const burn = (count) => {
  for (let i = 0; i < count; i += 1) {
    SINK[i & 1023] = { a: i, b: i + 1, c: `s${i & 1023}`, d: null };
  }

  return SINK.length;
};

/**
 * Bytes allocated inside `fn`, accounted ACROSS the collections rather than around them, plus what
 * is still there afterwards. Item 2416's mechanism, which is the one that calibrated.
 */
const measure = async (fn) => {
  if (typeof global.gc !== 'function') {
    throw new Error('this probe needs --expose-gc: without a settled baseline the delta is noise');
  }

  /*
   * YIELD BEFORE THE BASELINE, NOT JUST AFTER. A graph built in a previous phase is retained by its
   * pending drain microtask until the host yields, so a baseline taken without this reads the
   * PREVIOUS phase's graph as part of this phase's starting heap — and then its retained figure
   * comes out negative when the drain finally runs.
   */
  await new Promise((r) => setTimeout(r, 0));
  global.gc();

  const profiler = new v8.GCProfiler();

  profiler.start();

  const before = process.memoryUsage().heapUsed;
  const out = fn();
  const end = process.memoryUsage().heapUsed;
  const stats = profiler.stop().statistics ?? [];

  let churn = 0;
  let prevAfter = before;

  for (const ev of stats) {
    const b = ev.beforeGC?.heapStatistics?.usedHeapSize;
    const a = ev.afterGC?.heapStatistics?.usedHeapSize;

    if (typeof b !== 'number' || typeof a !== 'number') {
      continue;
    }

    churn += Math.max(0, b - prevAfter);
    prevAfter = a;
  }

  churn += Math.max(0, end - prevAfter);

  // The RETAINED figure must be taken after a collection, or it is just the end-of-window heap.
  global.gc();

  return { out, churn, retained: process.memoryUsage().heapUsed - before, gc: stats.length };
};

/** A one-hop aggregate — the shape items 2421/2423 moved onto the CSR-cached level pass. */
const AGG = 'MATCH (a:P)-[:E]->(x:P) RETURN sum(x.k) AS s';

/** The graph the CSR arms read, built OUTSIDE every measured window. */
const buildGraph = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < OPS; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let e = 0; e < OPS; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3) % OPS],
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/** NDJSON for the bulk arm, built OUTSIDE the measured window — the text is not the write's cost. */
const ndjson = (n) => {
  const lines = [];

  for (let i = 0; i < n; i += 1) {
    lines.push(
      JSON.stringify({ type: 'node', id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }),
    );
  }

  for (let e = 0; e < n; e += 1) {
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${e}`,
        from: `v${e}`,
        to: `v${(e * 7 + 3) % n}`,
        labels: ['E'],
        properties: {},
      }),
    );
  }

  return `${lines.join('\n')}\n`;
};

/**
 * Each phase returns something non-trivial so a phase that silently did nothing cannot read as free.
 * The vertices are built outside the window for the arms that are not about vertex creation.
 *
 * ## EVERY PHASE MUST KEEP ITS GRAPH REACHABLE PAST THE WINDOW, and the first version did not
 *
 * `retained` is measured after a forced collection, so it only sees what is still REFERENCED. The
 * first `bulkLoad` arm created its graph INSIDE the measured closure and returned a row count, so
 * the graph was unreachable the moment the closure returned and the collection took it: the arm
 * reported **0.09 MiB retained and a waste ratio of 2151.93x** for a 100,000-element graph, against
 * `addVertex`'s 29.42 MiB for half as much data. The absurd ratio is what gave it away.
 *
 * `addVertex` and `addEdge` were right by accident — they happen to create `g` outside the closure.
 * `KEEP` makes it deliberate for all of them, so every arm's retained figure is of the same thing.
 */
let KEEP;
const PHASES = {
  addVertex: () => {
    const g = new Graph();

    KEEP = g;

    return measure(() => {
      for (let i = 0; i < OPS; i += 1) {
        g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
      }

      return g.vertexCount;
    });
  },
  addEdge: () => {
    const g = new Graph();

    KEEP = g;

    const vs = [];

    for (let i = 0; i < OPS; i += 1) {
      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
    }

    return measure(() => {
      for (let e = 0; e < OPS; e += 1) {
        g.addEdge({
          id: `e${e}`,
          from: vs[e],
          to: vs[(e * 7 + 3) % OPS],
          labels: ['E'],
          properties: {},
        });
      }

      return g.edgeCount;
    });
  },
  // A property WRITE on an existing vertex — [[ts-set-is-o-width]]'s shape, through the public API.
  setProp: () => {
    const g = new Graph();

    KEEP = g;

    const vs = [];

    for (let i = 0; i < OPS; i += 1) {
      const props = { k: i % 97 };

      for (let p = 1; p < PROPS; p += 1) {
        props[`p${p}`] = i + p;
      }

      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: props }));
    }

    return measure(() => {
      let n = 0;

      for (let i = 0; i < OPS; i += 1) {
        vs[i].setProperty('w', i % 13);
        n += 1;
      }

      return n;
    });
  },
  /*
   * THE CSR INVALIDATION, and it is a check on items 2421/2423 rather than a general probe.
   *
   * `csrFor` is called by `levelWalk` in `chain-fold-levels.ts` — the path items 2421 and 2423 moved
   * the one-hop aggregates and `RETURN DISTINCT` onto. So those shapes now read a cache keyed on
   * `graph.topologyVersion`, and ANY adjacency write bumps it: the next read pays an O(|V|+|E|)
   * rebuild. That is the TS analogue of item 680's `csr_fresh` demotion, and moving the commonest
   * aggregate shapes onto it is something I did three items ago without measuring the write side.
   *
   * `readWarm` measures a second read with the cache hot. `readAfterWrite` measures the read that
   * follows ONE `addEdge`. The difference is the rebuild.
   *
   * `topologyVersion` is the RIGHT key, checked rather than assumed: `core/topology-version.test.ts`
   * exists to assert it advances SYNCHRONOUSLY where `version` and `epoch` are deferred to the
   * microtask drain — so this cache is not [[graph-counters-are-async]]'s hazard.
   */
  readWarm: () => {
    const g = buildGraph();

    KEEP = g;
    // Warm the CSR, twice, so the measured read is unambiguously a cache HIT.
    query(g, AGG, {});
    query(g, AGG, {});

    return measure(() => query(g, AGG, {})[0].s);
  },
  readAfterWrite: () => {
    const g = buildGraph();

    KEEP = g;
    query(g, AGG, {});
    query(g, AGG, {});

    // ONE edge — item 680's shape. The cache is keyed on topology, so one write voids every shape.
    const vs = g.verticesById === undefined ? [] : [...g.verticesById.values()];

    g.addEdge({
      id: 'extra',
      from: vs[0],
      to: vs[1],
      labels: ['E'],
      properties: {},
    });

    return measure(() => query(g, AGG, {})[0].s);
  },
  // The BULK arm, for scale: the only write figure that existed before this probe was a bulk load.
  bulkLoad: () => {
    const text = ndjson(OPS);

    return measure(() => {
      KEEP = deserialize(text, 'ndjson', new Graph());

      return KEEP.vertexCount + KEEP.edgeCount;
    });
  },
};

const show = (name, r, ops) => {
  const waste = r.retained > 0 ? r.churn / r.retained : Number.NaN;

  console.log(
    `  ${name.padEnd(10)} churn ${(r.churn / MIB).toFixed(2).padStart(8)} MiB  ` +
      `retained ${(r.retained / MIB).toFixed(2).padStart(8)} MiB  ` +
      `${(r.churn / ops).toFixed(0).padStart(5)} B/op churn  ` +
      `${(r.retained / ops).toFixed(0).padStart(5)} B/op kept  ` +
      `waste ${Number.isNaN(waste) ? 'n/a' : `${waste.toFixed(2)}x`}  ` +
      `out ${String(r.out)}  across ${String(r.gc)} collections`,
  );
};

if (PHASE === 'all' || PHASE === 'cal') {
  console.log('# CALIBRATION  LINEARITY of the churn meter, 1x and 4x the same escaping garbage');
  console.log(
    '#   B/op must be FLAT; item 2416 measured 80.1-81.6 for this object over a 16x range',
  );

  for (const mult of [1, 4]) {
    const n = 65_536 * mult;
    const r = await measure(() => burn(n));

    console.log(
      `  ${String(mult)}x  churn ${(r.churn / MIB).toFixed(2).padStart(7)} MiB  ` +
        `${(r.churn / n).toFixed(1)} B/object  across ${String(r.gc)} collections`,
    );
  }
}

if (PHASE !== 'cal') {
  const names = PHASE === 'all' ? Object.keys(PHASES) : [PHASE];

  console.log(
    `\n# WRITE-PATH memory, OPS=${String(OPS)} PROPS=${String(PROPS)} (churn and retained per operation)`,
  );

  for (const name of names) {
    const phase = PHASES[name];

    if (phase === undefined) {
      throw new Error(`unknown PHASE ${name}; have ${Object.keys(PHASES).join('|')}|cal`);
    }

    // `bulkLoad` performs 2*OPS operations (a node and an edge each), so its per-op divisor differs.
    show(name, await phase(), name === 'bulkLoad' ? OPS * 2 : OPS);
  }

  console.log(
    '#   waste = churn/retained: 1.0 means every allocated byte was KEPT, 5.0 means four fifths of\n' +
      '#   the work was thrown away. For a write, retained is the structure you are paying to store.',
  );
}
