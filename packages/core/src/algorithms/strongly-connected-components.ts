import type { Graph } from '../core/Graph.js';
import { type AlgorithmGen, defineAlgorithm, materializeVertices, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A strongly-connected-components result row: `{ node, componentId }`. */
export type ComponentRow = AlgorithmRow<'componentId', string>;

/**
 * Pop one completed SCC off the Tarjan stack (everything down to and including its
 * `root`), then stamp every member with the component's representative — its **min
 * insertion index** — so the id is walk-order-independent.
 */
const popComponent = (
  root: number,
  tstack: number[],
  onStack: Uint8Array,
  comp: Int32Array,
): void => {
  const members: number[] = [];
  let m = -1;
  let rep = root;

  do {
    m = tstack.pop()!;
    onStack[m] = 0;
    members.push(m);

    if (m < rep) {
      rep = m;
    }
  } while (m !== root);

  for (const mm of members) {
    comp[mm] = rep;
  }
};

/**
 * Iterative Tarjan (explicit work stack, never recursion — a deep chain must not
 * blow the call stack) over the forward adjacency `adj`. Returns each vertex's
 * component representative: the **min insertion index** in its SCC, so the id is
 * independent of the walk order and matches the native engine vertex-for-vertex.
 * Yields periodically so a huge graph never blocks a frame.
 */
const tarjanScc = function* (adj: number[][], n: number): Generator<void, Int32Array, void> {
  const order = new Int32Array(n).fill(-1); // discovery index (Tarjan's `index`)
  const low = new Int32Array(n); // lowlink
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1); // resolved component representative
  const tstack: number[] = []; // Tarjan's component stack
  const frameV: number[] = []; // DFS frame: vertex …
  const frameC: number[] = []; // … and its next-neighbour cursor
  let counter = 0;
  let sinceYield = 0;

  for (let s = 0; s < n; s++) {
    if (order[s] !== -1) {
      continue;
    }

    order[s] = counter;
    low[s] = counter;
    counter++;
    onStack[s] = 1;
    tstack.push(s);
    frameV.push(s);
    frameC.push(0);

    while (frameV.length > 0) {
      const v = frameV[frameV.length - 1];
      const ci = frameC[frameC.length - 1];
      const neighbors = adj[v];

      if (ci < neighbors.length) {
        frameC[frameC.length - 1] = ci + 1;
        const w = neighbors[ci];

        if (order[w] === -1) {
          order[w] = counter;
          low[w] = counter;
          counter++;
          onStack[w] = 1;
          tstack.push(w);
          frameV.push(w);
          frameC.push(0);
        } else if (onStack[w] === 1 && order[w] < low[v]) {
          low[v] = order[w];
        }
      } else {
        if (low[v] === order[v]) {
          popComponent(v, tstack, onStack, comp);
        }

        frameV.pop();
        frameC.pop();

        if (frameV.length > 0) {
          const p = frameV[frameV.length - 1];

          if (low[v] < low[p]) {
            low[p] = low[v];
          }
        }
      }

      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;

        yield;
      }
    }
  }

  return comp;
};

/**
 * Forward directed adjacency (each edge appends `to` to `from`'s list), filtered to
 * one `edgeLabel` if given. A named-but-unknown label matches nothing → no edges.
 * Shared by both SCC and onCycle so their component pass is identical.
 */
const buildForwardAdj = function* (
  graph: Graph,
  order: readonly { id: string }[],
  index: Map<string, number>,
  edgeLabel: string | undefined,
): Generator<void, number[][], void> {
  const adj: number[][] = Array.from({ length: order.length }, () => []);
  let sinceYield = 0;

  for (const edge of graph.edges) {
    if (edgeLabel === undefined || edge.labels.has(edgeLabel)) {
      adj[index.get(edge.from.id)!].push(index.get(edge.to.id)!);
    }

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return adj;
};

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<ComponentRow> {
  const { edgeLabel, writeProperty } = config;

  // Insertion index == native dense id, so the min-index representative resolves to
  // the same vertex in both engines → identical component-id strings.
  const order = yield* materializeVertices(graph);
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  const adj = yield* buildForwardAdj(graph, order, index, edgeLabel);
  let sinceYield = 0;

  const comp = yield* tarjanScc(adj, order.length);
  const rows: ComponentRow[] = [];

  for (let i = 0; i < order.length; i++) {
    const v = order[i];
    const componentId = order[comp[i]].id;

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, componentId);
    }

    rows.push({ node: v.id, componentId });

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * Strongly-connected components via iterative Tarjan — two vertices share a
 * component iff each is reachable from the other along directed edges. Each
 * component id is its first-inserted (lowest-index) member's external id, chosen
 * independently of walk order, so results are byte-identical to the native engine.
 * Resolves `Promise<ComponentRow[]>` without blocking the event loop. Data-last
 * dual-form: `stronglyConnectedComponents(config, graph)` or
 * `stronglyConnectedComponents(config)(graph)`.
 */
export const stronglyConnectedComponents = defineAlgorithm(computeGen);

/** An on-cycle result row: `{ node, onCycle }`. */
export type OnCycleRow = AlgorithmRow<'onCycle', boolean>;

export const onCycleGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<OnCycleRow> {
  const { edgeLabel, writeProperty } = config;
  const order = yield* materializeVertices(graph);
  const index = new Map<string, number>();

  order.forEach((v, i) => index.set(v.id, i));

  const adj = yield* buildForwardAdj(graph, order, index, edgeLabel);
  const comp = yield* tarjanScc(adj, order.length);

  // A vertex is on a cycle iff its SCC has >1 member OR it has a self-loop (adj[v]
  // contains v). Both are derived from the byte-identical Tarjan pass + adjacency.
  const size = new Int32Array(order.length);

  for (let i = 0; i < order.length; i++) {
    size[comp[i]] += 1;
  }

  const rows: OnCycleRow[] = new Array(order.length);
  let sinceYield = 0;

  for (let i = 0; i < order.length; i++) {
    const v = order[i];
    const onCycle = size[comp[i]] > 1 || adj[i].includes(i);

    if (writeProperty !== undefined) {
      v.setProperty(writeProperty, onCycle);
    }

    rows[i] = { node: v.id, onCycle };

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * Per-vertex **cycle membership**: `onCycle` is `true` iff the vertex lies on a
 * directed cycle — its strongly-connected component has more than one member, or it
 * has a self-loop (a 1-cycle). Derived from the same iterative-Tarjan partition as
 * {@link stronglyConnectedComponents}, so it's byte-identical to the native engine.
 * Data-last dual-form: `onCycle(config, graph)` / `onCycle(config)(graph)`.
 */
export const onCycle = defineAlgorithm(onCycleGen);
