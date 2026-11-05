import type { Edge } from '../core/Edge.js';

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
