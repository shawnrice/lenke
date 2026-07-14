import type { Graph } from '../core/Graph.js';
import { type AlgorithmGen, asyncAlgorithm, drainSync } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A PageRank result row: `{ node, score }`. */
export type PageRankRow = AlgorithmRow<'score', number>;

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 20;

const computeGen = function* (config: AlgorithmConfig, graph: Graph): AlgorithmGen<PageRankRow> {
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

  // Pass 1 (single sweep in edge-insertion order — the exact sequence native scans,
  // dense eidx == edgesById order): out-strength per source, in-degree per target,
  // and — when weighted — each edge's weight cached once so pass 2 doesn't re-read
  // the property (halving `getProperty` calls).
  const weighted = weightProperty !== undefined;
  const outStrength = new Float64Array(n);
  const incOff = new Int32Array(n + 1);
  const edgeW: number[] = [];

  for (const edge of graph.edges) {
    const w = weightOf(edge);

    if (weighted) {
      edgeW.push(w);
    }

    if (typeOk(edge)) {
      outStrength[index.get(edge.from.id)!] += w;
      incOff[index.get(edge.to.id)! + 1]++;
    }
  }

  // Pass 2: per-target contribution lists as a flat CSR — `incOff[v]..incOff[v+1]`
  // indexes `(incSrc, incFac)` for target v, filled in edge-insertion order so each
  // target's later sum keeps its canonical f64 order. Typed arrays (vs an array of
  // boxed [src, factor] tuples) make the hot pull loop contiguous and allocation-free.
  for (let v = 0; v < n; v++) {
    incOff[v + 1] += incOff[v];
  }

  const incSrc = new Int32Array(incOff[n]);
  const incFac = new Float64Array(incOff[n]);
  const cursor = incOff.slice(0, n);
  let ei = 0;

  for (const edge of graph.edges) {
    const w = weighted ? edgeW[ei++] : 1;

    if (!typeOk(edge)) {
      continue;
    }

    const src = index.get(edge.from.id)!;
    const pos = cursor[index.get(edge.to.id)!]++;
    incSrc[pos] = src;
    incFac[pos] = w / outStrength[src];
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

      for (let j = incOff[v]; j < incOff[v + 1]; j++) {
        sum += pr[incSrc[j]] * incFac[j];
      }

      next[v] = base + d * sum;
    }

    pr = next;

    if (iter < iterations - 1) {
      yield; // checkpoint between iterations (async surface interleaves here)
    }
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
  return graph
    ? drainSync(computeGen(config, graph))
    : (g: Graph) => drainSync(computeGen(config, g));
}

/**
 * Non-blocking {@link pagerank}: identical scores, but it yields to the event loop
 * between iterations so a long run stays responsive in-process (server or browser).
 * `pagerankAsync(config, graph)` or `pagerankAsync(config)(graph)` →
 * `Promise<PageRankRow[]>`.
 */
export function pagerankAsync(config: AlgorithmConfig): (graph: Graph) => Promise<PageRankRow[]>;
export function pagerankAsync(config: AlgorithmConfig, graph: Graph): Promise<PageRankRow[]>;
export function pagerankAsync(
  config: AlgorithmConfig,
  graph?: Graph,
): Promise<PageRankRow[]> | ((graph: Graph) => Promise<PageRankRow[]>) {
  return asyncAlgorithm(computeGen)(config, graph);
}
