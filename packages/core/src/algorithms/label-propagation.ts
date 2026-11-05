import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
import type { Vertex } from '../core/Vertex.js';
import { countIncidentEdgesFlat, incidentEdges, writeIncidentEnds } from './adjacency.js';
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

  for (const edge of incidentEdges(byLabel, edgeLabel)) {
    out.push(index.get(edge[end].id)!);
  }
};

/**
 * Build the undirected neighbour adjacency as a flat CSR, in one of two ways.
 *
 * **The fast arm — count, then fill — needs no intermediate arrays.** A first pass sizes `off` by
 * summing bucket sizes, and a second writes endpoints straight into the `Int32Array`. That is only
 * sound when no edge carries more than one label, because the label index buckets an edge under each
 * of its labels and the counting pass would then double-count; `graph.multiTypeEdgeCount` is exactly
 * that condition and is maintained at all four transitions.
 *
 * **The general arm is the original**: accumulate one `number[]` per vertex through the deduping
 * `incidentEdges` generator, then copy every list into the typed array. Correct for any graph, and
 * it pays `n` allocations plus a full copy pass for it.
 *
 * Item 1467 profiled `labelPropagation` as the most expensive whole-graph procedure per vertex (3342
 * ns/V against `connectedComponents`' 231 on the same fixture) and put **21.6% of the run in this
 * build** — `incidentEdges` 12.04% plus `collectNeighbours` 9.60% — with a further 6.93% in
 * `(garbage collector)`, which the per-vertex arrays are the obvious source of. None of that was
 * iteration; all of it was construction.
 *
 * ⚠️ BOTH ARMS MUST PRODUCE THE IDENTICAL ADJACENCY, not merely the same degrees: out-edge targets
 * first then in-edge sources, buckets in index order, each bucket in insertion order, one entry per
 * edge so parallel edges and self-loops keep their multiplicity. A permuted neighbour list changes a
 * label tie-break, so a divergence here is a wrong answer — and one that agrees on row count.
 *
 * `sinceYield` is threaded in and back out rather than kept locally, so the one counter still drives
 * every O(V)/O(E) loop in the procedure and the driver's chunks stay time-bounded across the split.
 */
const buildAdjacency = function* (
  graph: Graph,
  order: readonly Vertex[],
  index: Map<string, number>,
  edgeLabel: string | undefined,
  startSinceYield: number,
): Generator<void, { off: Int32Array; data: Int32Array; sinceYield: number }, void> {
  const n = order.length;
  const off = new Int32Array(n + 1);
  let sinceYield = startSinceYield;

  if (graph.multiTypeEdgeCount === 0) {
    for (let i = 0; i < n; i++) {
      const { id } = order[i];
      const deg =
        countIncidentEdgesFlat(graph.edgesFromByLabel.get(id), edgeLabel) +
        countIncidentEdgesFlat(graph.edgesToByLabel.get(id), edgeLabel);

      off[i + 1] = off[i] + deg;
      sinceYield += deg;

      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }

    const data = new Int32Array(off[n]);

    for (let i = 0; i < n; i++) {
      const { id } = order[i];
      let w = writeIncidentEnds(
        graph.edgesFromByLabel.get(id),
        'to',
        edgeLabel,
        index,
        data,
        off[i],
      );

      w = writeIncidentEnds(graph.edgesToByLabel.get(id), 'from', edgeLabel, index, data, w);
      sinceYield += w - off[i];

      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }

    return { off, data, sinceYield };
  }

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

  return { off, data, sinceYield };
};

/**
 * The seed/anchor mask: `1` for a vertex carrying a non-null `seedProperty`
 * (pinned to its own label), else `0`. `!= null` catches both absent (undefined)
 * and stored-null, matching native's `!= Value::Null`. Split out to keep computeGen
 * under the statement-count lint bound; yields so a huge vertex list never blocks.
 */
const buildSeedMask = function* (
  order: readonly Vertex[],
  seedProperty: string | undefined,
): Generator<void, Uint8Array, void> {
  const isSeed = new Uint8Array(order.length);

  if (seedProperty === undefined) {
    return isSeed;
  }

  let sinceYield = 0;

  for (let i = 0; i < order.length; i++) {
    if (order[i].getProperty(seedProperty) != null) {
      isSeed[i] = 1;
    }

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return isSeed;
};

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<LabelRow> {
  const { edgeLabel, writeProperty, seedProperty, iterations = DEFAULT_ITERATIONS } = config;

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
  const {
    off,
    data,
    sinceYield: afterBuild,
  } = yield* buildAdjacency(graph, order, index, edgeLabel, sinceYield);

  sinceYield = afterBuild;

  // Seed/anchor vertices (carrying a non-null `seedProperty`) never adopt a
  // neighbour's label — they stay pinned to their own id, so communities nucleate
  // around them instead of collapsing to one.
  const isSeed = yield* buildSeedMask(order, seedProperty);

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
      // A seed anchor keeps its label — never tallies, never changes.
      if (isSeed[v] === 1) {
        nextLabels[v] = labels[v];

        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0;

          yield;
        }

        continue;
      }

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
