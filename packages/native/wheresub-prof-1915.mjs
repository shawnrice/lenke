// Item 1915 — `V().where(out(T)).values(k)` is the Gremlin surface's largest shape that neither
// needs the path nor has a priced refusal: 90.01 ms for 200,000 rows at 200,000 vertices /
// 1,000,000 edges, where `V().values(k)` answers the SAME 200,000 rows in 5.81.
//
// THE OTHER TOP ROWS ARE ALREADY PRICED. `edge: outE.has(w).inV` (70.32) was measured at item
// 1893 — the engine's rung is 2.08x a hand walk over the identical `Set`s, the `drain` half was
// taken, and the edge-indexed CSR that would add the rest is priced at a further 1.79x and NOT
// built. `agg: hop values min` (62.87) was recorded at item 1892 as "~17 ms for an order-invariant
// fold ... not a route gap". `path: hop path` (149) returns path objects. This one has no entry.
//
// THE MECHANISM IS VISIBLE IN `dispatch.ts` BEFORE ANY PROFILE: `whereSubPlanStep` calls
// `applyPlanToStream(plan, [t], graph, ctx)` ONCE PER TRAVERSER — a one-element array and a fresh
// generator chain per vertex, 200,000 of them. `case 'optional'` in the same file already fuses
// exactly this shape (`optionalSingleHop`) for exactly this reason. `filter(sub)` shares the step,
// and `not`/`and`/`or` share the per-traverser `applyPlanToStream`.
//
// `hasAny` ALREADY SHORT-CIRCUITS — the sub-plan is lazy, so this is NOT "walking the whole
// adjacency to answer a yes/no". The cost under test is the per-traverser SETUP, which is why the
// `deg1` arm matters: a fixture where every vertex's FIRST out-edge answers it isolates setup from
// walking.
//
//     SHAPE=where|scan|filter|not|and|wherecnt|hop bun --cpu-prof wheresub-prof-1915.mjs
//
// ONE SHAPE PER PROCESS, and profile at a high `REPS` or the profile is the fixture build
// (item 1900's lesson).
import { Graph } from '@lenke/core';
import {
  V,
  and,
  count,
  filter,
  not,
  or,
  out,
  toArray,
  traversal,
  values,
  where,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'where';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { k: i % 50, n: i % 8 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const PLANS = {
  // THE TARGET: keep every vertex with an out-`E`, then read a property off it.
  where: traversal(V(), where(traversal(out('E'))), values('n')),
  // THE FLOOR: the same 200,000 rows, no filter. Every vertex has an out-`E` at this fixture.
  scan: traversal(V(), values('n')),
  // The same step by a different name — `case 'filter'` delegates to `whereSubPlanStep`.
  filter: traversal(V(), filter(traversal(out('E'))), values('n')),
  // The negation: `not` has its own case but the same per-traverser `applyPlanToStream`.
  not: traversal(V(), not(traversal(out('E'))), values('n')),
  // `and` of one plan — again the same per-traverser call, through `filterTraverser`.
  and: traversal(V(), and(traversal(out('E'))), values('n')),
  // Does the count twin behave the same? (It returns 1 row, so it prices the filter alone.)
  wherecnt: traversal(V(), where(traversal(out('E'))), count()),
  // `and` MEASURED 36.4 WHERE `where` MEASURED 21.1 FOR IDENTICAL WORK, and an indexed loop in
  // place of `for…of` did not move it. These two localize that: if the gap survives with the
  // projection removed it is the STEP, and if it vanishes the two spellings differ in what they let
  // the DOWNSTREAM `values` do.
  andcnt: traversal(V(), and(traversal(out('E'))), count()),
  or: traversal(V(), or(traversal(out('E'))), values('n')),
  orcnt: traversal(V(), or(traversal(out('E'))), count()),
  // CONTROL the change cannot reach: the plain fused hop.
  hop: traversal(V(), out('E'), values('n')),
};

const plan = PLANS[SHAPE];
const ser = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();
  const out_ = toArray(plan, g);
  const ms = performance.now() - t0;

  rows = out_.length;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(10)} N=${N} FANOUT=${FANOUT} reps=${REPS}  median ${ser[ser.length >> 1].toFixed(2)} ms  ` +
    `min ${ser[0].toFixed(2)}  rows ${rows}`,
);
console.log(`  series ${ser.map((x) => x.toFixed(1)).join(' ')}`);
