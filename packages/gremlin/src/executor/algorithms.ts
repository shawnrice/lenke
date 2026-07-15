import { type AlgorithmConfig, type Graph, runAlgorithmSync } from '@lenke/core';

import type { Step } from '../ast.js';
import type { Traverser } from './runtime.js';

/**
 * TinkerPop default result-property names for the OLAP `VertexProgram`s, used
 * when the step is not given an explicit `.with(<Algo>.propertyName, …)`.
 */
const DEFAULT_PAGE_RANK_PROPERTY = 'gremlin.pageRankVertexProgram.pageRank';
const DEFAULT_COMPONENT_PROPERTY = 'gremlin.connectedComponentVertexProgram.component';
const DEFAULT_CLUSTER_PROPERTY = 'gremlin.peerPressureVertexProgram.cluster';

/**
 * Run a whole-graph OLAP algorithm locally, writing each vertex's result to a
 * property, then pass the incoming traversers through unchanged so a downstream
 * step reads the property (`g.V().pageRank().order().by('…')`). The computation
 * is synchronous — an OLAP step is a stop-the-world job (cf. TinkerPop's
 * GraphComputer); `withComputer()` is consumed upstream as a no-op marker. It
 * runs once, when the stream is first pulled, over the entire graph regardless of
 * how many traversers flow through.
 */
const algorithmStep = function* (
  graph: Graph,
  config: AlgorithmConfig,
  name: 'pagerank' | 'connectedComponents' | 'peerPressure',
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  runAlgorithmSync(name, config, graph);

  yield* stream;
};

export const pageRankStep = (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'pageRank' }>,
  graph: Graph,
): Iterable<Traverser<unknown>> =>
  algorithmStep(
    graph,
    {
      writeProperty: step.property ?? DEFAULT_PAGE_RANK_PROPERTY,
      ...(step.times !== undefined ? { iterations: step.times } : {}),
      ...(step.alpha !== undefined ? { dampingFactor: step.alpha } : {}),
    },
    'pagerank',
    stream,
  );

export const connectedComponentStep = (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'connectedComponent' }>,
  graph: Graph,
): Iterable<Traverser<unknown>> =>
  algorithmStep(
    graph,
    { writeProperty: step.property ?? DEFAULT_COMPONENT_PROPERTY },
    'connectedComponents',
    stream,
  );

export const peerPressureStep = (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'peerPressure' }>,
  graph: Graph,
): Iterable<Traverser<unknown>> =>
  algorithmStep(
    graph,
    {
      writeProperty: step.property ?? DEFAULT_CLUSTER_PROPERTY,
      ...(step.times !== undefined ? { iterations: step.times } : {}),
    },
    'peerPressure',
    stream,
  );
