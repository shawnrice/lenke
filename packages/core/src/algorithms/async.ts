import type { Graph } from '../core/Graph.js';
import type { AlgorithmConfig } from './types.js';

/**
 * A graph algorithm expressed as a generator: it `yield`s at safe checkpoints
 * (e.g. between iterations) and finally `return`s its rows. Driving it synchronously
 * reproduces the plain function exactly; driving it with a yield between checkpoints
 * keeps the event loop responsive. One body → both surfaces, so they can't drift.
 */
export type AlgorithmGen<Row> = Generator<void, Row[], void>;

/** Run a generator to completion synchronously — the sync algorithm surface. */
export const drainSync = <Row>(gen: AlgorithmGen<Row>): Row[] => {
  let step = gen.next();

  while (!step.done) {
    step = gen.next();
  }

  return step.value;
};

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
 * Run a generator to completion, awaiting a macrotask at each checkpoint so the
 * process (or browser UI) stays responsive during a long computation. The result
 * is byte-identical to {@link drainSync} — the checkpoints only interleave the same
 * work with the event loop; they do not change it.
 */
export const drainAsync = async <Row>(gen: AlgorithmGen<Row>): Promise<Row[]> => {
  let step = gen.next();

  while (!step.done) {
    await yieldToEventLoop();
    step = gen.next();
  }

  return step.value;
};

/**
 * Build the data-last, dual-form async variant of an algorithm from its generator
 * factory — callable as `algoAsync(config, graph)` or `algoAsync(config)(graph)`,
 * matching the sync surface. Resolves to the same rows the sync function returns.
 */
export const asyncAlgorithm =
  <Row>(gen: (config: AlgorithmConfig, graph: Graph) => AlgorithmGen<Row>) =>
  (config: AlgorithmConfig, graph?: Graph): Promise<Row[]> | ((graph: Graph) => Promise<Row[]>) =>
    graph ? drainAsync(gen(config, graph)) : (g: Graph) => drainAsync(gen(config, g));
