import type { Graph } from '@pl-graph/core';

import type { ID, Step } from '../ast.js';
import { newContext, startTraverser, type Traverser } from './_internals.js';
import { addEStep, addVStep } from './mutation.js';

export const applySource = (
  step: Step,
  graph: Graph,
): Iterable<Traverser<unknown>> => {
  switch (step.kind) {
    case 'V':
      return sourceFromIds(graph.vertices, step.ids, (id) => graph.getVertexById(String(id)));
    case 'E':
      return sourceFromIds(graph.edges, step.ids, (id) => graph.getEdgeById(String(id)));
    case 'inject':
      return injectAsSource(step.values);
    case 'addV':
      // `g.addV()`-style source: emit exactly one freshly-created vertex.
      return addVStep([startTraverser(undefined)], graph, step.label);
    case 'addE':
      // `g.addE(label)`-style source: emit one new edge, but only if both
      // endpoints are explicitly provided (no input traverser to default to).
      return addEStep([startTraverser(undefined)], graph, step, newContext());
    default:
      throw new Error(`Plan must start with V(), E(), inject(), addV(), or addE(), got ${step.kind}`);
  }
};

export const injectAsSource = function* (values: readonly unknown[]): Iterable<Traverser<unknown>> {
  for (const v of values) {
    yield startTraverser(v);
  }
};

export const sourceFromIds = function* <T extends { readonly id: string }>(
  all: Iterable<T>,
  ids: readonly ID[] | undefined,
  byId: (id: ID) => T | null,
): Iterable<Traverser<T>> {
  if (!ids) {
    for (const x of all) {
      yield startTraverser(x);
    }
    return;
  }
  for (const id of ids) {
    const x = byId(id);
    if (x) {
      yield startTraverser(x);
    }
  }
};
