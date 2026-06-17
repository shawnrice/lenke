import type { Graph, Vertex } from '@pl-graph/core';

import type { Step } from '../ast.js';
import { bothEdgesOf } from '../graph-queries.js';

import { applyPlanToStream } from './dispatch.js';
import { otherEndpoint } from './movement.js';
import {
  extend,
  hasAny,
  isVertex,
  type RunContext,
  startTraverser,
  type Traverser,
} from './runtime.js';

/**
 * All shortest (fewest-hop) vertex paths from `src` to each destination, as
 * vertex arrays `[src, …, dest]`. Unweighted BFS over incident edges (both
 * directions). `targets` (null ⇒ every reached vertex) filters destinations.
 * Equal-length alternatives are all returned (a predecessor DAG is tracked).
 */
const shortestPathsFrom = (
  graph: Graph,
  src: Vertex,
  targets: ReadonlySet<string> | null,
): Vertex[][] => {
  const dist = new Map<string, number>([[src.id, 0]]);
  const preds = new Map<string, Vertex[]>(); // id → predecessors on a shortest path
  const byId = new Map<string, Vertex>([[src.id, src]]);
  let frontier: Vertex[] = [src];
  while (frontier.length > 0) {
    const next: Vertex[] = [];
    for (const v of frontier) {
      const d = dist.get(v.id)!;
      for (const e of bothEdgesOf(graph, v)) {
        const n = otherEndpoint('both', e, v);
        const nd = dist.get(n.id);
        if (nd === undefined) {
          dist.set(n.id, d + 1);
          preds.set(n.id, [v]);
          byId.set(n.id, n);
          next.push(n);
        } else if (nd === d + 1) {
          preds.get(n.id)!.push(v); // another equally-short predecessor
        }
      }
    }
    frontier = next;
  }
  // Reconstruct every shortest path to each destination by walking predecessors.
  const paths: Vertex[][] = [];
  const build = (id: string, tail: Vertex[]): void => {
    const path = [byId.get(id)!, ...tail];
    if (id === src.id) {
      paths.push(path);
      return;
    }
    for (const p of preds.get(id) ?? []) {
      build(p.id, path);
    }
  };
  for (const id of dist.keys()) {
    if (!targets || targets.has(id)) {
      build(id, []);
    }
  }
  return paths;
};

export const shortestPathStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'shortestPath' }>,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  // Resolve the destination set once: run the target sub-plan over every vertex.
  let targets: Set<string> | null = null;
  if (step.target) {
    targets = new Set();
    for (const v of graph.vertices) {
      if (hasAny(applyPlanToStream(step.target!, [startTraverser(v)], graph))) {
        targets.add(v.id);
      }
    }
  }
  for (const t of stream) {
    if (!isVertex(t.value)) {
      continue;
    }
    for (const path of shortestPathsFrom(graph, t.value, targets)) {
      yield extend(t, path);
    }
  }
};
