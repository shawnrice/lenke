import type { Edge, Graph, Vertex } from '@lenke/core';

import { bothEdgesOf, inEdgesOf, outEdgesOf } from '../graph-queries.js';
import { extend, isEdge, isVertex, type Traverser } from './runtime.js';

export type AdjacencyKind = 'out' | 'in' | 'both' | 'outE' | 'inE' | 'bothE';

export const adjacentEdges = (
  kind: AdjacencyKind,
  graph: Graph,
  v: Vertex,
  labels: readonly string[],
): Iterable<Edge> => {
  switch (kind) {
    case 'out':
    case 'outE':
      return outEdgesOf(graph, v, labels);
    case 'in':
    case 'inE':
      return inEdgesOf(graph, v, labels);
    case 'both':
    case 'bothE':
      return bothEdgesOf(graph, v, labels);
  }
};

export const otherEndpoint = (kind: 'out' | 'in' | 'both', edge: Edge, v: Vertex): Vertex => {
  switch (kind) {
    case 'out':
      return edge.to;
    case 'in':
      return edge.from;
    case 'both':
      return edge.fromId === v.id ? edge.to : edge.from;
  }
};

export const traverseToVertex = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  step: { kind: 'out' | 'in' | 'both'; labels: readonly string[] },
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    // A vertex step on a NON-VERTEX yields nothing — matching the native engine, which
    // is lenient here (unlike the edge→vertex steps below, which fault on a non-edge).
    if (!isVertex(t.value)) {
      continue;
    }

    const v = t.value;

    for (const e of adjacentEdges(step.kind, graph, v, step.labels)) {
      yield extend(t, otherEndpoint(step.kind, e, v));
    }
  }
};

export const traverseToEdge = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  step: { kind: 'outE' | 'inE' | 'bothE'; labels: readonly string[] },
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value)) {
      continue;
    }

    const v = t.value;

    for (const e of adjacentEdges(step.kind, graph, v, step.labels)) {
      yield extend(t, e);
    }
  }
};

export const edgeToVertex = function* (
  stream: Iterable<Traverser<unknown>>,
  step: { kind: 'outV' | 'inV' | 'bothV' | 'otherV' },
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isEdge(t.value)) {
      continue;
    }

    const e = t.value;

    if (step.kind === 'outV') {
      yield extend(t, e.from);
    } else if (step.kind === 'inV') {
      yield extend(t, e.to);
    } else if (step.kind === 'bothV') {
      yield extend(t, e.from);

      yield extend(t, e.to);
    } else {
      // otherV — find the previous vertex in the path and emit the other endpoint.
      const prev = [...t.path].reverse().find((p): p is Vertex => isVertex(p));
      const other = prev?.id === e.fromId ? e.to : e.from;

      yield extend(t, other);
    }
  }
};

/**
 * THE ONE ADJACENCY BUCKET a directed single-type hop reads, with the direction, or `undefined` for
 * every other hop shape (item 1628).
 *
 * ⚠️ WHY A CALLER WANTS IT INSTEAD OF `adjacentEdges` + `otherEndpoint`. Those two are a generator
 * chain — `adjacentEdges` delegates into `iterByLabel` which delegates into `iterLabeled` — and
 * `hop-values.ts`' header prices the chain at **375.6 ms against a hand walk's 251, 1.50x**. Item
 * 1480's profile of `optional(out(T)).values(k)` puts **~61%** of that shape in it:
 *
 * ```text
 *    otherEndpoint 20.97%   iterLabeled 19.47%   get to 7.57%
 *    traverseToVertex 5.41%   iterByLabel 4.21%   outEdgesOf 3.25%
 * ```
 *
 * For a directed single-type hop there is exactly one `Set` and nothing to dedupe, so a caller that
 * loops it pays neither the delegation nor the per-edge `{edge, node}` the step form allocates.
 *
 * ⚠️ IT REFUSES EVERYTHING ELSE, AND THAT IS THE LOAD-BEARING HALF. `both` walks out-bucket then
 * in-bucket per vertex and drops a self-loop's duplicate; a multi-type hop needs the cross-bucket
 * dedupe (`detectGroupedHopCount`'s own note records a `T|S` edge counted TWICE when that was
 * hand-rolled); an untyped hop walks every bucket. All three keep `adjacentEdges`.
 *
 * `forward` is returned rather than re-derived so a caller cannot read the wrong end off the edge —
 * the other half of the same mistake.
 */
export const soleTypeBucket = (
  v: Vertex,
  kind: 'out' | 'in' | 'both',
  labels: readonly string[],
): { readonly set: ReadonlySet<Edge>; readonly forward: boolean } | undefined => {
  if (kind === 'both' || labels.length !== 1) {
    return undefined;
  }

  const forward = kind === 'out';
  // The vertex's CACHED box, not a string-keyed lookup into the graph — items 162/321 price the
  // three ways at 59.7 ns / 30.5 / 16.1 over 200,000 vertices.
  const set = (forward ? v.adjFrom : v.adjTo)?.get(labels[0]);

  // An EMPTY bucket still returns a shape: `undefined` here means "this hop needs `adjacentEdges`",
  // and conflating that with "this vertex has no such edge" would send a zero-degree vertex down the
  // general path for nothing.
  return { set: set ?? EMPTY_EDGES, forward };
};

/** Shared so a zero-degree vertex allocates nothing. */
const EMPTY_EDGES: ReadonlySet<Edge> = new Set();
