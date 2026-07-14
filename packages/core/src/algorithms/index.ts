// In-engine graph algorithms as data-last, dual-form free functions over the
// public TS `Graph` surface (vertices, adjacency, get/setProperty) — so each
// doubles as a worked example of the "escape hatch": a user writes their own the
// exact same way. Each mirrors the native `@lenke/native` implementation
// vertex-for-vertex (insertion order, no sorting) so results are byte-identical.
export type { AlgorithmConfig, AlgorithmRow, GraphAlgorithm } from './types.js';
export { degree, type DegreeRow } from './degree.js';
export { connectedComponents, type ComponentRow } from './connected-components.js';
export { labelPropagation, labelPropagationAsync, type LabelRow } from './label-propagation.js';
export { pagerank, pagerankAsync, type PageRankRow } from './pagerank.js';
export { shortestPath, type ShortestPathRow } from './shortest-path.js';
