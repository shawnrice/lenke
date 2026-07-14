import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
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
const outEdges = function* (
  byLabel: Map<string, Set<Edge>> | undefined,
  edgeLabel: string | undefined,
): Iterable<Edge> {
  if (byLabel === undefined) {
    return;
  }

  const sets = edgeLabel === undefined ? byLabel.values() : [byLabel.get(edgeLabel)];

  for (const set of sets) {
    if (set === undefined) {
      continue;
    }

    yield* set;
  }
};

const compute = (config: AlgorithmConfig, graph: Graph): ShortestPathRow[] => {
  const { source, edgeLabel, weightProperty, writeProperty } = config;

  const order = [...graph.vertices];
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  const srcIdx = source === undefined ? undefined : index.get(source);

  // Unknown/absent source → no reachable set.
  if (srcIdx === undefined) {
    return [];
  }

  const dist = new Float64Array(order.length).fill(Infinity);
  dist[srcIdx] = 0;

  const weightOf = (edge: Edge): number => {
    if (weightProperty === undefined) {
      return 1;
    }

    const w = edge.getProperty(weightProperty);

    return typeof w === 'number' ? w : 0;
  };

  if (weightProperty === undefined) {
    // Unweighted BFS — hop distance (order-independent unique layers).
    const queue: number[] = [srcIdx];
    let head = 0;

    while (head < queue.length) {
      const u = queue[head++];

      for (const edge of outEdges(graph.edgesFromByLabel.get(order[u].id), edgeLabel)) {
        const v = index.get(edge.to.id)!;

        if (dist[v] === Infinity) {
          dist[v] = dist[u] + 1;
          queue.push(v);
        }
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

      for (const edge of outEdges(graph.edgesFromByLabel.get(order[u].id), edgeLabel)) {
        const v = index.get(edge.to.id)!;
        const nd = du + weightOf(edge);

        if (nd < dist[v]) {
          dist[v] = nd;
          heapPush(heap, [nd, v]);
        }
      }
    }
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
 * Single-source shortest path from a `source` external id, following out-edges
 * (optionally of one `edgeLabel`). Unweighted → BFS hop distance; weighted (a
 * `weightProperty` is set) → Dijkstra. Returns `{ node, distance }` for every
 * reachable vertex (source at 0), in insertion order. Distances are the canonical
 * minimum path cost, so they are byte-identical to the native engine. Data-last
 * dual-form: `shortestPath(config, graph)` or `shortestPath(config)(graph)`.
 */
export function shortestPath(config: AlgorithmConfig): (graph: Graph) => ShortestPathRow[];
export function shortestPath(config: AlgorithmConfig, graph: Graph): ShortestPathRow[];
export function shortestPath(
  config: AlgorithmConfig,
  graph?: Graph,
): ShortestPathRow[] | ((graph: Graph) => ShortestPathRow[]) {
  return graph ? compute(config, graph) : (g: Graph) => compute(config, g);
}
