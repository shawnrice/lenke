/**
 * What does `addEdge` cost, and where does that cost go?
 *
 *   cd packages/native && bun run addedge:cost
 *   P357_N=50000 P357_RATIO=10 P357_REPS=5 bun run addedge:cost
 *
 * `addEdge` is the ONLY lever on pure-TS ingest. Item 356 measured the TS decode as
 * format-INDEPENDENT — 2229-2740 ns/element across five codecs, a 1.23x spread where native spans
 * 3.55x — so TS ingest is bound by the graph BUILD and no codec work can touch it. This probe is
 * the instrument for that build.
 *
 * WHY IT EXISTS AS A SEPARATE HARNESS. `bun run bench`'s decode rows cannot answer the question:
 * they include JSON.parse (19% of the row, item 312) and they go through `@lenke/serialization`,
 * which resolves `@lenke/core` to its built DIST — so an A/B of core's SOURCE is not in effect at
 * all, and every edit costs a full `bun run build` before it can be measured. That is the stale-
 * artifact trap in a new place, and it is why this reads core's source and drives the two public
 * writes directly.
 *
 * READING IT. `ns/edge` is the number; NODE ingest is the NULL CONTROL, since nothing done to the
 * edge path can reach it — if it moves between variants the box is drifting and the edge figures
 * mean nothing. It reproduces the known baselines, which is how you know the harness is sane:
 * ~2700-3050 ns/edge against item 312's ~2.9us, and ~900-1000 ns/node against its ~1.08us.
 *
 * WHAT IT HAS ALREADY ESTABLISHED (item 357), by ablating `indexEdgeLabel`'s three indexes —
 *
 *   1. edgesByLabel      Map<label, Set<Edge>>              — every edge of a type
 *   2. edgesFromByLabel  Map<fromId, Map<label, Set<Edge>>> — out-adjacency
 *   3. edgesToByLabel    Map<toId,   Map<label, Set<Edge>>> — in-adjacency
 *
 * — one at a time, three alternated rounds, min of each, ns/edge:
 *
 *     CONTROL                         2760   (range 2760-2867)
 *     minus edgesByLabel              2592   OVERLAPS the control — not measurable, <=4%
 *     minus edgesFromByLabel          2461   -240  (8.9%), disjoint
 *     minus edgesToByLabel            2483   -218  (8.1%), disjoint
 *     minus BOTH adjacency maps       2076   -684 (24.8%), disjoint
 *     minus all three                 1912   -848 (30.7%), disjoint
 *     minus all three AND the loop    1887   indistinguishable from the line above
 *
 * Three results worth keeping:
 *   - item 312's "the label index is 810ns" is CONFIRMED in aggregate (848 here, 30.7% of the
 *     write) and now SPLIT: the two per-vertex adjacency maps are the whole of it, and
 *     `edgesByLabel` — the 1,000,000-element per-label Set — is NOT MEASURABLE. A big Set.add is
 *     essentially free, which retracts the intuition that the big container is the expensive one.
 *   - the per-label LOOP and the function call are FREE (1912 against 1887, ranges overlapping),
 *     so the aggregate is not an artifact of ablating down to an empty callee.
 *   - the two adjacency maps looked SUPERADDITIVE — 684 together against 240+218=458 apart, a
 *     226ns apparent SHARED term. **RETRACTED at item 358**, which went looking for its mechanism
 *     and found neither candidate survives. Both experiments are recorded there; the short form is
 *     that 226ns is 8% of this row and the harness's own demonstrated repeatability is 3-6%, so
 *     the term was not large enough to attribute. Treat a superadditivity under ~10% here as
 *     unproven until a mechanism reproduces.
 *
 * AND WHAT ITEM 358 CLOSED, which is the part that saves work:
 *   - removing ALL ~800,000 inner Map+Set allocations (shared singletons in their place, every
 *     hash operation kept) is worth **128ns, 4.9%, at the noise floor**, with one of five
 *     alternated rounds showing no effect at all. **So the inner-container allocation is not a
 *     target** — and that was the whole motivation for a tagged single-label inner representation,
 *     a change whose readers span `Vertex.adjFrom`, both engines' `graph-queries`, four algorithms
 *     and three `shortcuts` helpers. Refuted before it was built.
 *   - merging the two adjacency maps into ONE outer map (one working set) is **WORSE** than the
 *     control (2821 against 2757), so the two-large-maps cache story is out too.
 *   - what is left is the string-keyed hash work itself: ~4 keyed `get`s, 2 `set`s and 2
 *     `Set.add`s an edge, at roughly 75-100ns each on a 200,000-entry Map. The only lever on that
 *     is the KEY TYPE, i.e. the dense integer-indexed adjacency of item 300 — parked at item 348,
 *     and every road in this area keeps arriving there.
 */
// oxlint-disable-next-line boundaries/no-cross-package-relative-import -- probe reads source to skip the build step
import { Graph } from '../core/src/index.ts';

const N = Number(process.env.P357_N ?? 200_000);
const RATIO = Number(process.env.P357_RATIO ?? 5);
const REPS = Number(process.env.P357_REPS ?? 3);
const label = process.argv[2] ?? 'variant';

// Endpoint ids precomputed so the timed region does no string formatting — the same scatter the
// bench's `graphDoc` uses, so degree distribution matches the row this is about.
const E = N * RATIO;
const froms = new Array<string>(E);
const tos = new Array<string>(E);

for (let k = 0; k < E; k++) {
  froms[k] = `v${(k * 7919) % N}`;
  tos[k] = `v${(k * 104_729) % N}`;
}

const vids = Array.from({ length: N }, (_, i) => `v${i}`);

let bestNodes = Infinity;
let bestEdges = Infinity;

for (let rep = 0; rep < REPS; rep++) {
  const g = new Graph();

  let t = performance.now();

  for (let i = 0; i < N; i++) {
    g.addVertex({ id: vids[i], labels: ['Person'], properties: { age: i % 90 } });
  }

  bestNodes = Math.min(bestNodes, performance.now() - t);

  // Resolve the endpoint Vertex objects OUTSIDE the timed region? No — `addEdge` takes vertices
  // and resolves them itself, and that resolve is part of what the row pays. Passing the live
  // objects is what `@lenke/serialization`'s decode does too, so this matches the real caller.
  const byId = new Map<string, ReturnType<Graph['addVertex']>>();

  for (const v of g.vertices) {
    byId.set(v.id, v);
  }

  t = performance.now();

  for (let k = 0; k < E; k++) {
    g.addEdge({
      id: `e${k}`,
      labels: ['KNOWS'],
      from: byId.get(froms[k])!,
      to: byId.get(tos[k])!,
      properties: { w: k % 7 },
    });
  }

  bestEdges = Math.min(bestEdges, performance.now() - t);
}

console.log(
  `${label.padEnd(22)} edges ${bestEdges.toFixed(0).padStart(6)} ms (${((bestEdges * 1e6) / E).toFixed(0).padStart(5)} ns/edge)   ` +
    `CONTROL nodes ${bestNodes.toFixed(0).padStart(5)} ms (${((bestNodes * 1e6) / N).toFixed(0).padStart(5)} ns/node)`,
);
