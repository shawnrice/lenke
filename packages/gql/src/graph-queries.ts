import type { Edge, Graph, Vertex } from '@pl-graph/core';

import type { LabelExpr, RelPattern } from './ast.js';

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

const outSteps = function* (graph: Graph, v: Vertex, label: LabelExpr | undefined): Iterable<Step> {
  for (const edge of edgesMatching(graph.edgesFromByLabel.get(v.id), label)) {
    yield { edge, node: edge.to };
  }
};

const inSteps = function* (graph: Graph, v: Vertex, label: LabelExpr | undefined): Iterable<Step> {
  for (const edge of edgesMatching(graph.edgesToByLabel.get(v.id), label)) {
    yield { edge, node: edge.from };
  }
};

/**
 * Expand a single pattern segment from `v`, yielding every matching
 * `{ edge, node }`. `both` walks outgoing then incoming, matching the natural
 * read order of an undirected pattern.
 */
export const expand = function* (graph: Graph, v: Vertex, rel: RelPattern): Iterable<Step> {
  if (rel.direction === 'out' || rel.direction === 'both') {
    yield* outSteps(graph, v, rel.label);
  }
  if (rel.direction === 'in' || rel.direction === 'both') {
    yield* inSteps(graph, v, rel.label);
  }
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

/** A node matches when it has no label constraint or its label set satisfies it. */
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
