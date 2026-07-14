import type { Graph } from '../core/Graph.js';
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

const compute = (config: AlgorithmConfig, graph: Graph): ComponentRow[] => {
  const { edgeLabel, writeProperty } = config;

  // Insertion index == native dense id, so smaller-index roots pick the same
  // representative vertex in both engines → identical component-id strings.
  const order = [...graph.vertices];
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  const parent = new Int32Array(order.length);

  for (let i = 0; i < order.length; i++) {
    parent[i] = i;
  }

  // Each out-edge unions its endpoints (undirected). A named-but-unknown edge
  // type simply has no adjacency entries → every vertex stays its own component.
  for (const v of order) {
    const byLabel = graph.edgesFromByLabel.get(v.id);

    if (byLabel === undefined) {
      continue;
    }

    const sets = edgeLabel === undefined ? byLabel.values() : [byLabel.get(edgeLabel)];

    for (const set of sets) {
      if (set === undefined) {
        continue;
      }

      for (const edge of set) {
        union(parent, index.get(edge.from.id)!, index.get(edge.to.id)!);
      }
    }
  }

  const rows: ComponentRow[] = [];

  for (const v of order) {
    const componentId = order[find(parent, index.get(v.id)!)].id;

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, componentId);
    }

    rows.push({ node: v.id, componentId });
  }

  return rows;
};

/**
 * Weakly-connected components via union-find — edges undirected, union by smaller
 * insertion index so each component id is its first-inserted vertex's external id.
 * Deterministic and exact. Data-last dual-form: `connectedComponents(config,
 * graph)` or `connectedComponents(config)(graph)`.
 */
export function connectedComponents(config: AlgorithmConfig): (graph: Graph) => ComponentRow[];
export function connectedComponents(config: AlgorithmConfig, graph: Graph): ComponentRow[];
export function connectedComponents(
  config: AlgorithmConfig,
  graph?: Graph,
): ComponentRow[] | ((graph: Graph) => ComponentRow[]) {
  return graph ? compute(config, graph) : (g: Graph) => compute(config, g);
}
