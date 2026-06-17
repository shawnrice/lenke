// --- Mutation helpers --------------------------------------------------
//
// `addV` / `addE` / `property` / `drop` mutate the graph in place. The
// underlying `Graph.addVertex` / `addEdge` / `removeVertex` / `removeEdge`
// methods emit events, so subscribers see changes as they happen during
// traversal. Callers who need a transactional "all or nothing" semantic
// should clone the graph first (`graph.clone()`).

import type { Graph, Vertex } from '@pl-graph/core';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { AddEEndpoint, Plan } from '../ast.js';
import { extend, isEdge, isVertex, type RunContext, type Traverser } from './runtime.js';
import { applyPlanToStream, applyStep } from './dispatch.js';
import { applySource } from './sources.js';

export const addVStep = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  label: string | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const v = graph.addVertex({
      labels: label ? [label] : [],
      properties: {},
    });
    yield extend(t, v);
  }
};

// Run an AddE endpoint sub-plan. The sub-plan may start with a source step
// (`V('2')`, `inject(...)`) or may be rooted at the current traverser. We
// detect the source case and route through `applySource` accordingly so
// that `addE('X').to(V('2'))` works alongside `addE('X').to(out('knows'))`.
export const runEndpointPlan = (
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
  rooted: Traverser<unknown>,
): Iterable<Traverser<unknown>> => {
  if (plan.steps.length === 0) {
    return [rooted];
  }
  const first = plan.steps[0];
  if (first.kind === 'V' || first.kind === 'E' || first.kind === 'inject') {
    let stream: Iterable<Traverser<unknown>> = applySource(first, graph);
    for (let i = 1; i < plan.steps.length; i++) {
      stream = applyStep(plan.steps[i], stream, graph, ctx);
    }
    return stream;
  }
  return applyPlanToStream(plan, [rooted], graph, ctx);
};

export const resolveAddEEndpoint = (
  endpoint: AddEEndpoint | undefined,
  t: Traverser<unknown>,
  graph: Graph,
  ctx: RunContext,
): Vertex | null => {
  if (endpoint === undefined) {
    return isVertex(t.value) ? t.value : null;
  }
  if (endpoint.kind === 'tag') {
    // Pop.last semantics — most recent tagged value wins.
    const list = t.tags.get(endpoint.label);
    if (!list || list.length === 0) {
      return null;
    }
    const v = list[list.length - 1];
    return isVertex(v) ? v : null;
  }
  for (const result of runEndpointPlan(endpoint.plan, graph, ctx, t)) {
    return isVertex(result.value) ? result.value : null;
  }
  return null;
};

export const addEStep = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  step: { label: string; from?: AddEEndpoint; to?: AddEEndpoint },
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (step.from === undefined && step.to === undefined) {
      throw new PlGraphError(
        `addE('${step.label}'): at least one of .from() or .to() must be specified`,
        {
          code: ErrorCode.Syntax,
        },
      );
    }
    const from = resolveAddEEndpoint(step.from, t, graph, ctx);
    const to = resolveAddEEndpoint(step.to, t, graph, ctx);
    if (!from || !to) {
      throw new Error(
        `addE('${step.label}'): could not resolve endpoint vertices (from=${!!from}, to=${!!to})`,
      );
    }
    const e = graph.addEdge({
      from,
      to,
      labels: [step.label],
      properties: {},
    });
    yield extend(t, e);
  }
};

export const propertyStep = function* (
  stream: Iterable<Traverser<unknown>>,
  key: string,
  value: unknown,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const v = t.value;
    if (isVertex(v) || isEdge(v)) {
      v.setProperty(key, value);
      yield t;
    }
    // Non-element traversers are silently dropped — `property` only makes
    // sense on a vertex/edge.
  }
};

// eslint-disable-next-line require-yield -- drop is a sink: drains the stream and emits nothing.
export const dropStep = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const v = t.value;
    if (isVertex(v)) {
      graph.removeVertex(v);
    } else if (isEdge(v)) {
      graph.removeEdge(v);
    }
    // `drop` is a sink — emit nothing for any traverser regardless of type.
  }
};
