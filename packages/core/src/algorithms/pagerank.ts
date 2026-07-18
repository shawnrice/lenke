import type { Graph } from '../core/Graph.js';
import type { Vertex } from '../core/Vertex.js';
import { type AlgorithmGen, defineAlgorithm, materializeVertices, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A PageRank result row: `{ node, score }`. */
export type PageRankRow = AlgorithmRow<'score', number>;

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 20;

/**
 * The personalization vector `p` for personalized PageRank: uniform `1/k` over the
 * k distinct, resolvable seeds — unknown ids dropped, a Set de-duplicating so a
 * repeated id never double-weights — or uniform `1/n` when no seed resolves
 * (degenerating to global PageRank). Each external id resolves through the same
 * `index` the native engine uses, so `p` matches vertex-for-vertex.
 */
const personalizationVector = (
  sourceNodes: string[] | undefined,
  index: Map<string, number>,
  n: number,
): Float64Array => {
  const p = new Float64Array(n);
  const seeds = new Set<number>();

  for (const id of sourceNodes ?? []) {
    const idx = index.get(id);

    if (idx !== undefined) {
      seeds.add(idx);
    }
  }

  if (seeds.size === 0) {
    p.fill(1 / n);

    return p;
  }

  const share = 1 / seeds.size;

  for (const s of seeds) {
    p[s] = share;
  }

  return p;
};

/**
 * Materialize `{ node, score }` rows in vertex order, writing each score back to
 * `writeProperty` when set — the shared tail of both PageRank variants, split out
 * to keep each core generator under the statement-count lint bound. Yields
 * periodically so a huge vertex list never blocks a frame.
 */
const emitRows = function* (
  order: Vertex[],
  pr: Float64Array,
  writeProperty: string | undefined,
): AlgorithmGen<PageRankRow> {
  const rows: PageRankRow[] = new Array(order.length);
  let sinceYield = 0;

  for (let i = 0; i < order.length; i++) {
    const v = order[i];
    const score = pr[i];

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, score);
    }

    rows[i] = { node: v.id, score };

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * The shared PageRank core (pull model, f64). `personalized = false` is classic
 * global PageRank (uniform restart); `true` is personalized PageRank / RWR, whose
 * restart (and dangling redistribution) targets the `config.sourceNodes` seed set
 * via a personalization vector `p` (uniform `1/k` over the k distinct resolvable
 * seeds, else uniform `1/N`). Both share every build pass and pull-loop order, so
 * each matches its native twin bit-for-bit; the global branch keeps its exact
 * original `base` arithmetic.
 */
const pagerankCore = function* (
  config: AlgorithmConfig,
  graph: Graph,
  personalized: boolean,
): AlgorithmGen<PageRankRow> {
  const {
    edgeLabel,
    weightProperty,
    writeProperty,
    sourceNodes,
    dampingFactor: d = DEFAULT_DAMPING,
    iterations = DEFAULT_ITERATIONS,
  } = config;

  const order = yield* materializeVertices(graph);
  const n = order.length;

  if (n === 0) {
    return [];
  }

  const nf = n;
  const index = new Map<string, number>();

  // A single counter drives every O(V)/O(E) loop below (build passes included, not
  // just the iteration): the driver turns these frequent checkpoints into time-
  // bounded chunks, so even the setup over a huge edge list never blocks a frame.
  let sinceYield = 0;

  for (let i = 0; i < n; i++) {
    index.set(order[i].id, i);

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

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

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  // Pass 2: per-target contribution lists as a flat CSR — `incOff[v]..incOff[v+1]`
  // indexes `(incSrc, incFac)` for target v, filled in edge-insertion order so each
  // target's later sum keeps its canonical f64 order. Typed arrays (vs an array of
  // boxed [src, factor] tuples) make the hot pull loop contiguous and allocation-free.
  for (let v = 0; v < n; v++) {
    incOff[v + 1] += incOff[v];

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
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
    // A node whose total out-weight is 0 (only reachable when weighted and every
    // out-edge has weight 0) is a DANGLING node: its rank mass is redistributed
    // uniformly via the `dangling` sum below — it must NOT be divided by zero
    // (`w / 0 === 0/0 === NaN`, which would poison every score). Emit a 0 factor
    // so this edge carries no directed mass; the CSR slot is still filled, keeping
    // the summation order byte-identical to the unweighted path and to native.
    incFac[pos] = outStrength[src] === 0 ? 0 : w / outStrength[src];

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  // The personalization vector `p` drives a personalized run's restart; an unused
  // empty array on the global path (where `base` handles the uniform restart).
  const p = personalized ? personalizationVector(sourceNodes, index, n) : new Float64Array(0);

  // Initial rank: the personalization vector for a personalized run, else uniform.
  let pr = personalized ? p.slice() : new Float64Array(n).fill(1 / nf);

  for (let iter = 0; iter < iterations; iter++) {
    // Dangling mass: Σ pr[u] over out-strength-0 vertices, in vertex order.
    let dangling = 0;

    for (let u = 0; u < n; u++) {
      if (outStrength[u] === 0) {
        dangling += pr[u];
      }

      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }

    // Global keeps its exact original base; personalized redistributes the restart
    // mass (damping complement + dangling) per `p` — `teleport * p[v]`.
    const base = (1 - d) / nf + (d * dangling) / nf;
    const teleport = 1 - d + d * dangling;
    const next = new Float64Array(n);

    for (let v = 0; v < n; v++) {
      let sum = 0;

      for (let j = incOff[v]; j < incOff[v + 1]; j++) {
        sum += pr[incSrc[j]] * incFac[j];
      }

      next[v] = personalized ? teleport * p[v] + d * sum : base + d * sum;

      // Checkpoint within the iteration — `next` is being built while `pr` is frozen,
      // so yielding here can't change the result.
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }

    pr = next;
  }

  return yield* emitRows(order, pr, writeProperty);
};

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<PageRankRow> {
  return yield* pagerankCore(config, graph, false);
};

export const personalizedComputeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<PageRankRow> {
  return yield* pagerankCore(config, graph, true);
};

/**
 * PageRank (pull model, f64) — `pr'[v] = (1−d)/N + d·Σ pr[u]·w(u→v)/S[u] +
 * d·dangling/N` for a fixed `iterations` (default 20), damping `dampingFactor`
 * (default 0.85), optionally weighted by `weightProperty` and filtered to
 * `edgeLabel`. Every f64 accumulation is taken in global edge-insertion order, so
 * scores are byte-identical to the native engine. Runs without blocking the event
 * loop (it yields between iterations), resolving `Promise<PageRankRow[]>`. Data-last
 * dual-form: `pagerank(config, graph)` or `pagerank(config)(graph)`.
 */
export const pagerank = defineAlgorithm(computeGen);

/**
 * Personalized PageRank / random-walk-with-restart — identical to {@link pagerank}
 * but the random surfer restarts (and dangling mass redistributes) to the
 * `sourceNodes` seed set instead of uniformly, ranking the graph by proximity to
 * those seeds (the graph-native recsys ranker). The personalization vector is
 * uniform over the distinct, resolvable seeds; an empty/all-unknown seed set
 * degenerates to global PageRank. Byte-identical to the native engine. Data-last
 * dual-form: `personalizedPagerank(config, graph)` or `personalizedPagerank(config)(graph)`.
 */
export const personalizedPagerank = defineAlgorithm(personalizedComputeGen);
