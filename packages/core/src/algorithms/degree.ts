import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A degree-centrality result row: `{ node, degree }`. */
export type DegreeRow = AlgorithmRow<'degree', number>;

/**
 * Count a vertex's incident edges in one direction, optionally restricted to a
 * single edge type. `byLabel` is the vertex's `edgesFromByLabel` /
 * `edgesToByLabel` entry — a `Map<edgeType, Set<Edge>>`.
 */
const countDir = (byLabel: Map<string, Set<Edge>> | undefined, edgeLabel?: string): number => {
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

const compute = (config: AlgorithmConfig, graph: Graph): DegreeRow[] => {
  const { edgeLabel, direction = 'out', writeProperty } = config;
  const rows: DegreeRow[] = [];

  // Insertion order (= native dense-vertex-id order), so results are row-identical.
  for (const vertex of graph.vertices) {
    const out = () => countDir(graph.edgesFromByLabel.get(vertex.id), edgeLabel);
    const inc = () => countDir(graph.edgesToByLabel.get(vertex.id), edgeLabel);
    // "both" sums out + in — a self-loop counts once each way, matching native.
    let degree = out();

    if (direction === 'in') {
      degree = inc();
    } else if (direction === 'both') {
      degree = out() + inc();
    }

    if (writeProperty !== undefined) {
      vertex.setProperty(writeProperty, degree);
    }

    rows.push({ node: vertex.id, degree });
  }

  return rows;
};

/**
 * Degree centrality — per-vertex count of incident edges (out by default, in, or
 * both), optionally over a single `edgeLabel`. O(V + E), in insertion order.
 * Data-last dual-form: `degree(config, graph)` or `degree(config)(graph)`.
 */
export function degree(config: AlgorithmConfig): (graph: Graph) => DegreeRow[];
export function degree(config: AlgorithmConfig, graph: Graph): DegreeRow[];
export function degree(
  config: AlgorithmConfig,
  graph?: Graph,
): DegreeRow[] | ((graph: Graph) => DegreeRow[]) {
  return graph ? compute(config, graph) : (g: Graph) => compute(config, g);
}
