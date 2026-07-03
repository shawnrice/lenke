import type { Edge, Graph, Vertex } from '@lenke/core';

/**
 * Vertex-centric adjacency queries used by the gremlin executor. These belong
 * here, not on `core/Graph`, because "out/in/both" is traversal vocabulary —
 * a different query language (Cypher, GQL) would express adjacency in its own
 * terms over the same underlying `from`/`to` edges.
 *
 * All three read from core's existing indexes
 * (`edgesFromByLabel` / `edgesToByLabel`) for O(1) per-label lookup.
 */

export const outEdgesOf = (
  graph: Graph,
  v: Vertex,
  labels: readonly string[] = [],
): Iterable<Edge> => iterByLabel(graph.edgesFromByLabel.get(v.id), labels);

export const inEdgesOf = (
  graph: Graph,
  v: Vertex,
  labels: readonly string[] = [],
): Iterable<Edge> => iterByLabel(graph.edgesToByLabel.get(v.id), labels);

export const bothEdgesOf = (
  graph: Graph,
  v: Vertex,
  labels: readonly string[] = [],
): Iterable<Edge> =>
  iterBoth(graph.edgesFromByLabel.get(v.id), graph.edgesToByLabel.get(v.id), labels);

// With labels, yield edges per label (in label-arg order). With no labels,
// yield every edge once across all label-buckets — an edge that's indexed
// under multiple labels still only emits once.
const iterByLabel = function* (
  byLabel: Map<string, Set<Edge>> | undefined,
  labels: readonly string[],
): Iterable<Edge> {
  if (!byLabel) {
    return;
  }

  if (labels.length > 0) {
    yield* iterLabeled(byLabel, labels);

    return;
  }

  yield* iterAllDeduped(byLabel);
};

const iterLabeled = function* (
  byLabel: Map<string, Set<Edge>>,
  labels: readonly string[],
): Iterable<Edge> {
  for (const label of labels) {
    const set = byLabel.get(label);

    if (set) {
      yield* set;
    }
  }
};

const iterAllDeduped = function* (byLabel: Map<string, Set<Edge>>): Iterable<Edge> {
  const seen = new Set<Edge>();

  for (const set of byLabel.values()) {
    for (const e of set) {
      if (seen.has(e)) {
        continue;
      }

      seen.add(e);

      yield e;
    }
  }
};

// Out-edges first, then in-edges, to match TinkerPop's `both`/`bothE` ordering.
// Within each direction, iteration follows label-arg order (or insertion order
// when no labels are given).
const iterBoth = function* (
  fromByLabel: Map<string, Set<Edge>> | undefined,
  toByLabel: Map<string, Set<Edge>> | undefined,
  labels: readonly string[],
): Iterable<Edge> {
  yield* iterByLabel(fromByLabel, labels);

  yield* iterByLabel(toByLabel, labels);
};
