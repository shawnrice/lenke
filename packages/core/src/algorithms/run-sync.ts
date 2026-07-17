import type { Graph } from '../core/Graph.js';
import { drainSync } from './async.js';
import { betweennessGen, closenessGen } from './centrality.js';
import { computeGen as connectedComponentsGen } from './connected-components.js';
import { computeGen as degreeGen } from './degree.js';
import { computeGen as labelPropagationGen } from './label-propagation.js';
import { computeGen as pagerankGen } from './pagerank.js';
import { computeGen as peerPressureGen } from './peer-pressure.js';
import { computeGen as shortestPathGen } from './shortest-path.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/**
 * Every graph algorithm a query engine can run synchronously (Gremlin OLAP steps,
 * GQL `CALL`). Names match the native `algo::run_with` dispatcher so a config
 * object is portable across engines.
 */
export type AlgorithmName =
  | 'pagerank'
  | 'connectedComponents'
  | 'peerPressure'
  | 'degree'
  | 'labelPropagation'
  | 'betweenness'
  | 'closeness'
  | 'shortestPath';

/**
 * Synchronously run a whole-graph algorithm and (when `config.writeProperty` is
 * set) write each vertex's result to that property — the mirror of native
 * `algo::run_with`, used by the GQL / Gremlin engines to embed an algorithm in a
 * synchronous query. Blocks for the whole computation (see {@link drainSync}); the
 * async `@lenke/core` free functions are the non-blocking path. The generator
 * bodies are the *same* ones the async functions drive, so results stay
 * byte-identical to both the async path and the native engine.
 */
export const runAlgorithmSync = (
  name: AlgorithmName,
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
    case 'degree':
      return drainSync(degreeGen(config, graph));
    case 'labelPropagation':
      return drainSync(labelPropagationGen(config, graph));
    case 'betweenness':
      return drainSync(betweennessGen(config, graph));
    case 'closeness':
      return drainSync(closenessGen(config, graph));
    case 'shortestPath':
      return drainSync(shortestPathGen(config, graph));
  }
};
