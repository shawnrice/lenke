import type { Edge, Graph, Vertex } from '@lenke/core';

import type { LabelExpr } from './ast.js';

/**
 * The slice of a relationship pattern that adjacency cares about: which way to
 * walk and which edge types to admit. Both the raw `RelPattern` and the
 * executor's compiled `CRel` satisfy this, so `expand` works over either.
 */
export type Adjacency = { direction: 'out' | 'in' | 'both'; label?: LabelExpr };

/**
 * GQL's view of adjacency. Reads the *same* core indexes the gremlin package
 * reads (`edgesFromByLabel` / `edgesToByLabel`), but speaks GQL's vocabulary: a
 * pattern segment yields `{ edge, node }` pairs — the matched relationship plus
 * the vertex on the far end — which is exactly what binding a `(rel)(node)`
 * step needs.
 *
 * This is the concrete realization of the note in gremlin's own
 * `graph-queries.ts`: out/in/both is traversal vocabulary, so each language
 * keeps its own adjacency helpers over the shared edge store.
 */

export type Step = {
  edge: Edge;
  node: Vertex;
};

const edgesMatching = function* (
  byLabel: Map<string, Set<Edge>> | undefined,
  label: LabelExpr | undefined,
): Iterable<Edge> {
  if (!byLabel) {
    return;
  }

  // Fast path: a single edge type hits its index bucket directly.
  if (label?.kind === 'label') {
    const set = byLabel.get(label.name);

    if (set) {
      yield* set;
    }

    return;
  }

  // Otherwise evaluate the label expression against each edge, deduping across
  // the per-type buckets.
  const seen = new Set<Edge>();

  for (const set of byLabel.values()) {
    for (const e of set) {
      if (seen.has(e)) {
        continue;
      }

      seen.add(e);

      if (label === undefined || evalLabelExpr(label, e.labels)) {
        yield e;
      }
    }
  }
};

// `v.adjFrom` / `v.adjTo` rather than a string-keyed graph lookup — see the note in `expand`.
const outSteps = function* (v: Vertex, label: LabelExpr | undefined): Iterable<Step> {
  for (const edge of edgesMatching(v.adjFrom, label)) {
    yield { edge, node: edge.to };
  }
};

const inSteps = function* (v: Vertex, label: LabelExpr | undefined): Iterable<Step> {
  for (const edge of edgesMatching(v.adjTo, label)) {
    yield { edge, node: edge.from };
  }
};

/**
 * The ONE bucket a directed single-type hop reads, or `undefined` when the shape needs `expand`
 * (item 1621).
 *
 * ⚠️ WHY A CALLER WOULD WANT THIS RATHER THAN `expand`. `expand` is a GENERATOR that yields a fresh
 * `{ edge, node }` per edge, so a caller pays one resume and one object allocation per edge — and
 * `expand` was **16.3%** of the grouped-hop count's profile with the garbage collector at 8.1%
 * beside it. For the directed single-type case there is nothing to iterate but one `Set` and nothing
 * to dedupe, so a caller that loops it directly pays neither.
 *
 * ⚠️ IT RETURNS `undefined` FOR EVERY OTHER SHAPE, AND THAT IS THE LOAD-BEARING PART.
 * `detectGroupedHopCount`'s own comment records what hand-rolling the general case cost: a `T|S`
 * edge counted TWICE under `-[:T|S]->`, because the per-type buckets both hold it and only
 * `expand`'s `Set` dedupes across them. So this helper refuses anything but the shape `expand`
 * itself fast-paths, and the caller keeps `expand` for the rest.
 *
 * `forward` is returned rather than re-derived, so a caller cannot read the wrong endpoint off the
 * edge — the other half of the same mistake.
 */
export const directedBucket = (
  v: Vertex,
  rel: Adjacency,
): { readonly set: ReadonlySet<Edge>; readonly forward: boolean } | undefined => {
  const { label, direction } = rel;

  if (direction === 'both' || label?.kind !== 'label') {
    return undefined;
  }

  const forward = direction === 'out';
  // ⚠️ The vertex's CACHED box, not a string-keyed lookup — item 1618, which measured the three
  // ways at 59.7 ns / 30.5 / 16.1 over 200,000 vertices.
  const set = (forward ? v.adjFrom : v.adjTo)?.get(label.name);

  // An EMPTY bucket still returns a shape rather than `undefined`: `undefined` here means "this
  // pattern needs `expand`", and conflating that with "this vertex has no such edge" would send a
  // zero-degree vertex down the general path for no reason.
  return { set: set ?? EMPTY_EDGES, forward };
};

/** Shared so a zero-degree vertex allocates nothing. */
const EMPTY_EDGES: ReadonlySet<Edge> = new Set();

/**
 * ⚠️ `incidentEdges` / `farEnd` WERE HERE AND ARE GONE — item 1622 built them, measured them, and
 * REFUTED the lever. Do not re-attempt without reading `docs/reviews/CLOSED.md` item 1622.
 *
 * The idea was sound on paper: `expand` is a generator that allocates one `{ edge, node }` per edge
 * and it was **28.2%** of the three-segment row projection's profile, three times the next frame. An
 * edge-only iterable returning the raw adjacency `Set` for a directed single-type hop removes both
 * the allocation and the generator, and the far endpoint is derivable (`edge.from === v ? edge.to :
 * edge.from` is correct for `out`, `in` and a self-loop), so `walkSegments` could keep ONE loop body.
 *
 * What it measured, three runs an arm, one shape per process:
 *
 * ```text
 *    3 single-type segments   PRE 843.09 824.14 820.77   POST 741.68 773.52 756.15   1.09x
 *    3 `both` segments        PRE 711.84 707.74 703.92   POST 737.09 733.66 730.37   0.96x
 * ```
 *
 * **+9% on the admitted family and −3.7% on the declined one**, both with non-overlapping ranges.
 * The declined arm pays for it because the slow path then runs TWO generator layers — `expand`
 * wrapped in the edge-only adapter — where it used to run one. 9% in exchange for 4% elsewhere, in
 * the generic matcher, is not the trade `executor-edits-perturb` and item 1466 say to take.
 *
 * `directedBucket` below STAYS: item 1621 measured it at 1.83x where the caller loops the `Set`
 * directly, which is the version of this idea that pays.
 */

/**
 * Expand a single pattern segment from `v`, yielding every matching
 * `{ edge, node }`. `both` walks outgoing then incoming, matching the natural
 * read order of an undirected pattern.
 */
export const expand = function* (graph: Graph, v: Vertex, rel: Adjacency): Iterable<Step> {
  // A DIRECTED hop with a single concrete edge type reads its bucket directly,
  // instead of nesting `expand` -> `outSteps`/`inSteps` -> `edgesMatching` ->
  // `yield* set`: three generator layers plus a delegation to produce one
  // `{ edge, node }`. Identical output — `edgesMatching`'s own single-label fast
  // path is `byLabel.get(label.name)` and yields that set in the same order.
  //
  // Item 114 priced this at 1.2% and REJECTED it, against an isolated
  // micro-benchmark where a generator layer cost 8ns. That was the wrong
  // measurement: in this pipeline a resume costs ~40ns (10 nested layers,
  // megamorphic `next`), so the micro understated it 5x. Re-measured in situ in
  // item 119. An isolated micro UNDERSTATES a layer in a deep polymorphic
  // pipeline, the same way profiler self-time understates an allocation-heavy
  // frame (item 117).
  const { label } = rel;

  if (rel.direction !== 'both' && label?.kind === 'label') {
    const forward = rel.direction === 'out';
    /**
     * ⚠️ THE VERTEX'S OWN CACHED BOX, not a STRING-KEYED lookup into the graph (item 1618).
     *
     * This read `(forward ? graph.edgesFromByLabel : graph.edgesToByLabel).get(v.id)` — one hash of
     * an id string per expansion, on the hottest line of the matcher. `Vertex.adjFrom`/`adjTo`
     * memoize the SAME `Map` object the graph holds, and `adjacency-box.test.ts` exists for exactly
     * this: "every consumer that already holds the vertex object stops hashing (audit items 162,
     * 321)". Those items priced the three ways over 200,000 vertices — string key **59.7 ns**, a
     * `Map` keyed on the vertex object 30.5, a `WeakMap` 43.8, a **cached reference 16.1**.
     *
     * The Gremlin engine has read the box everywhere for ages; this is the GQL side adopting the
     * same access, and `expand` was **28.5%** of the two-hop row profile that found it.
     *
     * It changes nothing about O(1) access BY ID: `getVertexById` is untouched, and the box is the
     * same object the id-keyed map returns.
     */
    const bucket = (forward ? v.adjFrom : v.adjTo)?.get(label.name);

    if (bucket) {
      for (const edge of bucket) {
        yield { edge, node: forward ? edge.to : edge.from };
      }
    }

    return;
  }

  if (rel.direction === 'out' || rel.direction === 'both') {
    yield* outSteps(v, rel.label);
  }

  if (rel.direction === 'in' || rel.direction === 'both') {
    for (const step of inSteps(v, rel.label)) {
      // A self-loop is indexed under both `edgesFromByLabel` and
      // `edgesToByLabel` for `v`, so an undirected (`both`) walk would yield it
      // twice — once as an out-step, once as an in-step. The out-step already
      // emitted it; skip the duplicate. (Directed `in` keeps it.)
      if (rel.direction === 'both' && step.edge.from === step.edge.to) {
        continue;
      }

      yield step;
    }
  }
};

/**
 * Whether any edge — incoming or outgoing — is incident to `v`. Reads the same
 * adjacency indexes as `expand`. Used to enforce that a plain `DELETE` (without
 * `DETACH`) refuses to orphan relationships.
 *
 * ⚠️ BOTH BOXES, and that is load-bearing rather than defensive: a vertex with ONLY IN-edges is
 * incident, and reading `adjFrom` alone would let a plain `DELETE` silently orphan them. The mutant
 * that dropped `adjTo` SURVIVED item 1618's pass — no test deleted such a vertex — so it is pinned
 * now in `expand-reads-adjacency-box.test.ts`.
 *
 * The `graph` parameter is gone since item 1618: the boxes come off the vertex, so there was nothing
 * left to read from it.
 */
export const hasIncidentEdges = (v: Vertex): boolean => {
  for (const byLabel of [v.adjFrom, v.adjTo]) {
    if (!byLabel) {
      continue;
    }

    for (const set of byLabel.values()) {
      if (set.size > 0) {
        return true;
      }
    }
  }

  return false;
};

/** Evaluate an ISO label expression against a vertex's label set. */
const evalLabelExpr = (expr: LabelExpr, labels: ReadonlySet<string>): boolean => {
  switch (expr.kind) {
    case 'label':
      return labels.has(expr.name);
    case 'wildcard':
      return labels.size > 0; // `%` = has any label
    case 'not':
      return !evalLabelExpr(expr.expr, labels);
    case 'and':
      return evalLabelExpr(expr.left, labels) && evalLabelExpr(expr.right, labels);
    case 'or':
      return evalLabelExpr(expr.left, labels) || evalLabelExpr(expr.right, labels);
  }
};

/** Does a label set satisfy a label expression? (For the ISO `IS LABELED` test.) */
export const labelsMatch = (labels: ReadonlySet<string>, expr: LabelExpr): boolean =>
  evalLabelExpr(expr, labels);

/**
 * A node matches when it has no label constraint or its label set satisfies it.
 *
 * ⚠️ ITEM 1599 — TWO REJECTED LEVERS, and the ablation that made them look worth having.
 *
 * This is the most-called helper in the hot paths (~70 sites in `shortcuts.ts` and
 * `hop-projection.ts` alone), and after item 1598 took the predicate cost out from under it,
 * `evalLabelExpr` showed **46.1% SELF time** in a profile of the 400-hit seeded count. ⚠️ Item
 * 1597 had priced the same frame at "~1.1x, NOT a target" when it was 8.9% — a share is a share OF
 * something, and closing a neighbouring target re-prices it. So it was re-priced properly, by
 * ABLATION at `buildNodeCount`'s seeded loop (the test replaced with `() => true`: a wrong answer
 * measured only to price the right one):
 *
 * ```text
 *    with the label test      11968  12494  12110 ns
 *    ablated                   7804   8910   7829        1.53x
 *    the UNLABELLED query      7513   8019   7749        agrees, by a different route
 * ```
 *
 * **1.53x of that query is the label test**, confirmed twice. Both levers aimed at it FAILED:
 *
 * 1. **Compiling the test to a per-query closure** — item 1339's "answer it at the call site"
 *    applied to the label test: `(v) => v.labels.has(name)` resolved once, so neither
 *    `matchesLabel`'s `undefined` check nor `evalLabelExpr`'s `switch` is re-decided per element,
 *    plus folding the loop-invariant `seeded !== undefined` into the gate. Built, wired and
 *    measured **FLAT** (12110/12419/12895 against 11968/12494/12110). The dispatch was already
 *    being inlined, and `evalLabelExpr`'s 46% self-time is V8 charging it the inlined getter and
 *    `Set.has`. REVERTED rather than kept, since it buys nothing.
 * 2. **Testing by OBJECT IDENTITY against the label bucket** (`verticesByLabel.get(name).has(v)`),
 *    which skips the getter and the string hash both. `label-test-cost-probe.mjs` prices the three
 *    tests over the same 400 candidates, twice:
 *
 * ```text
 *    v.labels.has(name)   getter + string hash   5.52  5.48 ns
 *    hoisted Set          string hash only       3.25  3.29
 *    bucket.has(v)        object identity        3.95  3.92
 *    NULL CONTROL         no test at all         0.34  0.34
 * ```
 *
 * So identity is **slower than hoisting the getter** and worth ~1.6 ns a candidate over what the
 * engine does today — 400 × 1.6 ns is ~5% of the query. ⚠️ **That refutes the lever AND removes a
 * reason to settle the owner decision it was blocked on**: memory's `label-index-vs-setter` records
 * that `verticesByLabel` is not maintained by the `v.labels =` setter, so the bucket and `v.labels`
 * can disagree — and the engine already trusts the bucket on the UNSEEDED route of the same
 * function. That remains worth settling for CORRECTNESS, and is now known not to be worth anything
 * for speed.
 *
 * What is left of the 1.53x is not addressable from here. The test's own cost is 5.5 ns a candidate
 * of which only the ~2.2 ns getter could go, and the getter must be read per candidate. The
 * remaining ~5 ns a candidate is the test's PRESENCE in the loop rather than the test — the shape
 * `ts-closure-size-is-load-bearing` describes — which no change to this function can recover.
 */
export const matchesLabel = (v: Vertex, expr: LabelExpr | undefined): boolean =>
  expr === undefined || evalLabelExpr(expr, v.labels);

/**
 * A label the expression *guarantees* is present, usable to seed from a label
 * bucket. Conjunctions yield one of their sides; `or` / `not` / `%` can't
 * narrow, so they fall back to a full scan.
 */
const seedLabel = (expr: LabelExpr | undefined): string | null => {
  if (!expr) {
    return null;
  }

  switch (expr.kind) {
    case 'label':
      return expr.name;
    case 'and':
      return seedLabel(expr.left) ?? seedLabel(expr.right);
    default:
      return null;
  }
};

/** Candidate seed vertices for a node pattern, narrowed by its label expression. */
/**
 * The same narrowing as {@link candidateVertices}, handing back the UNDERLYING iterable rather
 * than wrapping it in a generator.
 *
 * `candidateVertices` pays a `yield*` frame per vertex, which is invisible in a micro and is not
 * invisible across 200,000 of them (audit item 164, and the generator note in item 136). Use
 * this where the consumer is a full-scan walk; `candidateVertices` stays for everything that
 * wants a generator.
 */
export const candidateVertexSource = (
  graph: Graph,
  label: LabelExpr | undefined,
): Iterable<Vertex> => {
  const seed = seedLabel(label);

  if (seed === null) {
    return graph.verticesById.values();
  }

  return graph.verticesByLabel.get(seed) ?? EMPTY_VERTICES;
};

const EMPTY_VERTICES: readonly Vertex[] = [];

export const candidateVertices = function* (
  graph: Graph,
  label: LabelExpr | undefined,
): Iterable<Vertex> {
  const seed = seedLabel(label);

  if (seed === null) {
    yield* graph.verticesById.values();

    return;
  }

  const bucket = graph.verticesByLabel.get(seed);

  if (bucket) {
    yield* bucket;
  }
};

/**
 * How many vertices `candidateVertices` would scan for this label — the label
 * bucket size, or the whole graph when no single label is guaranteed. A cheap
 * cardinality estimate for choosing which end of a pattern to seed from.
 */
export const candidateCount = (graph: Graph, label: LabelExpr | undefined): number => {
  const seed = seedLabel(label);

  if (seed === null) {
    return graph.verticesById.size;
  }

  return graph.verticesByLabel.get(seed)?.size ?? 0;
};
