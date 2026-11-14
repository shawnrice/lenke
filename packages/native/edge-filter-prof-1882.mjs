/**
 * WHERE DOES THE FUSED EDGE-FILTER TRAVERSAL SPEND ITS TIME? (item 1882)
 *
 * Item 1881's workload screen nominated ONE shape by absolute milliseconds:
 * `V().outE('E').has('w', gt(3)).inV().values('n')` at **21.56 ms for 45,713 rows = 472 ns a row**,
 * against `hop1: values` at 51 ns a row — 9.3x the per-row cost of a plain hop projection, on an
 * entirely ordinary traversal (follow the edges whose weight exceeds 3, give me the targets'
 * property).
 *
 * ⚠️ IT IS NOT A MISSING RUNG, and that was checked BEFORE this file existed. An instrumented
 * `applyStep` (the generic pipeline's single entry) shows `outE.has(w).inV.values`, `outE.inV.values`,
 * `out.values` and `out.has(n).values` ALL answer with 0 `applyStep` calls. Every one is fused, so
 * the 9.3x is inside fused code and the question is a profile question, not a route question.
 *
 * The arithmetic that makes it worth profiling: the predicate is evaluated on ~100,000 edges and
 * emits 45,713, i.e. ~216 ns an edge VISIT, against the vertex-side `has('n', gt(5))` doing the same
 * kind of work — one property read, one comparison — at 93 ns an element. ~2.3x for the same shape
 * of work on the other element type.
 *
 * ⚠️ ONE SHAPE, ONE PROCESS. Item 1874 retracted a 1.73x that was a within-process cross-row ratio
 * and item 1870 measured a control moving 1.7x purely by running last. Nothing here times a second
 * shape, so no comparison between rows is possible and none is made. The vertex-side comparison
 * above comes from item 1881's screen, where it was a separate row of a separate sort — and even
 * that is a cross-row number, so it motivates the profile rather than standing as a result.
 *
 * ⚠️ AND THE FIXTURE'S SHARE IS PRINTED, because item 1875 took two profiles that were 76% and 40%
 * fixture build before raising REPS. A profile is only as good as the query's share of the process.
 *
 *     REPS=10 node --cpu-prof edge-filter-prof-1882.mjs
 */
import { Graph } from '@lenke/core';
import { V, gt, has, inV, outE, toArray, traversal, values } from '@lenke/gremlin';

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
const plan = traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'));

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
    `${ms.toFixed(0)} ms — V().outE(E).has(w,gt 3).inV().values(n) at N=${String(N)} FANOUT=${String(FANOUT)}`,
);
