import type { Graph } from '../core/Graph.js';
import { type AlgorithmGen, defineAlgorithm, materializeVertices, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A peer-pressure result row: `{ node, cluster }`. */
export type ClusterRow = AlgorithmRow<'cluster', string>;

const DEFAULT_ITERATIONS = 30;

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<ClusterRow> {
  const { edgeLabel, writeProperty, iterations = DEFAULT_ITERATIONS } = config;

  const order = yield* materializeVertices(graph);
  const n = order.length;
  const index = new Map<string, number>();
  let sinceYield = 0;

  for (let i = 0; i < n; i++) {
    index.set(order[i].id, i);

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  // A named-but-unknown edge type matches no edge → every vertex stays its own cluster.
  const typeOk = (edge: { labels: Set<string> }): boolean =>
    edgeLabel === undefined || edge.labels.has(edgeLabel);

  // Out-degree → per-vote strength; in-degree → sizes the in-CSR. One sweep over
  // graph.edges in insertion order — the exact sequence native scans.
  const outDeg = new Int32Array(n);
  const inOff = new Int32Array(n + 1);

  for (const edge of graph.edges) {
    if (typeOk(edge)) {
      outDeg[index.get(edge.from.id)!]++;
      inOff[index.get(edge.to.id)! + 1]++;
    }

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  const vote = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    vote[i] = outDeg[i] > 0 ? 1 / outDeg[i] : 0;
  }

  for (let v = 0; v < n; v++) {
    inOff[v + 1] += inOff[v];
  }

  // In-CSR: `inSrc[inOff[u]..inOff[u+1]]` are u's in-neighbour source indices, filled in
  // edge-insertion order so each vertex's later energy sum keeps its canonical f64 order.
  const inSrc = new Int32Array(inOff[n]);
  const cursor = inOff.slice(0, n);

  for (const edge of graph.edges) {
    if (typeOk(edge)) {
      inSrc[cursor[index.get(edge.to.id)!]++] = index.get(edge.from.id)!;
    }

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  let cluster = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    cluster[i] = i;
  }

  // Reused energy accumulator indexed by cluster + a dirty-list of the clusters touched
  // (every in-neighbour has out-degree ≥ 1, so its vote is > 0 and `energy[c] === 0`
  // reliably marks a first sighting).
  const energy = new Float64Array(n);
  const dirty: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Int32Array(n);
    let changed = false;

    for (let u = 0; u < n; u++) {
      dirty.length = 0;

      for (let j = inOff[u]; j < inOff[u + 1]; j++) {
        const s = inSrc[j];
        const c = cluster[s];

        if (energy[c] === 0) {
          dirty.push(c);
        }

        energy[c] += vote[s];
      }

      // Adopt the max-energy cluster; tie → lexicographically smallest external id. No
      // incoming votes → keep own cluster. (Selection is order-independent.)
      let best = -1;
      let bestE = 0;

      for (const c of dirty) {
        const e = energy[c];

        if (best === -1 || e > bestE || (e === bestE && order[c].id < order[best].id)) {
          best = c;
          bestE = e;
        }

        energy[c] = 0; // reset for the next vertex
      }

      const nv = best === -1 ? cluster[u] : best;
      next[u] = nv;

      if (nv !== cluster[u]) {
        changed = true;
      }

      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }

    cluster = next;

    if (!changed) {
      break; // converged
    }
  }

  const rows: ClusterRow[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const c = order[cluster[i]].id;

    if (writeProperty !== undefined) {
      order[i].setProperty(writeProperty, c);
    }

    rows[i] = { node: order[i].id, cluster: c };

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * Peer Pressure community detection (TinkerPop's `PeerPressureVertexProgram`) — each
 * vertex starts in its own cluster and votes for it along its out-edges with strength
 * `1/out-degree`; each round a vertex adopts the cluster with the highest total incoming
 * vote energy (ties → smallest cluster external id), iterating to convergence (cap
 * `iterations`, default 30). Deterministic, byte-identical to the native engine.
 * Data-last dual-form: `peerPressure(config, graph)` or `peerPressure(config)(graph)`.
 */
export const peerPressure = defineAlgorithm(computeGen);
