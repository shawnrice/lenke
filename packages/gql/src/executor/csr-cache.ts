/**
 * THE TOPOLOGY-KEYED ADJACENCY CSR, SHARED BY EVERY ROUTE THAT WALKS A FLATTENED ADJACENCY.
 *
 * Built for the bounded var-length count at item 1676 (3.8x-27.2x) and lifted here at item 1685 so
 * the fixed-depth hop count can use it too. ⚠️ A LEAF MODULE RATHER THAN AN EXPORT FROM ITS ORIGINAL
 * HOME: `var-length-count.ts` imports from `shortcuts.ts`, so having `shortcuts.ts` import the cache
 * back would be a cycle, and `import/no-cycle` is an error here.
 */
import type { Edge, Graph, Vertex } from '@lenke/core';

import type { LabelExpr } from '../ast.js';
import { edgesOfTypes } from './adjacency.js';
import { EDGE_DRIVEN_MIN_COVERAGE, labelCoverage, vacuousLabel } from './labels.js';

/** The flattened adjacency the level recurrence reads. Built once, then READ ONLY — every write to
 *  `off`, `nbr`, `order` and `idx` lives in {@link buildCsr}, which is what makes it cacheable. */
export type CsrTables = {
  order: readonly Vertex[];
  idx: ReadonlyMap<Vertex, number>;
  off: Int32Array;
  nbr: Int32Array;
};

/**
 * ONE PASS to number the vertices, then the adjacency FLATTENED into neighbour indices. After this
 * no level consults a Map at all, which is the whole point — see the ablation in the module header.
 *
 * PREALLOCATED to the graph's edge count and filled in ONE pass. Built as a `number[]` with `push`
 * and then `Int32Array.from`, the same CSR cost ~55ms instead of ~20 — boxing, array growth, and
 * then a full copy — which showed up as the whole route reading 58ms flat in depth where the
 * per-level work is 0.3ms. The wanted-type filter can only keep FEWER edges than the graph has, so
 * `edgeCount` is a safe bound and the slack is never touched.
 */
const buildCsr = (graph: Graph, inward: boolean, types: string[] | undefined): CsrTables => {
  // THE ONLY THING DIRECTION CHANGES (item 744): which adjacency box the CSR is built from, and
  // which end of each edge is the neighbour. Everything downstream — the level recurrence, and the
  // depth-3/4 trail correction via `buildTrailMasks` and `buildTrail4Tables` — takes `{off, nbr}`
  // and never consults the graph again, so it inherits the direction for free.
  const edgesOf = (v: Vertex): Iterable<Edge> => {
    const box = inward ? v.adjTo : v.adjFrom;

    return box === undefined ? [] : edgesOfTypes(box, types);
  };
  const order = [...graph.verticesById.values()];
  const idx = new Map<Vertex, number>();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(graph.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const e of edgesOf(order[i])) {
      nbr[at] = idx.get(inward ? e.from : e.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;

  return { order, idx, off, nbr };
};

/**
 * THE CSR, REUSED ACROSS QUERIES (item 1676). Item 1571 instrumented this route and found 86.3% of
 * a bounded var-length count going into a structure that is discarded the moment the query returns,
 * so the second identical query rebuilds it from scratch. The ablation in the module header is why:
 * the build is one level's worth of Map lookups and each level after it is ~0.1 ms.
 *
 * ⚠️ THE KEY IS `graph.topologyVersion`, AND NOTHING ELSE WOULD DO. `graph.version` and
 * `graph.epoch(name)` advance on a DEFERRED, veto-checked step — both read 0 through a sequence of
 * mutations and move only after a task drain — so a cache keyed on either serves a stale structure
 * to the ordinary `g.addEdge(...); query(g, …)` shape. `vertexCount`/`edgeCount` advance eagerly
 * but a delete plus an add leaves both unchanged while the topology differs. `topologyVersion` was
 * built for this (items 1674/1675) and bumps on vertex adds and removes, edge adds and removes, AND
 * edge-LABEL writes — the last because the adjacency boxes are keyed by edge type, so
 * `addLabelToEdge` re-buckets what `types` selects without touching `insertEdge`.
 *
 * ⚠️ AND THE SHAPE IS PART OF THE KEY, because `nbr` is DIRECTION- AND TYPE-FILTERED. Two
 * queries differing only in `-[:E]->` vs `<-[:E]-`, or in the edge types they name, need different
 * neighbour arrays from the same topology.
 *
 * ⚠️ `types` IS NOT SORTED INTO THE KEY, deliberately. Two spellings naming the same types in a
 * different order are semantically equivalent, so sharing an entry is tempting — but `edgesOfTypes`
 * iterates `types` IN ORDER, so the two orders produce `nbr` arrays that differ in position. The
 * count itself is a sum and would survive, but the depth-3/4 trail corrections read `nbr` positionally
 * via `pairMultiplicities`, and f64 sums in a different order are not required to agree bit for bit.
 * Byte-identity is a hard invariant here, so the conservative key is the one that ships.
 *
 * A `WeakMap` so a discarded graph is collectable, and a per-shape `Map` inside it so a workload
 * alternating two directions or two type filters does not thrash a single slot.
 */
const MAX_SHAPES = 8;

const csrCache = new WeakMap<Graph, { tv: number; byShape: Map<string, CsrTables> }>();

/**
 * The cache key for one (direction, type set) shape.
 *
 * ⚠️ ONE SPELLING, used by `csrFor` AND `csrIsBuilt`. Two copies of a cache key is how a peek starts
 * answering about a different entry than the builder populates — a silent "always cold", which would
 * make the gate above a no-op that still looked like a gate.
 */
const shapeKey = (inward: boolean, types: string[] | undefined): string =>
  `${inward ? '<' : '>'}${types === undefined ? '*' : types.join('\u0000')}`;

/**
 * Is this shape's CSR ALREADY built for the graph's current topology? A pure peek — it populates
 * nothing (item 2005).
 *
 * ⚠️⚠️ **IT EXISTS SO A CALLER CAN DECLINE THE BUILD RATHER THAN THE STRUCTURE, which is a different
 * question from `csrFor` and could not be asked before.** `runReach`'s walk over these tables is
 * 1.45-1.64x faster than the `Set<string>` BFS it replaced even COLD, because an O(|V| + |E|) build
 * beats hashing a string per reached vertex. But a NARROW SEED does little work, so the build is
 * pure overhead there: a seeded `{1,2}` measured **7.35 ms cold before and 11.89 after, a 1.62x
 * REGRESSION**, while its warm figure improved 1.72x.
 *
 * 🔑 So the choice is not "CSR or not" but "pay a build or not", and those come apart exactly when
 * the cache already holds the answer. With this peek a cold narrow-seed query keeps the per-vertex
 * walk and a warm one gets the tables for free — rather than trading one case for the other.
 * [[closed-perf-targets]]'s item 1889 made the same distinction with its second-ask policy, and item
 * 1979's lesson is the reason it is checked at all: **benchmark the UNHELPED case, which is usually
 * the common one.**
 */
export const csrIsBuilt = (graph: Graph, inward: boolean, types: string[] | undefined): boolean => {
  const entry = csrCache.get(graph);

  if (entry === undefined || entry.tv !== graph.topologyVersion) {
    return false;
  }

  return entry.byShape.has(shapeKey(inward, types));
};

export const csrFor = (graph: Graph, inward: boolean, types: string[] | undefined): CsrTables => {
  const tv = graph.topologyVersion;
  let entry = csrCache.get(graph);

  if (entry === undefined || entry.tv !== tv) {
    // A single stale generation is dropped WHOLE rather than per shape: every shape built from the
    // old topology is equally invalid, and keeping the map would leak one entry per shape per write.
    entry = { tv, byShape: new Map() };
    csrCache.set(graph, entry);
  }

  const key = shapeKey(inward, types);
  const hit = entry.byShape.get(key);

  if (hit !== undefined) {
    return hit;
  }

  // ⚠️ CAPPED, BECAUSE THE RETENTION IS NOT SMALL AND NOTHING ELSE BOUNDS IT. Each entry holds
  // `order` (V references), `idx` (a V-entry Map) and two typed arrays sized V+1 and E — on the order
  // of 2 MB for a 50,000-vertex, 150,000-edge graph — and it lives as long as the graph does. A
  // generation is dropped whole on any topology write, so growth needs MANY distinct shapes with no
  // write between them, which is exactly what a report sweeping one query per edge type does. Past
  // the cap the generation is cleared rather than evicted one entry at a time: there is no recency
  // information worth keeping here, every entry costs one rebuild to recover, and a clear cannot
  // degrade into holding the cap's worth of cold entries forever.
  if (entry.byShape.size >= MAX_SHAPES) {
    entry.byShape.clear();
  }

  const built = buildCsr(graph, inward, types);
  entry.byShape.set(key, built);

  return built;
};

/**
 * Does the UNFILTERED two-hop count — the degree product — belong on the CSR? (item 1890)
 *
 * ⚠️⚠️ **THE SCALE SWEEP FOUND THIS, and the shape of the finding is the same as item 1889's one
 * surface over.** `rung-gap-screen.mjs` at `NODES=200000` flags `count: depth2 (42.0 ms) costs 7.3x
 * depth3 (5.7)` — a SHORTER chain costing more, which is the signature that grid exists for. Floored
 * isolated, one shape per process, 200,000 vertices / 200,000 edges, median of 9:
 *
 * ```text
 *   MATCH (a)-[:E]->(b) RETURN count(*)                      0.00 ms   a stored counter
 *   MATCH (a)-[:E]->(b)-[:E]->(c) RETURN count(*)           23.97      ⬅ the degree product
 *   … -[:E]->(d) (three segments)                            6.72      ⬅ the SAME product, on a CSR
 *   … four segments                                         19.63
 * ```
 *
 * **The three-segment product got the CSR at item 1685 and the two-segment one never did.** That
 * item's own note says what it replaced and what it was worth: "`off[s + 1] - off[s]` on a
 * `topologyVersion`-keyed CSR instead of a string-keyed `edgesFromByLabel.get(id)`, which item 1684
 * counted at |V| + |E| lookups for this shape and measured at 242.94x / 297.93x / 278.24x". The
 * two-segment loop still reads `sideOfVertex(b, …)` TWICE per middle — item 1334 already took those
 * from an id-keyed `Map.get` to the vertex's own memoized box, which is the step before this one.
 *
 * ⚠️ THE GATE IS THE DEGREE PRODUCT'S OWN CONDITIONS, minus what a CSR degree cannot express:
 *
 *   - `firstBoth`/`secondBoth` — an UNDIRECTED side is two boxes plus a self-loop correction
 *     (`undirectedSide`, `loopsOfTypes`), not one run length. Refused, as `twoHopFilteredCsrApplies`
 *     refuses it.
 *   - `aEff`/`cEff` — a non-vacuous END label makes the side an endpoint-filtered scan rather than a
 *     bucket size (`effectiveLabel`'s own point), so the degree is not a run length either.
 *   - `midEff` and `gated` — a MIDDLE label or constraint is per-element and would be a per-slot
 *     mask over all of `order` where the current loop iterates only the label bucket. That is a
 *     different trade (item 1688's `seeded` lesson) and is left on the existing loop.
 */
export const twoHopUnfilteredCsrApplies = (s: {
  firstBoth: boolean;
  secondBoth: boolean;
  aEff: LabelExpr | undefined;
  cEff: LabelExpr | undefined;
  midEff: LabelExpr | undefined;
  gated: boolean;
}): boolean =>
  !s.firstBoth &&
  !s.secondBoth &&
  s.aEff === undefined &&
  s.cEff === undefined &&
  s.midEff === undefined &&
  !s.gated;

/**
 * `count = sum over b of indeg(b) * outdeg(b)`, both degrees read as CSR run lengths.
 *
 * ⚠️ NO MAP LOOKUP AND NO SET ITERATION IN THE LOOP, which is the whole change: two `Int32Array`
 * subtractions per slot where the existing loop takes two memoized-box `Map.get`s plus a `.size`.
 * The arithmetic is the caller's, unchanged.
 *
 * ⚠️ `csrFor`'s `inward` IS THE NEGATION of a side's `out`-ness, the same conversion
 * `twoHopFilteredCsrCount` documents: `out` reads `edgesFromByLabel`.
 */
export const twoHopUnfilteredCsrCount = (
  graph: Graph,
  spec: {
    toAOut: boolean;
    t1: string[] | undefined;
    fromCOut: boolean;
    t2: string[] | undefined;
  },
): number => {
  const legA = csrFor(graph, !spec.toAOut, spec.t1);
  const legC = csrFor(graph, !spec.fromCOut, spec.t2);
  const n = legA.order.length;
  let count = 0;

  for (let s = 0; s < n; s += 1) {
    const ways = legA.off[s + 1] - legA.off[s];

    if (ways === 0) {
      continue;
    }

    count += ways * (legC.off[s + 1] - legC.off[s]);
  }

  return count;
};

/**
 * The gate and the count as ONE entry — `null` declines, a number is the answer.
 *
 * ⚠️ IT EXISTS FOR THE `max-lines` CAP, not for taste: `shortcuts.ts` is at 3,000 non-comment lines
 * and the gate's argument object written at the call site took it to 3,001. The gate itself stays a
 * separately exported pure function with its own tests (`twoHopUnfilteredCsrApplies`), which is
 * what `perf-gate-needs-its-own-test` asks for — this only moves the plumbing.
 */
/**
 * The far-driven hop projection's CSR, or `undefined` to keep the existing walk (item 1895).
 *
 * ⚠️⚠️ **A PURE FUNCTION BECAUSE BOTH ITS CONDITIONS ARE ANSWER-EQUIVALENT, and one of them was a
 * real bug.** Written inline in `hop-projection.ts`, two mutants survived every behavioural test:
 * reading the label's vacuity from the AST instead of the graph (which DECLINES every labelled
 * pattern — the exact bug the first cut of that arm shipped, measured as a flat null), and letting
 * the arm claim its own FIRST ask (which pays the CSR build on a one-shot query). Both return the
 * right rows by the wrong route, so only a direct test of the decision can see them —
 * [[perf-gate-needs-its-own-test]], the same remedy items 1776 and 1890 applied.
 *
 *   - **A FAR LABEL THAT EXCLUDES ANYTHING DECLINES.** `candidateVertexSource` iterates the label
 *     BUCKET, so a selective label makes the existing walk sub-linear where this arm is O(V) — item
 *     1688's lesson, which it learned from a test rather than from reasoning. VACUITY IS A PROPERTY
 *     OF THE GRAPH (`vacuousLabel`, items 1551/1552) and can only be read per execution: the
 *     factory captures the AST label at compile time.
 *   - **THE BUILD IS DEFERRED TO THE SECOND ASK** (`csrAskedBefore`), because the CSR is keyed on
 *     `topologyVersion`: a one-shot query and a write-heavy workload never pay for it. Item 1889
 *     measured that trade at 0.61x COLD without the policy and 1.01x with it.
 */
export const csrHopRoute = (
  graph: Graph,
  out: boolean,
  typeName: string,
  farLabel: LabelExpr | undefined,
): { readonly tables: CsrTables; readonly testFarLabel: boolean } | undefined => {
  /*
   * ⚠️ A NON-VACUOUS FAR LABEL NO LONGER DECLINES OUTRIGHT (item 1941). It used to, for the reason
   * above — `candidateVertexSource` iterates the label BUCKET, so a SELECTIVE label makes the
   * existing walk sub-linear where this arm is O(V). That reason holds only while the label IS
   * selective: the CSR's `order` array is the far vertices, so a broad label can be applied PER
   * SLOT in O(1) instead, which is the move item 1940 made on the start end.
   *
   * 🔑 MEASURED, NOT ASSUMED. `farlabel-crossover-1941.mjs` at 50,000 vertices, 15 reps with the
   * cells alternated: the engine is 1.71-5.51 ms where a hand CSR with a per-slot label test is
   * 0.70-1.07 (2.4x-5.1x) at 0.45-0.6 coverage, while at 0.04 the bucket walk wins 2.4x. ⚠️ At 7
   * reps the same cells read 1.07x and 6.44x — noise either side of the truth, which is why the
   * band and not a cell is what this constant is set from.
   *
   * `testFarLabel` is how the caller knows the label still has to be applied: admitting it here
   * WITHOUT that flag would be a wrong answer, which is why the return shape changed rather than
   * the condition alone.
   */
  const broadFarLabel =
    farLabel !== undefined && (labelCoverage(graph, farLabel) ?? 0) >= EDGE_DRIVEN_MIN_COVERAGE;

  if (farLabel !== undefined && !vacuousLabel(graph, farLabel) && !broadFarLabel) {
    return undefined;
  }

  const tables = csrAskedBefore(graph, `hop:${out ? '<' : '>'}${typeName}`)
    ? csrFor(graph, out, [typeName])
    : undefined;

  return tables === undefined
    ? undefined
    : { tables, testFarLabel: farLabel !== undefined && !vacuousLabel(graph, farLabel) };
};

/**
 * Has this (graph, topology version, leg shape) been asked for BEFORE? The first ask returns
 * `false` and records it; every later ask returns `true`.
 *
 * ⚠️⚠️ **THE CSR'S BUILD IS PAID BY THE FIRST QUERY AFTER ANY TOPOLOGY WRITE, and for this shape the
 * build DWARFS the walk.** Measured isolated at 200,000 vertices / 200,000 edges, one shape per
 * process: the two-hop count's warm cost went **23.97 ms → 0.20** (two `Int32Array` subtractions a
 * slot instead of two memoized-box `Map.get`s plus a `.size`), while its COLD first rep went
 * **91 ms → 181**. Break-even without a policy is ~4 calls.
 *
 * Deferring the build to the SECOND ask removes the loss and keeps the win, which is item 1889's
 * policy on the Gremlin side, ported verbatim because the trade is identical:
 *
 *   - a ONE-SHOT count never builds and pays nothing;
 *   - a WRITE-HEAVY workload (write, count, write, count) never reaches a second ask on any one
 *     topology version, so it never builds either;
 *   - a repeated count pays the build once and is ~120x from then on.
 *
 * ⚠️ IT IS A ROUTE CHOICE, so it is answer-equivalent and every mutant of it survives the
 * behavioural tests — [[perf-gate-needs-its-own-test]]. Hence a pure exported function with its own
 * unit tests, including that it RESETS on a topology write.
 *
 * ⚠️ AND IT IS KEYED PER LEG SHAPE, not per graph: two different two-hop counts over different edge
 * types are different CSRs and each amortizes on its own.
 */
const asked = new WeakMap<Graph, { tv: number; shapes: Set<string> }>();

export const csrAskedBefore = (graph: Graph, key: string): boolean => {
  const tv = graph.topologyVersion;
  let entry = asked.get(graph);

  if (entry === undefined || entry.tv !== tv) {
    entry = { tv, shapes: new Set() };
    asked.set(graph, entry);
  }

  if (entry.shapes.has(key)) {
    return true;
  }

  entry.shapes.add(key);

  return false;
};

export const twoHopCsrProduct = (
  graph: Graph,
  spec: {
    firstBoth: boolean;
    secondBoth: boolean;
    aEff: LabelExpr | undefined;
    cEff: LabelExpr | undefined;
    midEff: LabelExpr | undefined;
    gated: boolean;
    toAOut: boolean;
    t1: string[] | undefined;
    fromCOut: boolean;
    t2: string[] | undefined;
  },
): number | null => {
  if (!twoHopUnfilteredCsrApplies(spec)) {
    return null;
  }

  // ⚠️ THE SECOND-ASK POLICY — see `csrAskedBefore`. The key is both legs' direction and types, so
  // each distinct two-hop count amortizes on its own.
  const key = `${spec.toAOut ? '<' : '>'}${(spec.t1 ?? []).join('\u0000')}|${spec.fromCOut ? '>' : '<'}${(spec.t2 ?? []).join('\u0000')}`;

  return csrAskedBefore(graph, key) ? twoHopUnfilteredCsrCount(graph, spec) : null;
};
