import type { Graph } from '../core/Graph.js';
import type { AlgorithmConfig } from './types.js';

/**
 * A graph algorithm expressed as a generator: it `yield`s at safe checkpoints
 * (between iterations, or every {@link YIELD_EVERY} items of a single pass) and
 * finally `return`s its rows. The public functions drive it with a macrotask
 * between checkpoints, so a long computation never blocks the event loop.
 */
export type AlgorithmGen<Row> = Generator<void, Row[], void>;

/**
 * Items (vertices / edges / frontier pops) a single-pass algorithm processes
 * between checkpoints. Large enough that the per-checkpoint macrotask overhead is
 * negligible, small enough that a chunk stays well under a frame.
 */
export const YIELD_EVERY = 16_384;

/**
 * Yield control to the host event loop once, so pending I/O / timers / rendering
 * can run before the next chunk. A macrotask (`setTimeout(0)`) rather than a
 * microtask, since microtasks would starve I/O just like a synchronous loop does.
 */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Run a generator to completion, awaiting a macrotask at each checkpoint. The
 * result is exactly what the body computes — the checkpoints only interleave the
 * same work with the event loop; they never change it.
 */
export const drain = async <Row>(gen: AlgorithmGen<Row>): Promise<Row[]> => {
  let step = gen.next();

  while (!step.done) {
    await yieldToEventLoop();
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
