import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { ID, Step } from '../ast.js';
import { addEStep, addVStep } from './mutation.js';
import { newContext, startTraverser, type Traverser } from './runtime.js';

// Element ids in this engine are STRINGS. Looking one up by a NON-string id (`g.V(1)`
// with a numeric literal) is a type error, NOT a silent coercion to `'1'` — this matches
// Apache TinkerPop under its STRING id manager ("Expected an id convertible to String but
// received Integer"), the ground truth for Gremlin semantics. The builder still accepts a
// numeric literal in the AST; it faults here, at resolution, on a string-id graph.
const asStringId = (id: ID): string => {
  if (typeof id !== 'string') {
    throw new LenkeError(`a vertex/edge id must be a string; got ${typeof id} \`${String(id)}\``, {
      code: ErrorCode.InvalidValue,
    });
  }

  return id;
};

export const applySource = (
  step: Step,
  graph: Graph,
  tracksPath = true,
): Iterable<Traverser<unknown>> => {
  switch (step.kind) {
    case 'V':
      return sourceFromIds(
        graph.vertices,
        step.ids,
        (id) => graph.getVertexById(asStringId(id)),
        tracksPath,
      );
    case 'E':
      return sourceFromIds(
        graph.edges,
        step.ids,
        (id) => graph.getEdgeById(asStringId(id)),
        tracksPath,
      );
    case 'inject':
      return injectAsSource(step.values, tracksPath);
    case 'addV':
      // `g.addV()`-style source: emit exactly one freshly-created vertex.
      return addVStep([startTraverser(undefined, tracksPath)], graph, step.label);
    case 'addE':
      // `g.addE(label)`-style source: emit one new edge, but only if both
      // endpoints are explicitly provided (no input traverser to default to).
      return addEStep([startTraverser(undefined, tracksPath)], graph, step, newContext());
    default:
      throw new LenkeError(
        `Plan must start with V(), E(), inject(), addV(), or addE(), got ${step.kind}`,
        { code: ErrorCode.Syntax },
      );
  }
};

export const injectAsSource = function* (
  values: readonly unknown[],
  tracksPath = true,
): Iterable<Traverser<unknown>> {
  for (const v of values) {
    yield startTraverser(v, tracksPath);
  }
};

export const sourceFromIds = function* <T extends { readonly id: string }>(
  all: Iterable<T>,
  ids: readonly ID[] | undefined,
  byId: (id: ID) => T | null,
  tracksPath = true,
): Iterable<Traverser<T>> {
  if (!ids) {
    for (const x of all) {
      yield startTraverser(x, tracksPath);
    }

    return;
  }

  for (const id of ids) {
    const x = byId(id);

    if (x) {
      yield startTraverser(x, tracksPath);
    }
  }
};
