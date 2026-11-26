/*
 * Item 2045 — WHICH OF PARSE, PLAN OR OPTIMIZE IS THE 1.8 ms?
 *
 * Item 2044 measured parse+plan at **1.715-1.890 ms** for one realistic query, and **82-83% of that
 * query's first execution** — by running the same text twice on a warm engine and differencing. This
 * splits that figure by frame.
 *
 * **THE TEXTS ARE STRUCTURALLY IDENTICAL AND TEXTUALLY DISTINCT**, which is what makes the profile
 * readable: every call MISSES the parse/plan cache (it is keyed on the text) while the plan it
 * produces, and therefore the execution, is the same work every time. Only the alias changes. If the
 * texts differed structurally, execution would vary with them and the profile would mix the two.
 *
 * A TINY GRAPH ON PURPOSE (100 vertices), so execution is as close to zero as it can be — item
 * 2044's decomposition put it at ~0.4 ms against parse+plan's 1.8. PROBES.md's warning applies in
 * reverse here: a big fixture would bury the question under its own build.
 *
 * AND THE ENGINE IS WARMED FIRST, because a cold process spends ~5 ms in JIT (item 2044) and that
 * would dominate every frame. The warm-up uses a text NOT in the measured set.
 *
 *     bun parseplan-prof-2045.mjs
 *     node --cpu-prof --cpu-prof-dir=<dir> parseplan-prof-2045.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 2000);

const g = new Graph();

for (let i = 0; i < 100; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 7, s: `s${i % 5}` } });
}

/** One shape, N distinct spellings — only the RETURN alias differs. */
const texts = Array.from(
  { length: N },
  (_, i) =>
    `MATCH (n:P) WHERE n.k >= 0 AND n.k < 99 RETURN n.k AS a${i}, count(*) AS c${i} ORDER BY a${i} DESC LIMIT 5`,
);

/*
 * **WARM=0 IS THE POINT OF THIS KNOB.** 2000 distinct cache-missing texts cost **0.07-0.09 ms
 * each**, where item 2044 measured ONE cache-missing text at 2.2 ms — a 25x gap. If that gap is JIT
 * on the parser/planner rather than the parsing itself, the FIRST query of a cold run will be ~1.8 ms
 * and the curve will fall to ~0.05 within a few hundred. That is testable, and it decides whether
 * item 2044's "parse+plan is 1.8 ms" describes the WORK or the WARM-UP.
 */
const WARM = Number(process.env.WARM ?? 50);

for (let w = 0; w < WARM; w += 1) {
  query(g, 'MATCH (n:P) WHERE n.k >= 0 RETURN n.s AS warm ORDER BY warm LIMIT 3');
}

const t0 = performance.now();
let rows = 0;
const each = [];

for (const text of texts) {
  const q0 = performance.now();

  rows += query(g, text).length;
  each.push(performance.now() - q0);
}

const ms = performance.now() - t0;

/*
 * The CURVE, not a summary: the first few calls and a late window. A mean or a min over the whole run
 * would hide exactly the warm-up this probe exists to expose (CLAUDE.md's estimator note).
 */
const window = (from, to) => {
  const slice = each.slice(from, to).sort((x, y) => x - y);

  return +slice[Math.floor(slice.length / 2)].toFixed(3);
};

/*
 * THE ANSWER IS ASSERTED: every text asks for 5 rows, so a route that answered differently would
 * make the timing meaningless. Item 2030's rule, applied to a probe whose output is a profile.
 */
if (rows !== N * 5) {
  throw new Error(`got ${rows} rows across ${N} queries, expected ${N * 5}`);
}

console.log(
  JSON.stringify({
    warm: WARM,
    queries: N,
    perQuery: +(ms / N).toFixed(3),
    first: +each[0].toFixed(3),
    second: +each[1].toFixed(3),
    median_1_10: window(0, 10),
    median_10_50: window(10, 50),
    median_50_200: window(50, 200),
    median_last_500: window(N - 500, N),
  }),
);
