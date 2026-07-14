import type { Graph } from '../core/Graph.js';

/**
 * Configuration accepted by the graph algorithms — a superset; each algorithm
 * reads only the fields it needs, and every field is optional (sensible
 * defaults). This is the exact shape the native engine deserializes on the FFI
 * boundary, so a config object is portable between the TS core and the native
 * `RustGraph` algorithm methods verbatim.
 */
export type AlgorithmConfig = {
  /** Restrict traversal to one edge type; omitted = every edge type. */
  edgeLabel?: string;
  /** Degree direction — `'out'` (default) / `'in'` / `'both'`. */
  direction?: 'out' | 'in' | 'both';
  /** Numeric edge property to weight by (PageRank / weighted shortest path). */
  weightProperty?: string;
  /** PageRank damping factor (default 0.85). */
  dampingFactor?: number;
  /** Fixed iteration count (PageRank / label propagation). */
  iterations?: number;
  /** Source vertex external id (shortest path). */
  source?: string;
  /** Target vertex external id (goal-directed shortest path). */
  target?: string;
  /** If set, each vertex's result is written to this property before returning. */
  writeProperty?: string;
  /** Shortest-path backend — `'dijkstra'` (default) / `'astar'` / `'bmssp'`. */
  algorithm?: 'dijkstra' | 'astar' | 'bmssp';
  /** Admissible-heuristic vertex property for A*. */
  heuristicProperty?: string;
};

/**
 * A single algorithm result row: the vertex's external id plus one result
 * column whose name varies by algorithm (`degree`, `score`, `componentId`,
 * `label`, `distance`). Mirrors the native `{columns, rows}` RowSet exactly.
 */
export type AlgorithmRow<K extends string, V> = { node: string } & Record<K, V>;

/**
 * Data-last, dual-form graph algorithm — call it directly `algo(config, graph)`
 * or curried `algo(config)(graph)` (the latter composes under `pipe`). Matches
 * the `@lenke/fp` convention: passing the graph applies it, omitting it returns
 * the partially-applied function awaiting a graph. Always resolves a `Promise`, so
 * a long run never blocks the event loop.
 */
export type GraphAlgorithm<Row> = {
  (config: AlgorithmConfig): (graph: Graph) => Promise<Row[]>;
  (config: AlgorithmConfig, graph: Graph): Promise<Row[]>;
};
