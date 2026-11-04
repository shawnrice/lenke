/**
 * ONE query row, measured well enough to see a sub-10% change. The isolated harness CLAUDE.md asks
 * for, built because item 1366 established that the existing probe cannot answer the questions left.
 *
 * WHY THE EXISTING PROBE IS TOO NOISY. `runtime-profile-probe.mjs` times the WHOLE rep loop and
 * reports the total, so a single GC pause anywhere in 120 reps lands in the number. Item 1366
 * measured its floor on the 200k hop-filter row at **12% for the same binary** (452.2 / 506.2 /
 * 490.2 / 494.4), which is above most of the candidates worth testing — it refuted `FAST1` only in
 * the sense of "not large".
 *
 * WHAT THIS DOES DIFFERENTLY, all of it straight out of CLAUDE.md's estimator rules:
 *
 *   * **Per-rep timing, not a loop total.** One slow rep is then one sample, not the whole reading.
 *   * **Median of the kept reps, with warmup dropped.** The TS path plateaus high and emits a rare
 *     fast rep, so `min` is the wrong estimator and reports the outlier; some shapes are outright
 *     bimodal. 14 reps, drop 3, median is the documented recipe.
 *   * **Prints the whole distribution** — series, p25, median, p75, min, max — because a summary of a
 *     bimodal series is a lie and the series is the only way to see it.
 *   * **Reports GC inside the measured window** via `PerformanceObserver`, so a reading inflated by
 *     collection is visible as such instead of being mysterious. Item 1361 is why: the observer must
 *     be DRAINED before reading, or a synchronous loop reports zero pauses.
 *   * **One shape per process** (item 762), and the fixture is deterministic so every process builds
 *     byte-identical input.
 *
 *     SHAPE=hopfilter NODES=200000 REPS=14 DROP=3 node isolated-row-bench.mjs
 *
 * Output is one JSON line, so an A/B driver can parse it without scraping a table.
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SHAPE = process.env.SHAPE ?? 'hopfilter';
const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
/**
 * How often an edge carries BOTH `E` and `F`. 0 = never, so `graph.multiTypeEdgeCount` is 0 and
 * `bucketSumsAreSound` should license the degree-sum fast path for `:E|F` as well as `:E`.
 * 3 = every third edge, so the sums would double-count and the dedupe is genuinely required.
 */
const MULTILABEL = Number(process.env.MULTILABEL ?? 3);

const SHAPES = {
  hopfilter: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
  // AN EQUIVALENT-SPELLING PAIR (item 1375). A third of the edges carry BOTH `E` and `F`, and every
  // edge carries `E`, so these two count the SAME edges — but `:E` takes `edgesOfTypes`' single-bucket
  // fast path (item 324, which returns the Set and allocates nothing) while `:E|F` falls to
  // `edgesOfManyTypes`, which allocates a `types.map` array AND a dedupe Set per vertex. CLAUDE.md's
  // rule is that equivalent spellings must cost the same; this is the instrument for that claim on a
  // multi-type hop, which no bench row covered.
  hopsingle: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  hopmulti: 'MATCH (a:P)-[:E|F]->(b:P) RETURN count(*) AS c',
  // THE ORDER-REVERSED TWIN (item 1384). `edgesOfManyTypes` iterates bucket `i` with `i` membership
  // tests, so the total is minimised by putting the LARGEST bucket first — which means it is
  // sensitive to the order the query names types, exactly as the Gremlin twin was at item 1382
  // (3.53x there). Unlike that one, this runs PER VERTEX over a single vertex's buckets, so the
  // per-call disparity is a degree rather than a whole index and may not be measurable at all.
  hopmultirev: 'MATCH (a:P)-[:F|E]->(b:P) RETURN count(*) AS c',
  hopcount: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  sortedpage: 'MATCH (n:P) WHERE n.k < 50 RETURN n.s AS s ORDER BY s LIMIT 10',
  grouped: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  point: 'MATCH (n:P) WHERE n.n = 12345 RETURN n.s AS s',
  scan: 'MATCH (n:P) RETURN count(*) AS c',
};

const q = SHAPES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

/** Deterministic, so every process in an A/B builds byte-identical input. */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3) % NODES}`),
      // A THIRD carry both types, so `:E` and `:E|F` select the identical edge set and the
      // multi-bucket path actually has something to DEDUPE — without the overlap it would be a
      // concatenation and would not exercise the `Set` the dedupe allocates.
      labels: MULTILABEL > 0 && i % MULTILABEL === 0 ? ['E', 'F'] : ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

const g = build();

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
  const rows = query(g, q);
  const dt = performance.now() - t0;

  series.push(dt);
  sink += rows.length;
  [answer] = rows;
}

// ⚠️ DRAIN before reading: `PerformanceObserver` delivers in a queued callback, so a synchronous
// loop buffers every entry and reports 0 pauses (item 1361's fifth instrument defect).
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

obs.disconnect();

if (sink === 0) {
  throw new Error(`${SHAPE} produced NO rows across ${REPS} reps — measuring nothing`);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    reps: REPS,
    drop: DROP,
    answer,
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
