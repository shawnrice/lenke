import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
import { type AlgorithmGen, defineAlgorithm, materializeVertices, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A label-propagation result row: `{ node, label }`. */
export type LabelRow = AlgorithmRow<'label', string>;

const DEFAULT_ITERATIONS = 10;

/**
 * Collect a vertex's neighbour indices (out-edge targets + in-edge sources,
 * optionally restricted to one edge type) into `out`. One push per edge, so
 * parallel edges / self-loops keep their multiplicity — matching the native tally.
 */
const collectNeighbours = (
  byLabel: Map<string, Set<Edge>> | undefined,
  end: 'to' | 'from',
  edgeLabel: string | undefined,
  index: Map<string, number>,
  out: number[],
): void => {
  if (byLabel === undefined) {
    return;
  }

  const sets = edgeLabel === undefined ? byLabel.values() : [byLabel.get(edgeLabel)];

  for (const set of sets) {
    if (set === undefined) {
      continue;
    }

    for (const edge of set) {
      out.push(index.get(edge[end].id)!);
    }
  }
};

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<LabelRow> {
  const { edgeLabel, writeProperty, iterations = DEFAULT_ITERATIONS } = config;

  // Insertion order == native dense-id order. A label is carried as the index of
  // the vertex whose external id is that label (all labels are vertex ids), so a
  // round tallies numbers in a reused Map instead of hashing label strings.
  const order = yield* materializeVertices(graph);
  const n = order.length;
  const index = new Map<string, number>();

  // One counter drives every O(V)/O(E) loop (the CSR build passes included, not just
  // the rounds); the driver turns these frequent checkpoints into time-bounded chunks.
  let sinceYield = 0;

  for (let i = 0; i < n; i++) {
    index.set(order[i].id, i);

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  // Precompute the undirected neighbour adjacency ONCE as a flat CSR — the graph is
  // static across rounds, so this replaces per-round nested-map/Set traversal +
  // edge-type filtering with a contiguous typed-array scan.
  const off = new Int32Array(n + 1);
  const lists: number[][] = [];

  for (let i = 0; i < n; i++) {
    const list: number[] = [];
    collectNeighbours(graph.edgesFromByLabel.get(order[i].id), 'to', edgeLabel, index, list);
    collectNeighbours(graph.edgesToByLabel.get(order[i].id), 'from', edgeLabel, index, list);
    lists.push(list);
    off[i + 1] = off[i] + list.length;
    sinceYield += list.length;

    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  const data = new Int32Array(off[n]);
  let k = 0;

  for (const list of lists) {
    for (const nbr of list) {
      data[k++] = nbr;
    }

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  let labels = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    labels[i] = i;
  }

  // Tally neighbour labels with a reused count array indexed by label (a vertex
  // index in [0, n)) plus a dirty-list of the labels touched, so counting and the
  // per-vertex reset are plain array indexing — far cheaper than a Map in JS, and
  // the reset stays O(distinct labels) rather than O(n).
  const count = new Int32Array(n);
  const dirty: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    const nextLabels = new Int32Array(n);
    let changed = false;

    for (let v = 0; v < n; v++) {
      dirty.length = 0;

      for (let j = off[v]; j < off[v + 1]; j++) {
        const l = labels[data[j]];

        if (count[l]++ === 0) {
          dirty.push(l);
        }
      }

      // Adopt the most-frequent label; tie → lexicographically smallest external id.
      // No neighbours → keep the current label. (Selection is order-independent, so
      // the dirty-list order does not affect the result.)
      let best = -1;
      let bestCount = 0;

      for (const lbl of dirty) {
        const c = count[lbl];

        if (best === -1 || c > bestCount || (c === bestCount && order[lbl].id < order[best].id)) {
          best = lbl;
          bestCount = c;
        }

        count[lbl] = 0; // reset for the next vertex
      }

      const nv = best === -1 ? labels[v] : best;
      nextLabels[v] = nv;

      if (nv !== labels[v]) {
        changed = true;
      }

      // Checkpoint within the round — `nextLabels` is being built while `labels` is
      // frozen, so yielding here can't change the result.
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }

    labels = nextLabels;

    if (!changed) {
      break; // converged — later rounds would be no-ops
    }
  }

  const rows: LabelRow[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const label = order[labels[i]].id;

    if (writeProperty !== undefined) {
      order[i].setProperty(writeProperty, label);
    }

    rows[i] = { node: order[i].id, label };

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * Label propagation (community detection) — each vertex starts labelled with its
 * own external id and each round adopts the most-frequent neighbour label (edges
 * undirected), ties broken by the smallest label string, for a fixed `iterations`
 * count (default 10), stopping early once a round changes nothing. Deterministic and
 * exact. Runs without blocking the event loop (it yields between rounds), resolving
 * `Promise<LabelRow[]>`. Data-last dual-form: `labelPropagation(config, graph)` or
 * `labelPropagation(config)(graph)`.
 */
export const labelPropagation = defineAlgorithm(computeGen);
