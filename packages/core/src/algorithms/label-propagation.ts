import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A label-propagation result row: `{ node, label }`. */
export type LabelRow = AlgorithmRow<'label', string>;

const DEFAULT_ITERATIONS = 10;

/**
 * Yield the id of each neighbour reachable from a vertex's adjacency entry
 * (`edgesFromByLabel`/`edgesToByLabel` value), optionally restricted to one edge
 * type. `end` picks which endpoint is the neighbour ('to' for out-edges, 'from'
 * for in-edges). One yield per edge, so parallel edges / self-loops count with
 * multiplicity — matching the native per-Adj tally.
 */
const neighbourIds = function* (
  byLabel: Map<string, Set<Edge>> | undefined,
  edgeLabel: string | undefined,
  end: 'to' | 'from',
): Iterable<string> {
  if (byLabel === undefined) {
    return;
  }

  const sets = edgeLabel === undefined ? byLabel.values() : [byLabel.get(edgeLabel)];

  for (const set of sets) {
    if (set === undefined) {
      continue;
    }

    for (const edge of set) {
      yield edge[end].id;
    }
  }
};

const compute = (config: AlgorithmConfig, graph: Graph): LabelRow[] => {
  const { edgeLabel, writeProperty, iterations = DEFAULT_ITERATIONS } = config;

  // Insertion order == native dense-id order. Every vertex starts labelled with
  // its own external id (a known/unknown edge type with no edges simply leaves
  // labels untouched — same as native skipping propagation).
  const order = [...graph.vertices];
  let labels = new Map<string, string>();

  for (const v of order) {
    labels.set(v.id, v.id);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, string>();

    for (const v of order) {
      // Tally neighbour labels from the frozen `labels` snapshot (undirected).
      const counts = new Map<string, number>();

      const bump = (id: string): void => {
        const lbl = labels.get(id)!;
        counts.set(lbl, (counts.get(lbl) ?? 0) + 1);
      };

      for (const id of neighbourIds(graph.edgesFromByLabel.get(v.id), edgeLabel, 'to')) {
        bump(id);
      }

      for (const id of neighbourIds(graph.edgesToByLabel.get(v.id), edgeLabel, 'from')) {
        bump(id);
      }

      // Adopt the most-frequent label; tie → lexicographically smallest. No
      // neighbours → keep the current label.
      let best: string | undefined;
      let bestCount = 0;

      for (const [lbl, c] of counts) {
        if (best === undefined || c > bestCount || (c === bestCount && lbl < best)) {
          best = lbl;
          bestCount = c;
        }
      }

      next.set(v.id, best ?? labels.get(v.id)!);
    }

    labels = next;
  }

  const rows: LabelRow[] = [];

  for (const v of order) {
    const label = labels.get(v.id)!;

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, label);
    }

    rows.push({ node: v.id, label });
  }

  return rows;
};

/**
 * Synchronous label propagation (community detection) — each vertex starts
 * labelled with its own external id and each round adopts the most-frequent
 * neighbour label (edges undirected), ties broken by the smallest label string,
 * for a fixed `iterations` count (default 10). Deterministic and exact.
 * Data-last dual-form: `labelPropagation(config, graph)` or
 * `labelPropagation(config)(graph)`.
 */
export function labelPropagation(config: AlgorithmConfig): (graph: Graph) => LabelRow[];
export function labelPropagation(config: AlgorithmConfig, graph: Graph): LabelRow[];
export function labelPropagation(
  config: AlgorithmConfig,
  graph?: Graph,
): LabelRow[] | ((graph: Graph) => LabelRow[]) {
  return graph ? compute(config, graph) : (g: Graph) => compute(config, g);
}
