/**
 * DOES A WORKLOAD OF MORE DISTINCT QUERY TEXTS THAN THE PARSE CACHE HOLDS COST MORE PER QUERY?
 * (item 1840)
 *
 * ONE CONFIGURATION PER PROCESS, AND ITEM 1839 IS WHY. That item tried the same question with
 * every configuration in one process and got a **12x spread on the SAME configuration** across
 * three rounds (22.4 / 2.4 / 1.8 us a query), each round faster than the last because the JIT was
 * still tiering up. Configurations sharing a moving JIT state cannot be compared — item 762's
 * one-shape-per-process rule, arriving from the compile side instead of the dispatch side.
 *
 * AND SUBTRACTION CANNOT ANSWER IT EITHER (item 1839's other failure): a cold/warm delta of
 * 244 ms sat inside a warm/warm noise band of ±180 ms. This measures ONE number — microseconds per
 * query at a given diversity — and the comparison is between PROCESSES.
 *
 * THE SHAPE UNDER TEST is deliberately trivial (`MATCH (n:T) RETURN n.n AS a<i>`) on a tiny graph:
 * the texts must differ STRUCTURALLY, because auto-parameterization (item 1502) collapses texts
 * that differ only in a literal to one cached template — item 1839 confirmed that, 130 such texts
 * giving a cache `size` of 1. Differing aliases cannot be lifted, so each text is genuinely its
 * own entry. Execution is kept near-zero so what is left is compile and cache behaviour.
 *
 *     TEXTS=64 bun text-diversity-bench.mjs
 *     TEXTS=256 REPS=14 DROP=3 bun text-diversity-bench.mjs
 *
 * Output is one JSON line per run, so a driver can compare processes without scraping.
 */
import { Graph } from '@lenke/core';
import { parseCacheStats, query } from '@lenke/gql';

const TEXTS = Number(process.env.TEXTS ?? 64);
const NODES = Number(process.env.NODES ?? 200);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8, s: `s${i % 3}` } });
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3) % NODES) + 1)),
    labels: ['E'],
  });
}

const texts = Array.from({ length: TEXTS }, (_, i) => `MATCH (n:T) RETURN n.n AS a${i}`);

/**
 * WARM-UP ON TEXTS THIS RUN NEVER MEASURES, so the JIT is tiered up before the first timed rep
 * WITHOUT seeding the cache with the texts under test. Warming on the measured texts would hand
 * the large-N configurations a cache state they would never have in the workload being modelled.
 */
// Built OUTSIDE the call rather than suppressed. `lenke/no-raw-interpolation` fires on an
// interpolation spliced into `query()` directly, and it is right to: the fix here is to name the
// texts first, exactly as the measured list below does. (A `$param` is NOT the fix for this bench —
// auto-parameterization would lift it and collapse the texts into one, which is the case the bench
// exists to avoid.)
const warmTexts = Array.from({ length: 64 }, (_, i) => `MATCH (n:T) RETURN n.n AS warm${i}`);

for (let w = 0; w < 3; w += 1) {
  for (const t of warmTexts) {
    query(g, t);
  }
}

const series = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  for (const t of texts) {
    rows += query(g, t).length;
  }

  series.push(((performance.now() - t0) * 1000) / texts.length);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const median =
  kept.length % 2 === 1
    ? kept[kept.length >> 1]
    : (kept[(kept.length >> 1) - 1] + kept[kept.length >> 1]) / 2;

// The row count is the answer guard: every text returns NODES rows, so a configuration that
// silently answered differently is not comparable however fast it was.
if (rows !== NODES * TEXTS * REPS) {
  throw new Error(`returned ${rows} rows, expected ${NODES * TEXTS * REPS} — not comparable`);
}

console.log(
  JSON.stringify({
    texts: TEXTS,
    nodes: NODES,
    reps: REPS,
    drop: DROP,
    usPerQuery: Number(median.toFixed(2)),
    p25: Number(kept[Math.floor(kept.length * 0.25)].toFixed(2)),
    p75: Number(kept[Math.floor(kept.length * 0.75)].toFixed(2)),
    min: Number(kept[0].toFixed(2)),
    max: Number(kept[kept.length - 1].toFixed(2)),
    cache: parseCacheStats(),
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
