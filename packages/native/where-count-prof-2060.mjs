/*
 * Item 2060 — WHY DOES `where(hop).values(n).count()` COST MORE THAN `where(hop).values(n)`?
 *
 * The workload screen, one row per process, 200,000 vertices, three rounds:
 *
 *     where: sub-traversal         16.37 ms   emits 200,000 rows
 *     where: sub-traversal count   18.99 ms   emits 1 row          <- 1.16x, and it should be LESS
 *
 * 🔑 **THE SIGN IS THE FINDING, NOT THE RATIO.** Counting cannot legitimately cost more than
 * counting AND materializing every value, so something on the count path is doing work the plain
 * path does not — and `index.ts` rewrites `values(k) … count()` into `hasKey(k) … count()` precisely
 * to AVOID materializing, which should make it strictly cheaper.
 *
 * ⚠️ THE SCREEN ROW FOR THIS DID NOT EXIST until this item added it. Item 2026 priced a trailing
 * `count()` on this prefix at "~1.6x available" from a census plus arithmetic, with no row to measure
 * it — and the census still shows the shape GENERIC, which reads like an unclaimed 1.6x.
 *
 * ⚠️ ONE SHAPE, ONE PROCESS (item 1874 retracted a 1.73x that was a within-process cross-row ratio),
 * and `ARM=count|plain` picks which. The fixture share is printed because item 1875 took two profiles
 * that were 76% and 40% FIXTURE — a profile whose top frames are the closed write frames in
 * `PROBES.md` has measured the fixture, not the query.
 *
 *     ARM=count REPS=10 node --cpu-prof where-count-prof-2060.mjs
 */
import { Graph } from '@lenke/core';
import { V, count, out, toArray, traversal, values, where } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 8);

// Item 1881's own domain, so the predicate selects the fraction it selected on the screen.
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const W_POOL = [1, 2, 3, 4, 5, 7, 9];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50, s: `s${i % 7}` },
  });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    // ⚠️ THE REPEAT INDEX IS IN THE EXPRESSION — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy,
    // which is invariant under `k -> k + N` and silently makes the graph FUNCTIONAL.
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: W_POOL[e % W_POOL.length] },
  });
}

/** The topology assertion: a FUNCTIONAL fixture answers correctly while measuring nothing. */
{
  const seen = new Set();

  for (let hop = 0; hop < FANOUT; hop += 1) {
    seen.add((3 + hop * 2_654_435_761) % N);
  }

  if (FANOUT > 1 && seen.size < 2) {
    throw new Error(`fixture is FUNCTIONAL: v1 reaches ${String(seen.size)} distinct targets`);
  }
}

const built = performance.now();
const ARM = process.env.ARM ?? 'count';
const plan =
  ARM === 'count'
    ? traversal(V(), where(traversal(out('E'))), values('n'), count())
    : traversal(V(), where(traversal(out('E'))), values('n'));

let rows = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  rows += toArray(plan, g).length;
}

const ms = performance.now() - t0;

console.log(
  `# fixture build ${built.toFixed(0)} ms, query ${ms.toFixed(0)} ms — the query is ` +
    `${((100 * ms) / (built + ms)).toFixed(0)}% of the process, and the profile is only as good as that`,
);
console.log(
  `${((ms * 1e6) / Math.max(rows, 1)).toFixed(1)} ns/row over ${String(rows)} rows in ` +
    `${ms.toFixed(0)} ms — ARM=${ARM} at N=${String(N)} FANOUT=${String(FANOUT)}`,
);
