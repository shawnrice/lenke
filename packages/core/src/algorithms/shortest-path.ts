import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
import type { Vertex } from '../core/Vertex.js';
import { countIncidentEdges, incidentEdges } from './adjacency.js';
import { type AlgorithmGen, defineAlgorithm, materializeVertices, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A shortest-path result row: `{ node, distance }`. */
export type ShortestPathRow = AlgorithmRow<'distance', number>;

/** A binary min-heap entry: `[distance, vertexIndex]`, ordered by distance then index. */
type HeapItem = [number, number];

const less = (a: HeapItem, b: HeapItem): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

const heapPush = (heap: HeapItem[], item: HeapItem): void => {
  heap.push(item);
  let i = heap.length - 1;

  while (i > 0) {
    const parent = (i - 1) >> 1;

    if (!less(heap[i], heap[parent])) {
      break;
    }

    [heap[i], heap[parent]] = [heap[parent], heap[i]];
    i = parent;
  }
};

const heapPop = (heap: HeapItem[]): HeapItem => {
  const [top] = heap;
  const last = heap.pop()!;

  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;

    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;

      if (l < heap.length && less(heap[l], heap[smallest])) {
        smallest = l;
      }

      if (r < heap.length && less(heap[r], heap[smallest])) {
        smallest = r;
      }

      if (smallest === i) {
        break;
      }

      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }

  return top;
};

/**
 * Yield each out-edge from a vertex's `edgesFromByLabel` entry, optionally
 * restricted to one edge type. The caller reads `edge.to` for the neighbour.
 */
/** Which incident edges to follow, from `config.direction` (default `out`, mirroring
 *  `degree`); `both` treats the graph as undirected. */
type Dir = 'out' | 'in' | 'both';
const dirOf = (config: AlgorithmConfig): Dir =>
  config.direction === 'in' || config.direction === 'both' ? config.direction : 'out';

/**
 * Goal-directed A* — explore by `f = g + h`, where `h` is the admissible estimate
 * to the target read from each vertex's `heuristicProperty` (absent → 0, degrading
 * to Dijkstra). Returns the source→target distance (optimal when the target is
 * settled, so identical to Dijkstra), or `undefined` if unreachable. Same
 * `(priority, index)` tie-break as the Dijkstra heap, so native and TS agree.
 */
/**
 * The traversal adjacency as a flat CSR over dense vertex indices: `nbr[off[u] .. off[u+1])` are
 * u's neighbour INDICES in the configured direction, and `w[...]` the corresponding edge weights
 * (empty when unweighted, where every step costs 1).
 *
 * ⚠️ IT REPLACES A NESTED GENERATOR THAT ALLOCATED A TUPLE PER EDGE AND HASHED A STRING PER STEP.
 * `neighbours` was a generator delegating to `incidentEdges` (a second generator), yielding
 * `[edge, neighbourId]` — one 2-element array per edge traversed — and every consumer then did
 * `index.get(vid)!`, a string-keyed Map lookup per step. Item 1470 profiled `shortestPath` with
 * `incidentEdges` at 20.69% and `neighbours` at 20.32%: **41% of the run in adjacency plumbing**,
 * none of it the search. Built once, every step becomes two typed-array reads.
 *
 * ⚠️ THE ORDER IS OUT-EDGES THEN IN-EDGES PER VERTEX — NOT merged by edge index. `both` has to
 * match native `visit_adj`'s order because the Dijkstra `(distance, index)` tie-break is decided by
 * it, so two equal-distance routes must be offered in the same sequence as native offers them.
 * (This is the opposite of item 1469's `neighborAggregate` merge, where eidx order WAS the contract
 * — the two procedures genuinely differ, so the orders cannot be shared.)
 *
 * ⚠️ A `both`-direction SELF-LOOP APPEARS TWICE, once from each side, because that is what
 * `neighbours` yielded and the distances must not change. `neighborAggregate` drops the second
 * copy; this one must not.
 *
 * The build reads through `incidentEdges` / `countIncidentEdges`, so the multi-label dedupe those
 * do is preserved exactly — paid once per vertex at build time instead of once per traversal.
 */
type Csr = { off: Int32Array; nbr: Int32Array; w: Float64Array };

const buildCsr = (
  graph: Graph,
  order: readonly Vertex[],
  index: Map<string, number>,
  dir: Dir,
  edgeLabel: string | undefined,
  // `undefined` means UNWEIGHTED: every step costs 1 and `w` is not materialized at all. Folding
  // the flag into the callback keeps this at the parameter bound and makes the two states one fact
  // rather than two that could disagree.
  weightOf: ((edge: Edge) => number) | undefined,
): Csr => {
  const n = order.length;
  const off = new Int32Array(n + 1);
  const wantOut = dir === 'out' || dir === 'both';
  const wantIn = dir === 'in' || dir === 'both';

  for (let i = 0; i < n; i++) {
    const { id } = order[i];
    const c =
      (wantOut ? countIncidentEdges(graph.edgesFromByLabel.get(id), edgeLabel) : 0) +
      (wantIn ? countIncidentEdges(graph.edgesToByLabel.get(id), edgeLabel) : 0);

    off[i + 1] = off[i] + c;
  }

  const m = off[n];
  const nbr = new Int32Array(m);
  const w = new Float64Array(weightOf === undefined ? 0 : m);
  let k = 0;

  for (let i = 0; i < n; i++) {
    const { id } = order[i];

    if (wantOut) {
      for (const e of incidentEdges(graph.edgesFromByLabel.get(id), edgeLabel)) {
        nbr[k] = index.get(e.toId)!;

        if (weightOf !== undefined) {
          w[k] = weightOf(e);
        }

        k += 1;
      }
    }

    if (wantIn) {
      for (const e of incidentEdges(graph.edgesToByLabel.get(id), edgeLabel)) {
        nbr[k] = index.get(e.fromId)!;

        if (weightOf !== undefined) {
          w[k] = weightOf(e);
        }

        k += 1;
      }
    }
  }

  return { off, nbr, w };
};

/** Shared traversal context — the vertex order plus the prebuilt adjacency. */
type PathContext = {
  order: Vertex[];
  csr: Csr;
};

const astar = (
  ctx: PathContext,
  srcIdx: number,
  tgtIdx: number,
  heuristicProperty: string | undefined,
): number | undefined => {
  const { order, csr } = ctx;
  const heuristicOf = (i: number): number => {
    if (heuristicProperty === undefined) {
      return 0;
    }

    const h = order[i].getProperty(heuristicProperty);

    return typeof h === 'number' ? h : 0;
  };

  const g = new Float64Array(order.length).fill(Infinity);
  const closed = new Uint8Array(order.length);
  g[srcIdx] = 0;
  const heap: HeapItem[] = [[heuristicOf(srcIdx), srcIdx]];

  while (heap.length > 0) {
    const [, u] = heapPop(heap);

    if (closed[u]) {
      continue;
    }

    closed[u] = 1;

    if (u === tgtIdx) {
      return g[u];
    }

    for (let k = csr.off[u]; k < csr.off[u + 1]; k++) {
      const v = csr.nbr[k];

      if (closed[v]) {
        continue;
      }

      const ng = g[u] + (csr.w.length === 0 ? 1 : csr.w[k]);

      if (ng < g[v]) {
        g[v] = ng;
        heapPush(heap, [ng + heuristicOf(v), v]);
      }
    }
  }

  return undefined;
};

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<ShortestPathRow> {
  const { source, target, edgeLabel, weightProperty, heuristicProperty, algorithm, writeProperty } =
    config;

  const order = yield* materializeVertices(graph);
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  const srcIdx = source === undefined ? undefined : index.get(source);
  const dir = dirOf(config);

  // Unknown/absent source → no reachable set.
  if (srcIdx === undefined) {
    return [];
  }

  // Dijkstra (and A*) require NON-NEGATIVE weights. With a negative edge the
  // relaxation can keep finding a cheaper path forever, so a negative cycle never
  // terminates — and a negative self-loop is enough: one node and one edge hung
  // the engine indefinitely. Rejected for ANY negative weight, not just a cycle,
  // because Dijkstra can also settle a vertex too early and return a silently
  // wrong distance; a negative-but-acyclic graph terminating is luck, not a
  // correct answer. Mirrors the native guard in `algo/mod.rs`.
  if (weightProperty !== undefined) {
    for (const edge of graph.edges) {
      const w = edge.getProperty(weightProperty);

      // NaN is rejected alongside negatives: it makes every relaxation
      // comparison false and strands the search just as effectively.
      if (typeof w === 'number' && (Number.isNaN(w) || w < 0)) {
        throw new LenkeError(
          `shortestPath \`weightProperty\` (${weightProperty}) must hold non-negative numbers — Dijkstra does not admit negative weights`,
          { code: ErrorCode.InvalidValue },
        );
      }
    }
  }

  const weightOf = (edge: Edge): number => {
    if (weightProperty === undefined) {
      return 1;
    }

    const w = edge.getProperty(weightProperty);

    return typeof w === 'number' ? w : 0;
  };

  // A* is a goal-directed backend returning just the source→target distance
  // (identical to Dijkstra's), exploring fewer vertices via the admissible
  // heuristic. Falls back to no rows for an unknown/unreachable target.
  if (algorithm === 'astar') {
    const tgtIdx = target === undefined ? undefined : index.get(target);

    if (tgtIdx === undefined) {
      return [];
    }

    const ctx: PathContext = {
      order,
      csr: buildCsr(
        graph,
        order,
        index,
        dir,
        edgeLabel,
        weightProperty === undefined ? undefined : weightOf,
      ),
    };
    const d = astar(ctx, srcIdx, tgtIdx, heuristicProperty);

    if (d === undefined) {
      return [];
    }

    if (writeProperty !== undefined) {
      order[tgtIdx].setProperty(writeProperty, d);
    }

    return [{ node: order[tgtIdx].id, distance: d }];
  }

  const dist = new Float64Array(order.length).fill(Infinity);
  dist[srcIdx] = 0;

  // Built ONCE for the whole search, where `neighbours` rebuilt a generator chain per settled
  // vertex. Unweighted takes the BFS arm below and never reads `w`, so it is not materialized.
  const csr = buildCsr(
    graph,
    order,
    index,
    dir,
    edgeLabel,
    weightProperty === undefined ? undefined : weightOf,
  );
  let sinceYield = 0;

  if (weightProperty === undefined) {
    // Unweighted BFS — hop distance (order-independent unique layers).
    const queue: number[] = [srcIdx];
    let head = 0;

    while (head < queue.length) {
      const u = queue[head++];

      for (let k = csr.off[u]; k < csr.off[u + 1]; k++) {
        const v = csr.nbr[k];

        if (dist[v] === Infinity) {
          dist[v] = dist[u] + 1;
          queue.push(v);
        }
      }

      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }
  } else {
    // Weighted Dijkstra — min-heap keyed by (distance, vertex index). The settled
    // distance is the canonical minimum path cost, so it matches native exactly.
    const heap: HeapItem[] = [[0, srcIdx]];

    while (heap.length > 0) {
      const [du, u] = heapPop(heap);

      if (du > dist[u]) {
        continue;
      }

      for (let k = csr.off[u]; k < csr.off[u + 1]; k++) {
        const v = csr.nbr[k];
        const nd = du + csr.w[k];

        if (nd < dist[v]) {
          dist[v] = nd;
          heapPush(heap, [nd, v]);
        }
      }

      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }
  }

  // A `target` restricts the result to that one vertex's distance (like A*),
  // instead of a row per reachable vertex. Unknown/unreachable target → no rows.
  if (target !== undefined) {
    const ti = index.get(target);

    if (ti === undefined || !Number.isFinite(dist[ti])) {
      return [];
    }

    if (writeProperty !== undefined) {
      order[ti].setProperty(writeProperty, dist[ti]);
    }

    return [{ node: order[ti].id, distance: dist[ti] }];
  }

  const rows: ShortestPathRow[] = [];

  order.forEach((v, i) => {
    if (!Number.isFinite(dist[i])) {
      return;
    }

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, dist[i]);
    }

    rows.push({ node: v.id, distance: dist[i] });
  });

  return rows;
};

/**
 * Single-source shortest path from a `source` external id, following edges in the
 * configured `direction` (`out` default / `in` / `both`; `both` = undirected),
 * optionally of one `edgeLabel`. Unweighted → BFS hop distance; weighted (a
 * `weightProperty` is set) → Dijkstra. Resolves `Promise<ShortestPathRow[]>` for
 * every reachable vertex (source at 0), in insertion order, without blocking the
 * event loop. Distances are the canonical minimum path cost, so they are
 * byte-identical to the native engine. Data-last dual-form: `shortestPath(config,
 * graph)` or `shortestPath(config)(graph)`.
 */
export const shortestPath = defineAlgorithm(computeGen);
