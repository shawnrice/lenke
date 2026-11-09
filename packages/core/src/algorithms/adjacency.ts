import type { Edge } from '../core/Edge.js';
import type { Vertex } from '../core/Vertex.js';

/**
 * One direction of a vertex's edges, optionally restricted to a single edge type
 * — a `graph.edgesFromByLabel` / `edgesToByLabel` entry, which is a
 * `Map<edgeType, Set<Edge>>`.
 *
 * Edges are multi-label and the index buckets an edge under EVERY label it
 * carries, so the unrestricted case has to dedupe: unioning the buckets naively
 * yields a two-label edge twice, and every algorithm below counts one push per
 * edge (parallel edges and self-loops keep their multiplicity, matching the
 * native tally). Native walks a single adjacency list, so a duplicate here is a
 * cross-engine divergence, not merely a wrong number.
 *
 * The restricted case needs no dedupe — an edge is in a given label's bucket at
 * most once — and stays a single map lookup, which is the hot path.
 */
export const incidentEdges = function* (
  byLabel: Map<string, Set<Edge>> | undefined,
  edgeLabel: string | undefined,
): Iterable<Edge> {
  if (byLabel === undefined) {
    return;
  }

  if (edgeLabel !== undefined) {
    yield* byLabel.get(edgeLabel) ?? [];

    return;
  }

  // Only pay for the dedupe when more than one bucket can hold the same edge.
  if (byLabel.size === 1) {
    for (const set of byLabel.values()) {
      yield* set;
    }

    return;
  }

  const seen = new Set<Edge>();

  for (const set of byLabel.values()) {
    for (const edge of set) {
      if (!seen.has(edge)) {
        seen.add(edge);

        yield edge;
      }
    }
  }
};

/**
 * How many edges `incidentEdges` would yield, **assuming no edge carries more than one label** —
 * a sum of bucket sizes, so O(buckets) rather than O(edges), and no allocation.
 *
 * ⚠️ ONLY VALID UNDER `graph.multiTypeEdgeCount === 0`. The index buckets an edge under every label
 * it carries, so a two-label edge is counted twice here. That gate is the exact condition (it counts
 * edges carrying more than one label), which is why this is a separate function rather than a flag
 * on {@link countIncidentEdges}: the unsafe case should not be reachable by passing `false`.
 *
 * It exists so a CSR build can size its output in a cheap counting pass and then fill a typed array
 * directly, instead of accumulating one intermediate array per vertex.
 */
export const countIncidentEdgesFlat = (
  byLabel: Map<string, Set<Edge>> | undefined,
  edgeLabel: string | undefined,
): number => {
  if (byLabel === undefined) {
    return 0;
  }

  if (edgeLabel !== undefined) {
    return byLabel.get(edgeLabel)?.size ?? 0;
  }

  let n = 0;

  for (const set of byLabel.values()) {
    n += set.size;
  }

  return n;
};

/**
 * Write each incident edge's `end` endpoint, resolved through `index`, straight into `out` starting
 * at `at`; returns the cursor just past the last write. The direct-iteration counterpart of
 * {@link incidentEdges} — no generator frame, no intermediate array.
 *
 * ⚠️ ONLY VALID UNDER `graph.multiTypeEdgeCount === 0`, for the same reason as
 * {@link countIncidentEdgesFlat}, and it must be paired with that function so the count it wrote
 * against and the count written here cannot disagree.
 *
 * Bucket order and within-bucket order match `incidentEdges` exactly, so the adjacency this produces
 * is identical to the one built through the generator — which byte-identity with the native engine
 * requires, since a permuted neighbour list changes a tie-break.
 *
 * ⚠️ REJECTED, WITH NUMBERS — `index.get(edge.toId)` INSTEAD OF `index.get(edge[end].id)`
 * (item 1722). This profiled at 23.13% of `labelPropagation` and ~172 ns per index write, where a
 * typed-array store is ~1 ns, and `edge.to` / `edge.from` are getters that call
 * `graph.getVertexById(...)` on first touch — item 194 priced a string-keyed `Map.get` at
 * ~190 ns. `edge.toId` / `fromId` are a bare private-field read, `Edge` documents them as "the
 * endpoint IDS, without materializing the vertices", and `neighborAggregate`'s build already uses
 * them. Answer-identical by construction: `to` is resolved BY that id.
 *
 * It measures NOTHING. One algorithm per process, two rounds, 40,000 vertices:
 *
 * ```text
 *     algorithm              PRE           POST          ratio
 *     labelPropagation    71.78/69.40   68.27/68.87   1.051x / 1.008x   <- the only row it reaches
 *     connectedComponents  8.46/8.47     7.15/8.16    1.183x / 1.038x   <- CONTROL
 *     degree              14.47/12.88   13.39/12.26   1.081x / 1.051x   <- CONTROL
 * ```
 *
 * ⚠️ THE TARGET MOVED LESS THAN BOTH CONTROLS. Only `label-propagation.ts` uses this function,
 * so `connectedComponents` and `degree` cannot reach the change, and they moved MORE — drift.
 *
 * AND THE MECHANISM IS NOT WHAT THE ARITHMETIC SUGGESTED. `addEdge` is normally handed VERTEX
 * objects, so `#fromV`/`#toV` are populated at construction and no lookup ever runs in this fill.
 * On a DESERIALIZED graph the first touch is lazy, but it costs ~10 ns an edge, not ~190: a fresh
 * pass over `edge.to.id` reads 4.3 ms against 2.7 warm over 160,000 edges. That caps the whole
 * change at ~3 ms of a 68 ms run (~4%), under this instrument's drift.
 *
 * So the ~172 ns a write is the Set iteration and the generator machinery — the CALLER's loop
 * credited to a small callee, which is the same trap `bucketSize` has now mis-nominated itself with
 * three times (items 1416/1637/1719). A per-write cost that implies a hash lookup where none can be
 * happening is the tell.
 */
export const writeIncidentEnds = (
  byLabel: Map<string, Set<Edge>> | undefined,
  end: 'to' | 'from',
  edgeLabel: string | undefined,
  index: Map<string, number>,
  out: Int32Array,
  at: number,
): number => {
  if (byLabel === undefined) {
    return at;
  }

  let w = at;

  if (edgeLabel !== undefined) {
    const bucket = byLabel.get(edgeLabel);

    if (bucket !== undefined) {
      for (const edge of bucket) {
        out[w] = index.get(edge[end].id)!;
        w += 1;
      }
    }

    return w;
  }

  for (const set of byLabel.values()) {
    for (const edge of set) {
      out[w] = index.get(edge[end].id)!;
      w += 1;
    }
  }

  return w;
};

/** How many distinct edges `incidentEdges` would yield. */
export const countIncidentEdges = (
  byLabel: Map<string, Set<Edge>> | undefined,
  edgeLabel: string | undefined,
): number => {
  if (byLabel === undefined) {
    return 0;
  }

  if (edgeLabel !== undefined) {
    return byLabel.get(edgeLabel)?.size ?? 0;
  }

  if (byLabel.size === 1) {
    let n = 0;

    for (const set of byLabel.values()) {
      n += set.size;
    }

    return n;
  }

  const seen = new Set<Edge>();

  for (const set of byLabel.values()) {
    for (const edge of set) {
      seen.add(edge);
    }
  }

  return seen.size;
};

/**
 * An integer RANK per vertex in EXTERNAL-ID order, so a tie-break on "smallest external id" is an
 * int compare instead of two `Vertex.id` getter reads and a string compare (item 1625).
 *
 * ⚠️ WHY IT IS WORTH A PRECOMPUTE. `labelPropagation` and `peerPressure` both resolve a tie on the
 * smallest external id, inside a loop that runs per tie, per vertex, per round — and at fanout 2
 * almost every vertex ties (two neighbours, two distinct labels, both counted once), so it ran on
 * nearly every vertex of every round. `labelPropagation` is the slowest procedure per vertex in
 * `algo-scaling-bench.mjs` by a wide margin, and ablating the whole tie-break from it — a WRONG
 * ANSWER measured only to price it — moved it **136.4 ms to 112.5, 1.20x**:
 *
 * ```text
 *    control (7 runs)        134.76 - 139.63 ms   median 136.44
 *    ids[] hoisted only      130.15 - 132.01      median 131.95    1.034x
 *    this rank              123.80 - 126.55      median 125.41    1.088x
 *    tie-break ABLATED      112.47 - 112.60                       1.20x (the ceiling)
 * ```
 *
 * Removing only the two GETTERS recovered 3.4%, so the STRING COMPARE was the bulk of it — which is
 * why this ranks rather than just hoisting the ids. The remaining ~10% of the ceiling is the dirty
 * loop itself, which the ablation also removed.
 *
 * ⚠️ `rank[a] < rank[b]` IFF `ids[a] < ids[b]`, because ranks are assigned in id order and vertex
 * ids are UNIQUE — so the tie-break can never itself tie and the contract is unchanged. The sort
 * uses the same `<`/`>` on strings the loops used, so the order is identical by construction rather
 * than by a second definition of "lexicographic".
 *
 * The cost is one O(V log V) sort of V string compares per call, against O(rounds x E) in the loop.
 */
export const idRank = (order: readonly Vertex[]): Int32Array => {
  const n = order.length;
  const ids: string[] = new Array<string>(n);
  const byId: number[] = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    ids[i] = order[i].id;
    byId[i] = i;
  }

  byId.sort((a, b) => compareIds(ids[a], ids[b]));

  const rank = new Int32Array(n);

  for (let p = 0; p < n; p++) {
    rank[byId[p]] = p;
  }

  return rank;
};

/** Its own function because a nested ternary is a lint error, and the rule is right here. */
const compareIds = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};
