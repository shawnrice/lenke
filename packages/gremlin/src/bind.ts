import type { Graph } from '@pl-graph/core';

import type { Plan } from './ast.js';
import { run, toArray, toSet } from './executor.js';

/**
 * A graph with the gremlin query API closed over it.
 *
 * Returned by `bind(graph)` — useful when a single consumer wants to run
 * many queries against the same graph and would rather not pass `graph`
 * to every call. Has no effect on `Graph`'s own surface; keep using the
 * free `run`/`toArray`/`toSet` functions when a one-shot is more direct.
 */
export type GremlinBound = {
  query: (plan: Plan) => Iterable<unknown>;
  toArray: (plan: Plan) => unknown[];
  toSet: (plan: Plan) => Set<unknown>;
};

export const bind = (graph: Graph): GremlinBound => ({
  query: (plan) => run(plan, graph),
  toArray: (plan) => toArray(plan, graph),
  toSet: (plan) => toSet(plan, graph),
});
