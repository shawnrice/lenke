import type { Edge, Graph } from '@lenke/core';

/**
 * ONE EDGE TYPE'S EDGES, FLAT — the structure an edge-PREDICATE walk needs, which the vertex CSR is
 * not (item 2016).
 *
 * ⚠️⚠️ **THE EXISTING CSR CANNOT SERVE AN EDGE PREDICATE, AND THAT IS WHY `edge-filtered-hop-values`
 * HAD NO FAST ARM FOR ~130 ITEMS.** `chainCsrFor` stores FAR VERTEX ids — the edge is gone by the
 * time the walk reads a slot, so a `has('w', gt(3))` on the edge has nothing to test. Every other
 * hop-values rung could take item 1889's CSR because none of them looks at an edge.
 *
 * 🔑 **AND THIS IS NOT A CSR — IT HAS NO `off`/`len`, BECAUSE THE SHAPE NEVER NEEDS THE VERTEX.** An
 * edge-filtered hop reads the predicate off the EDGE's own bag and the projection off `edge.to`, so
 * the per-vertex loop in the bucket walk exists only to find the next bucket. Appending each
 * bucket in `graph.vertices` order makes a LINEAR pass over this array produce exactly the nested
 * loop's row sequence — which is load-bearing, not incidental, because Gremlin rows are compared
 * ORDERED against the Rust engine and [[order-is-unspecified]] does not cover a single-type step.
 *
 * Measured at 200,000 vertices / 1,000,000 edges, one shape per process, best of 9, on
 * `V().outE(E).has(w, gt 3).inV().values(n)` — all four arms returning the same 571,428 rows
 * (`edge-filter-series-2016.mjs`):
 *
 * ```text
 *     the engine's bucket walk                      122 ns/edge-visit
 *     the same walk BY HAND over the same Sets        86              1.42x
 *     a flat edge array WITH off/len, per-vertex      64              1.91x
 *     the flat array walked LINEARLY                  53              2.30x
 * ```
 *
 * ⚠️⚠️ **AND THE SHIPPED WIN IS 1.28x, NOT 2.30x — THE HAND ARMS WERE FASTER FOR A REASON THE
 * ENGINE CANNOT COPY.** `edge-flat-ab-2016.sh`, PRE/POST order-alternated, one shape per process:
 * medians **129.6 -> 101.0 ms (1.28x)**, bests 125.2 -> 86.2 (1.45x). The remaining gap to the hand
 * arm decomposes, and only the first part was ever reachable:
 *
 * ```text
 *     the flat array, two closures, DYNAMIC key   79 ns   ⬅ what the engine can be
 *     the flat array, two closures, LITERAL key   56       1.41x — the KEYED LOAD alone
 *     the flat array, fully inlined               53       closure dispatch is only ~3 ns
 * ```
 *
 * So **the keyed load is the single largest residual term and it is UNREACHABLE, not pending**: the
 * property key is plan data, so `edge.properties[key]` cannot become `edge.properties.w` without
 * runtime codegen, and [[no-runtime-codegen]] is FIRM (`new Function` forces `unsafe-eval` into
 * every embedder's CSP). Closure DISPATCH, the obvious suspect, costs ~3 ns and is not a target.
 *
 * Dropping `off`/`len` is still worth 1.21x over the CSR-shaped version, so **the structural lever
 * was larger than the 1.79x item 1893's header priced** — that pricing kept the per-vertex loop.
 * The 200,000 `adjFrom.get(type)` Map lookups and 200,000 Set iterators are the difference.
 *
 * ⚠️ MEMORY: one entry holds ONE REFERENCE PER EDGE of its type and lives as long as the graph, so
 * it is heavier per edge than `chainCsrFor`'s typed arrays. The cap below and the second-ask policy
 * are what bound that; a one-shot query allocates nothing.
 *
 * ⚠️ BEHIND THE SECOND-ASK POLICY, item 1889's, for its reasons verbatim: a ONE-SHOT query never
 * builds, a WRITE-EVERY-READ workload never reaches a second ask on one topology version so it
 * never builds either, and a repeated read pays the build once. ⚠️ IN ITS OWN `kind` NAMESPACE —
 * see `second-ask.ts`, where sharing the default namespace would arm every vertex-CSR rung's build
 * on its own first ask.
 */
const MAX_EDGE_SHAPES = 8;

const cache = new WeakMap<Graph, { tv: number; byShape: Map<string, readonly Edge[]> }>();

/**
 * ⚠️ ONE KEY DERIVATION, SHARED BY THE PEEK AND THE BUILDER — `csr-cache.ts`'s discipline (item
 * 2005). Two copies of this would be two places for the direction marker to drift, and the peek
 * would then answer about a shape nothing built.
 */
const shapeKey = (outward: boolean, type: string): string => `${outward ? '>' : '<'}${type}`;

/**
 * ⚠️ BUILT IN `graph.vertices` ORDER, BUCKET BY BUCKET, which is the whole correctness argument:
 * the walk's row sequence must be byte-identical to the bucket walk's, and the only way to
 * guarantee that is to append in exactly the order the bucket walk visits.
 */
const build = (graph: Graph, outward: boolean, type: string): readonly Edge[] => {
  const flat: Edge[] = [];

  for (const v of graph.vertices) {
    const bucket = outward ? v.adjFrom?.get(type) : v.adjTo?.get(type);

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      flat.push(edge);
    }
  }

  return flat;
};

/**
 * This (graph, topology version, direction, type)'s edges, flat and cached.
 *
 * ⚠️ KEYED ON `topologyVersion`, NOT MERELY STAMPED WITH IT, and a stale generation is dropped WHOLE
 * — `chainCsrCache`'s discipline, so nothing leaks one dead entry per shape per write. ⚠️ AND
 * `topologyVersion` is the right clock here precisely because it advances SYNCHRONOUSLY, unlike
 * `version`/`epoch`, which advance only on the microtask drain ([[graph-counters-are-async]], where
 * keying a cache on those cost item 1646 its design).
 */
/**
 * Has this shape's flat array been BUILT? A pure peek — it never builds (item 2016).
 *
 * ⚠️⚠️ **IT EXISTS BECAUSE THE ROUTE CHOICE IS ANSWER-EQUIVALENT AND FOUR MUTANTS PROVED IT**
 * ([[perf-gate-needs-its-own-test]]). Asserting that ask 1 and ask 2 agree cannot distinguish "the
 * flat arm ran and was right" from "the flat arm never ran at all": mutants making the arm NEVER
 * fire, ALWAYS fire, and bypass the second-ask policy entirely all survived a suite that only
 * compared answers. This is what lets a test say WHICH route ran — the same role GQL's `csrIsBuilt`
 * plays for `csr-cache.ts` (item 2005), for the same reason.
 *
 * ⚠️ IT MUST NOT BUILD, or using it in a test would arm the thing the test is asking about.
 */
export const edgeFlatIsBuilt = (graph: Graph, outward: boolean, type: string): boolean => {
  const entry = cache.get(graph);

  return entry?.tv === graph.topologyVersion && entry.byShape.has(shapeKey(outward, type));
};

export const edgeFlatFor = (graph: Graph, outward: boolean, type: string): readonly Edge[] => {
  const tv = graph.topologyVersion;
  let entry = cache.get(graph);

  if (entry === undefined || entry.tv !== tv) {
    entry = { tv, byShape: new Map() };
    cache.set(graph, entry);
  }

  const key = shapeKey(outward, type);
  const hit = entry.byShape.get(key);

  if (hit !== undefined) {
    return hit;
  }

  // ⚠️ CAPPED, and cleared rather than evicted one at a time: an entry holds one reference per edge
  // of its type and lives as long as the graph, there is no recency information worth keeping, and
  // every entry costs one rebuild to recover. Growth needs many distinct edge types with no write
  // between them — a report sweeping one traversal per type.
  if (entry.byShape.size >= MAX_EDGE_SHAPES) {
    entry.byShape.clear();
  }

  const built = build(graph, outward, type);

  entry.byShape.set(key, built);

  return built;
};
