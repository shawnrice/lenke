import type { Graph } from '../core/Graph.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A PageRank result row: `{ node, score }`. */
export type PageRankRow = AlgorithmRow<'score', number>;

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 20;

const compute = (config: AlgorithmConfig, graph: Graph): PageRankRow[] => {
  const {
    edgeLabel,
    weightProperty,
    writeProperty,
    dampingFactor: d = DEFAULT_DAMPING,
    iterations = DEFAULT_ITERATIONS,
  } = config;

  const order = [...graph.vertices];
  const n = order.length;

  if (n === 0) {
    return [];
  }

  const nf = n;
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  // A named-but-unknown edge type matches no edge → every vertex is dangling and
  // converges to a uniform 1/N (handled naturally by the loop below).
  const typeOk = (edge: { labels: Set<string> }): boolean =>
    edgeLabel === undefined || edge.labels.has(edgeLabel);
  const weightOf = (edge: { getProperty: (k: string) => unknown }): number => {
    if (weightProperty === undefined) {
      return 1;
    }

    const w = edge.getProperty(weightProperty);

    return typeof w === 'number' ? w : 0;
  };

  // Pass 1: out-strength per source, accumulated in edge-insertion order — the
  // exact sequence the native engine scans (dense eidx == edgesById order).
  const outStrength = new Float64Array(n);

  for (const edge of graph.edges) {
    if (typeOk(edge)) {
      outStrength[index.get(edge.from.id)!] += weightOf(edge);
    }
  }

  // Pass 2: per-target contribution list (source index, weight/out-strength),
  // pushed in edge-insertion order so each target's later sum is order-canonical.
  const incoming: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);

  for (const edge of graph.edges) {
    if (!typeOk(edge)) {
      continue;
    }

    const src = index.get(edge.from.id)!;
    const factor = weightOf(edge) / outStrength[src];
    incoming[index.get(edge.to.id)!].push([src, factor]);
  }

  let pr = new Float64Array(n).fill(1 / nf);

  for (let iter = 0; iter < iterations; iter++) {
    // Dangling mass: Σ pr[u] over out-strength-0 vertices, in vertex order.
    let dangling = 0;

    for (let u = 0; u < n; u++) {
      if (outStrength[u] === 0) {
        dangling += pr[u];
      }
    }

    const base = (1 - d) / nf + (d * dangling) / nf;
    const next = new Float64Array(n);

    for (let v = 0; v < n; v++) {
      let sum = 0;

      for (const [u, factor] of incoming[v]) {
        sum += pr[u] * factor;
      }

      next[v] = base + d * sum;
    }

    pr = next;
  }

  const rows: PageRankRow[] = [];

  order.forEach((v, i) => {
    const score = pr[i];

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, score);
    }

    rows.push({ node: v.id, score });
  });

  return rows;
};

/**
 * PageRank (pull model, f64) — `pr'[v] = (1−d)/N + d·Σ pr[u]·w(u→v)/S[u] +
 * d·dangling/N` for a fixed `iterations` (default 20), damping `dampingFactor`
 * (default 0.85), optionally weighted by `weightProperty` and filtered to
 * `edgeLabel`. Every f64 accumulation is taken in global edge-insertion order, so
 * scores are byte-identical to the native engine. Data-last dual-form:
 * `pagerank(config, graph)` or `pagerank(config)(graph)`.
 */
export function pagerank(config: AlgorithmConfig): (graph: Graph) => PageRankRow[];
export function pagerank(config: AlgorithmConfig, graph: Graph): PageRankRow[];
export function pagerank(
  config: AlgorithmConfig,
  graph?: Graph,
): PageRankRow[] | ((graph: Graph) => PageRankRow[]) {
  return graph ? compute(config, graph) : (g: Graph) => compute(config, g);
}
