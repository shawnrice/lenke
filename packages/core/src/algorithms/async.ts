import type { Graph } from '../core/Graph.js';
import type { Vertex } from '../core/Vertex.js';
import type { AlgorithmConfig } from './types.js';

/**
 * A graph algorithm expressed as a generator: it `yield`s frequently at safe
 * points (every {@link YIELD_EVERY} items, and between iterations) and finally
 * `return`s its rows. The driver ({@link drain}) throttles the *actual* event-loop
 * yields to a time budget, so a long computation stays responsive without the
 * per-item overhead of yielding for real every time.
 */
export type AlgorithmGen<Row> = Generator<void, Row[], void>;

/**
 * How many items (vertices / edges / frontier pops) a generator processes between
 * `yield` checkpoints. Small, so the synchronous burst between checkpoints stays
 * well under the frame budget even for the most expensive per-item algorithm
 * (Dijkstra ≈ 7 µs/pop → ≈ 1.8 ms for 256). The driver decides whether each
 * checkpoint becomes a real yield, so a small value here is cheap.
 */
export const YIELD_EVERY = 256;

/**
 * Max wall-clock a chunk of work runs before yielding to the event loop. ~5 ms
 * (React's time-slice) leaves ~11 ms of a 16.7 ms frame for the browser's own
 * layout/paint, so a long algorithm drops few or no frames.
 */
const BUDGET_MS = 5;

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

/**
 * Materialize `graph.vertices` (insertion order) into an array, yielding at
 * checkpoints so even this O(V) setup step over a huge vertex set never blocks a
 * frame. Delegate with `const order = yield* materializeVertices(graph)`.
 */
export function* materializeVertices(graph: Graph): Generator<void, Vertex[], void> {
  const order: Vertex[] = [];
  let since = 0;

  for (const v of graph.vertices) {
    order.push(v);

    if (++since >= YIELD_EVERY) {
      since = 0;

      yield;
    }
  }

  return order;
}

/**
 * Schedule a callback as a **macrotask** (so I/O and rendering can run before it),
 * using the fastest primitive the host offers: `setImmediate` on Node/Bun, a
 * `MessageChannel` in the browser (neither is clamped like `setTimeout(0)`, which
 * browsers throttle to ~4 ms and would roughly double a sliced run's wall-clock).
 */
const scheduleMacrotask: (task: () => void) => void = (() => {
  if (typeof setImmediate === 'function') {
    return (task) => void setImmediate(task);
  }

  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    const queue: Array<() => void> = [];
    channel.port1.onmessage = () => queue.shift()?.();

    return (task) => {
      queue.push(task);
      channel.port2.postMessage(null);
    };
  }

  return (task) => void setTimeout(task, 0);
})();

const nextTick = (): Promise<void> => new Promise((resolve) => scheduleMacrotask(resolve));

/**
 * Run a generator to completion, yielding to the event loop whenever a chunk has
 * run for {@link BUDGET_MS}. The generator offers checkpoints often; most are
 * resumed immediately (no event-loop round-trip) and only ~one per budget window
 * becomes a real macrotask yield — so chunks are time-bounded (frame-safe) and
 * independent of the algorithm's per-item cost. The result is exactly what the body
 * computes; the yields only interleave the same work with the event loop.
 */
export const drain = async <Row>(gen: AlgorithmGen<Row>): Promise<Row[]> => {
  let deadline = now() + BUDGET_MS;
  let step = gen.next();

  while (!step.done) {
    if (now() >= deadline) {
      await nextTick();
      deadline = now() + BUDGET_MS;
    }

    step = gen.next();
  }

  return step.value;
};

/**
 * Build a data-last, dual-form algorithm from its generator factory — callable as
 * `algo(config, graph)` or `algo(config)(graph)`, always resolving to `Promise<Row[]>`.
 */
export function defineAlgorithm<Row>(
  gen: (config: AlgorithmConfig, graph: Graph) => AlgorithmGen<Row>,
): {
  (config: AlgorithmConfig): (graph: Graph) => Promise<Row[]>;
  (config: AlgorithmConfig, graph: Graph): Promise<Row[]>;
} {
  function algorithm(config: AlgorithmConfig): (graph: Graph) => Promise<Row[]>;
  function algorithm(config: AlgorithmConfig, graph: Graph): Promise<Row[]>;
  function algorithm(
    config: AlgorithmConfig,
    graph?: Graph,
  ): Promise<Row[]> | ((graph: Graph) => Promise<Row[]>) {
    return graph ? drain(gen(config, graph)) : (g: Graph) => drain(gen(config, g));
  }

  return algorithm;
}
