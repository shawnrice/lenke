/**
 * **THE GREMLIN TWIN OF ITEM 2269/2271 (item 2272).** GQL's statement cost grew 5x once a session
 * cycled over more than `PARSE_CACHE_CAP` distinct texts — shipped as 64 → 512 at item 2271. Gremlin cannot
 * have that exact defect: **its caches are keyed `WeakMap<Graph, {tv, byShape: Map<string, …>}>`** — on the
 * GRAPH plus a SHAPE STRING, never on the plan object or on text — so rebuilding an identical traversal
 * hits the same `shapeKey`. And there is no parse step at all; the caller builds the plan directly.
 *
 * **BUT THAT LEAVES A REAL QUESTION NO SCREEN ASKS.** Every screen and bench row builds its
 * `traversal(...)` ONCE and reuses the object. A real application builds one per request. So:
 *
 *     reuse      ONE plan object, called many times      — what every screen measures
 *     fresh      a NEW traversal() per call, same shape   — what an application does
 *     distinct   a NEW traversal() per call, MANY shapes  — tests the `byShape` string caches
 *
 * All three must do identical work per call, so `distinct` varies only the `has` VALUE — which changes
 * the shape key without changing the row count. The row count is asserted for exactly that reason.
 *
 * The fixture is small (execution cheap) so per-call plan handling is visible rather than swamped.
 */
import { Graph } from '@lenke/core';
import { V, count, gte, has, hasLabel, toArray, traversal, type Plan } from '@lenke/gremlin';

const N = Number(process.env.N ?? 400);
const CALLS = Number(process.env.CALLS ?? 2000);
const REPS = Number(process.env.REPS ?? 7);
const ARM = process.env.ARM ?? 'reuse';
const DISTINCT = Number(process.env.DISTINCT ?? 500);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 97 } });
}

/* `k >= -i` matches every row for any i >= 0, so the WORK is identical across arms and shapes. */
const planFor = (i: number): Plan =>
  traversal(V(), hasLabel('T'), has('k', gte(-1 - (i % DISTINCT))), count());

const SHARED = planFor(0);

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const series: number[] = [];

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  let total = 0;

  for (let i = 0; i < CALLS; i += 1) {
    const plan = ARM === 'reuse' ? SHARED : planFor(ARM === 'distinct' ? i : 0);

    total += Number(toArray(plan, g)[0]);
  }

  series.push(performance.now() - t);

  /* Every arm must count every vertex on every call, or the arms are not doing the same work. */
  if (total !== CALLS * N) {
    throw new Error(`${ARM}: total ${total}, expected ${CALLS * N} — the arms differ in WORK`);
  }
}

const m = med(series.slice(2));

console.log(
  `  ARM=${ARM.padEnd(9)} ${CALLS} calls  ${m.toFixed(1).padStart(7)} ms  ${((m * 1e6) / CALLS).toFixed(0).padStart(7)} ns/call${ARM === 'distinct' ? `   distinct shapes=${DISTINCT}` : ''}`,
);
