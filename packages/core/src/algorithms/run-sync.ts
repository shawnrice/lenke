import type { Graph } from '../core/Graph.js';
import { drainSync } from './async.js';
import { computeGen as connectedComponentsGen } from './connected-components.js';
import { computeGen as pagerankGen } from './pagerank.js';
import { computeGen as peerPressureGen } from './peer-pressure.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/**
 * The OLAP algorithms a query engine can embed as a step. Names match the native
 * `algo::run_with` dispatcher so a config object is portable across engines.
 */
export type OlapAlgorithmName = 'pagerank' | 'connectedComponents' | 'peerPressure';

/**
 * Synchronously run a whole-graph algorithm and (when `config.writeProperty` is
 * set) write each vertex's result to that property — the mirror of native
 * `algo::run_with`, used by the GQL / Gremlin engines to expose OLAP steps inside
 * a synchronous traversal. Blocks for the whole computation (see {@link drainSync});
 * the async `@lenke/core` free functions are the non-blocking path. The generator
 * bodies are the *same* ones the async functions drive, so results stay
 * byte-identical to both the async path and the native engine.
 */
export const runAlgorithmSync = (
  name: OlapAlgorithmName,
  config: AlgorithmConfig,
  graph: Graph,
): Array<AlgorithmRow<string, unknown>> => {
  switch (name) {
    case 'pagerank':
      return drainSync(pagerankGen(config, graph));
    case 'connectedComponents':
      return drainSync(connectedComponentsGen(config, graph));
    case 'peerPressure':
      return drainSync(peerPressureGen(config, graph));
  }
};
