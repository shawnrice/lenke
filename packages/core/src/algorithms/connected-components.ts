import type { Graph } from '../core/Graph.js';
import { type AlgorithmGen, defineAlgorithm, materializeVertices, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A weakly-connected-components result row: `{ node, componentId }`. */
export type ComponentRow = AlgorithmRow<'componentId', string>;

/** Union-find find with full path compression, over insertion-index slots. */
const find = (parent: Int32Array, x: number): number => {
  let root = x;

  while (parent[root] !== root) {
    root = parent[root];
  }

  let cur = x;

  while (parent[cur] !== root) {
    const next = parent[cur];
    parent[cur] = root;
    cur = next;
  }

  return root;
};

/** Union `a` and `b`, keeping the smaller-indexed root (deterministic). */
const union = (parent: Int32Array, a: number, b: number): void => {
  const ra = find(parent, a);
  const rb = find(parent, b);

  if (ra === rb) {
    return;
  }

  const keep = ra < rb ? ra : rb;
  const drop = ra < rb ? rb : ra;
  parent[drop] = keep;
};

const computeGen = function* (config: AlgorithmConfig, graph: Graph): AlgorithmGen<ComponentRow> {
  const { edgeLabel, writeProperty } = config;

  // Insertion index == native dense id, so smaller-index roots pick the same
  // representative vertex in both engines → identical component-id strings.
  const order = yield* materializeVertices(graph);
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  const parent = new Int32Array(order.length);

  for (let i = 0; i < order.length; i++) {
    parent[i] = i;
  }

  // Each edge unions its endpoints (undirected). A single flat sweep over all edges
  // (union-by-min is order-independent, so the components are identical to a
  // per-vertex sweep) is cheaper than walking the nested adjacency maps. A
  // named-but-unknown edge type matches nothing → every vertex stays its own
  // component.
  let sinceYield = 0;

  for (const edge of graph.edges) {
    if (edgeLabel === undefined || edge.labels.has(edgeLabel)) {
      union(parent, index.get(edge.from.id)!, index.get(edge.to.id)!);
    }

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  const rows: ComponentRow[] = [];

  for (const v of order) {
    const componentId = order[find(parent, index.get(v.id)!)].id;

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, componentId);
    }

    rows.push({ node: v.id, componentId });

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * Weakly-connected components via union-find — edges undirected, union by smaller
 * insertion index so each component id is its first-inserted vertex's external id.
 * Deterministic and exact. Resolves `Promise<ComponentRow[]>` without blocking the
 * event loop. Data-last dual-form: `connectedComponents(config, graph)` or
 * `connectedComponents(config)(graph)`.
 */
export const connectedComponents = defineAlgorithm(computeGen);
