// Step dispatcher. Routes a single step's `kind` to the per-category impl
// function in `./{category}.ts`. Also hosts `applyPlanToStream`, which is
// called recursively by step impls that take sub-plans (where, filter,
// repeat, branch, optional, choose, union, coalesce, local, flatMap, map,
// sideEffect, fold, etc.).
//
// Cycle: this module imports per-category step impls; those impls import
// `applyPlanToStream` from here. ESM resolves the cycle correctly because
// neither side dereferences the other at module-init — `applyStep` and
// `applyPlanToStream` are only called inside generator bodies.

import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Plan, Step } from '../ast.js';
import { matches, specializePredicate } from '../predicates.js';
// Per-category step impls.
import {
  aggregateComparable,
  aggregateNumber,
  countLocal,
  countStep,
  maxLocal,
  meanLocal,
  minLocal,
  orderLocalStep,
  orderStep,
  sumLocal,
} from './aggregation.js';
import { connectedComponentStep, pageRankStep, peerPressureStep } from './algorithms.js';
import {
  sampleStep,
  skipTraversers,
  sliceLocal,
  tailLocal,
  tailTraversers,
  takeTraversers,
} from './cardinality.js';
import {
  failStep,
  hasRevisit,
  whereCompareStep,
  whereCurrentStep,
  whereSubPlanStep,
} from './filters.js';
import {
  branchStep,
  chooseStep,
  coalesceStep,
  localStep,
  optionalStep,
  repeatStep,
  unionStep,
} from './iteration.js';
import { matchStep } from './match.js';
import { evalMath, mathStep } from './misc.js';
import { edgeToVertex, traverseToEdge, traverseToVertex } from './movement.js';
import { addEStep, addVStep, dropStep, propertyStep } from './mutation.js';
import { optionalHopStep, optionalSingleHop } from './optional-hop.js';
import {
  asStep,
  groupCountStep,
  groupStep,
  pathStep,
  projectElementMap,
  projectProperties,
  projectPropertyMap,
  projectStep,
  projectValueMap,
  projectValues,
  selectColumnStep,
  selectStep,
  treeStep,
} from './projection.js';
import {
  closureView,
  evalBy,
  filterStream,
  filterTraverser,
  firstLabel,
  hasAny,
  isEdge,
  isVertex,
  keyToBy,
  mapTraverser,
  newContext,
  normalizeBys,
  tupleKey,
  type RunContext,
  type Traverser,
  valueDedupeFilter,
} from './runtime.js';
import { sackStep, withSackStep } from './sack.js';
import { shortestPathStep } from './shortest-path.js';
import { aggregateStep, barrierStep, capStep, subgraphStep } from './side-effects.js';
import {
  flatMapFnStep,
  flatMapStep,
  foldFnStep,
  foldStep,
  indexStep,
  injectMidStream,
  mapStep,
  sideEffectFnStep,
  sideEffectStep,
  unfoldStream,
} from './stream.js';
import {
  allHopExistence,
  hopExistenceCombinedStep,
  hopExistenceStep,
  singleHopExistence,
} from './sub-plan-existence.js';

export const applyPlanToStream = (
  plan: Plan,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {
  let s = stream;

  for (const step of plan.steps) {
    s = applyStep(step, s, graph, ctx);
  }

  return s;
};

// eslint-disable-next-line complexity -- step-kind dispatch; complexity is inherent to the switch arity, not cognitive load
export const applyStep = (
  step: Step,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {
  switch (step.kind) {
    case 'V':
    case 'E':
      throw new LenkeError(`${step.kind} can only appear as the first step`, {
        code: ErrorCode.Syntax,
      });

    case 'out':
    case 'in':
    case 'both':
      return traverseToVertex(stream, graph, step);

    case 'outE':
    case 'inE':
    case 'bothE':
      return traverseToEdge(stream, graph, step);

    case 'outV':
    case 'inV':
    case 'bothV':
    case 'otherV':
      return edgeToVertex(stream, step);

    case 'has': {
      // ⚠️ HOISTED OUT OF THE PER-ELEMENT CLOSURE (item 1492), the same change as `propertyCount`'s
      // and for the same reason: `matches` is one megamorphic site shared by ~20 callers, and a
      // specialized closure is monomorphic here. This is the GENERAL has filter, so it is on the
      // row path of every traversal carrying a `has`. `undefined` keeps the original call.
      const fast = specializePredicate(step.pred);
      const { key } = step;

      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }

        const x = v.properties[key];

        return fast === undefined ? matches(step.pred, x) : fast(x);
      });
    }

    case 'hasLabel':
      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }

        return step.labels.some((l) => v.labels.has(l));
      });

    case 'hasId':
      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }

        return step.ids.includes(v.id);
      });

    case 'hasKey':
      return filterStream(stream, (v) => {
        // Element form: vertex/edge with one of the given property keys.
        if (isVertex(v) || isEdge(v)) {
          // Hoisted for the same reason as `evalBy`'s key case: `properties` is a
          // getter over a Map, so re-reading it per key paid the lookup per key.
          const bag = v.properties;

          return step.keys.some((k) => k in bag);
        }

        // Property-object form: filter the stream produced by `properties()`,
        // which yields `{key, value}` per property. Match if the object's
        // `key` field equals one of the given keys.
        if (v !== null && typeof v === 'object' && 'key' in v) {
          return step.keys.includes(v.key as string);
        }

        return false;
      });

    case 'simplePath':
      return filterTraverser(stream, (t) => !hasRevisit(t.path));

    case 'cyclicPath':
      return filterTraverser(stream, (t) => hasRevisit(t.path));

    case 'dedupe': {
      /**
       * ⚠️ THE VALUE-KEYED HALF LIVES IN `dedupe-filter.ts` SINCE ITEM 1869, so the fused
       * `V().values(k).dedupe()` walk can reuse it instead of re-deriving five key spaces. Every
       * measured decision that was here moved WITH the code — read it there before touching a key
       * space. The multi-label form stays below because it reads `t.tags`, not a value.
       */
      const keep = valueDedupeFilter();
      // For the multi-label form only: a stable NUL-joined key per tag tuple.
      const seenTuples = new Set<string>();
      const { labels } = step;
      const by = step.bys?.[0];

      return filterTraverser(stream, (t) => {
        // Multi-label form: dedupe by the tuple of tagged values at the given
        // labels — a stable NUL-joined string key.
        if (labels && labels.length > 0) {
          const k = tupleKey(labels.map((l) => t.tags.get(l)));

          if (seenTuples.has(k)) {
            return false;
          }

          seenTuples.add(k);

          return true;
        }

        return keep(by !== undefined ? evalBy(by, t.value, graph, ctx) : t.value);
      });
    }

    case 'take':
      return step.scope === 'local'
        ? mapTraverser(stream, (v) => sliceLocal(v, 0, step.n))
        : takeTraversers(stream, step.n);

    case 'skip':
      return step.scope === 'local'
        ? mapTraverser(stream, (v) => sliceLocal(v, step.n, Infinity))
        : skipTraversers(stream, step.n);

    case 'range':
      // range(start, end) with end < start (end >= 0) is an invalid window — TinkerPop
      // throws IllegalArgumentException at build time and the native engine rejects it at
      // parse, so fault to match rather than silently yielding []. `limit(0)` = range(0,0)
      // stays valid (end == start → the empty window); end < 0 means unlimited.
      if (step.end >= 0 && step.end < step.start) {
        throw new LenkeError(
          `range(${step.start}, ${step.end}) is not a valid window — the high bound must be ` +
            `greater than or equal to the low bound`,
          { code: ErrorCode.InvalidValue },
        );
      }

      if (step.scope === 'local') {
        const end = step.end < 0 ? Infinity : step.end;

        return mapTraverser(stream, (v) => sliceLocal(v, step.start, end));
      }

      if (step.end < 0) {
        return skipTraversers(stream, step.start);
      }

      return takeTraversers(skipTraversers(stream, step.start), Math.max(0, step.end - step.start));

    case 'tail':
      return step.scope === 'local'
        ? mapTraverser(stream, (v) => tailLocal(v, step.n))
        : tailTraversers(stream, step.n);

    case 'is':
      return filterTraverser(stream, (t) => matches(step.pred, t.value));

    case 'identity':
      return stream;

    case 'inject':
      return injectMidStream(stream, step.values);

    case 'unfold':
      return unfoldStream(stream);

    case 'sum':
      return step.scope === 'local'
        ? mapTraverser(stream, sumLocal)
        : aggregateNumber(stream, 'sum');
    case 'min':
      return step.scope === 'local'
        ? mapTraverser(stream, minLocal)
        : aggregateComparable(stream, 'min');
    case 'max':
      return step.scope === 'local'
        ? mapTraverser(stream, maxLocal)
        : aggregateComparable(stream, 'max');
    case 'mean':
      return step.scope === 'local'
        ? mapTraverser(stream, meanLocal)
        : aggregateNumber(stream, 'mean');

    case 'values':
      return projectValues(stream, step.keys);

    case 'valueMap':
      return projectValueMap(stream, step.keys, step.includeTokens);

    case 'properties':
      return projectProperties(stream, step.keys);

    case 'order': {
      const bys = normalizeBys(step.bys, step.key);
      const desc = step.desc ?? false;

      return step.scope === 'local'
        ? orderLocalStep(stream, bys, desc, graph, ctx)
        : orderStep(stream, bys, desc, graph, ctx, step.cap);
    }

    case 'fail':
      return failStep(stream, step.message);

    case 'where':
      // Three AST shapes share kind 'where'; TS narrows on which fields are set:
      // a sub-plan, a two-key compare (`startKey`), or a current-vs-label predicate.
      if ('plan' in step) {
        // `where(<one adjacency step>)` is a `Map` lookup, not a sub-pipeline — see
        // `sub-plan-existence.ts`. Every other sub-plan shape falls through untouched.
        const exists = singleHopExistence(step.plan);

        return exists === undefined
          ? whereSubPlanStep(stream, step.plan, graph, ctx)
          : hopExistenceStep(stream, exists, true);
      }

      return 'startKey' in step
        ? whereCompareStep(stream, step, graph, ctx)
        : whereCurrentStep(stream, step);

    case 'and': {
      const hops = allHopExistence(step.plans);

      return hops === undefined
        ? filterTraverser(stream, (t) =>
            step.plans.every((p) => hasAny(applyPlanToStream(p, [t], graph, ctx))),
          )
        : hopExistenceCombinedStep(stream, hops, true);
    }

    case 'or': {
      const hops = allHopExistence(step.plans);

      return hops === undefined
        ? filterTraverser(stream, (t) =>
            step.plans.some((p) => hasAny(applyPlanToStream(p, [t], graph, ctx))),
          )
        : hopExistenceCombinedStep(stream, hops, false);
    }

    case 'not': {
      const exists = singleHopExistence(step.plan);

      return exists === undefined
        ? filterTraverser(stream, (t) => !hasAny(applyPlanToStream(step.plan, [t], graph, ctx)))
        : hopExistenceStep(stream, exists, false);
    }

    case 'union':
      return unionStep(stream, step.plans, graph, ctx);

    case 'coalesce':
      return coalesceStep(stream, step.plans, graph, ctx);

    case 'optional': {
      // `optional(<one vertex step>)` — the left-join idiom — is fused into one loop: no
      // per-traverser input array, no sub-plan dispatch, no materialized output. See
      // `optional-hop.ts` for why that is most of the cost and why laziness is safe for this shape
      // only. Every other sub-plan shape falls through untouched.
      const hop = optionalSingleHop(step.plan);

      return hop === undefined
        ? optionalStep(stream, step.plan, graph, ctx)
        : optionalHopStep(stream, hop, graph);
    }

    case 'choose':
      return chooseStep(stream, step.test, step.thenPlan, step.elsePlan, graph, ctx);

    case 'filter': {
      // The same step as the sub-plan `where`, so the same fusion.
      const exists = singleHopExistence(step.plan);

      return exists === undefined
        ? whereSubPlanStep(stream, step.plan, graph, ctx)
        : hopExistenceStep(stream, exists, true);
    }

    case 'hasNot':
      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }

        const bag = v.properties;

        return step.keys.every((k) => !(k in bag));
      });

    case 'value':
      return mapTraverser(stream, (v) => {
        if (v !== null && typeof v === 'object' && 'key' in v && 'value' in v) {
          return (v as { value: unknown }).value;
        }

        return v;
      });

    case 'index':
      return indexStep(stream);

    case 'math':
      return mathStep(stream, step, graph, ctx);

    case 'hasValue':
      return filterStream(stream, (v) => {
        if (v !== null && typeof v === 'object' && 'value' in v) {
          return step.values.includes(v.value);
        }

        return step.values.includes(v);
      });

    case 'match':
      return matchStep(stream, step.patterns, graph, ctx);

    case 'subgraph':
      return subgraphStep(stream, step.key, ctx);

    case 'shortestPath':
      return shortestPathStep(stream, step, graph);

    case 'pageRank':
      return pageRankStep(stream, step, graph);

    case 'connectedComponent':
      return connectedComponentStep(stream, step, graph);

    case 'peerPressure':
      return peerPressureStep(stream, step, graph);

    case 'hasLabelAnd':
      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }

        return v.labels.has(step.label) && matches(step.pred, v.properties[step.key]);
      });

    case 'elementMap':
      return projectElementMap(stream, step.keys);

    case 'propertyMap':
      return projectPropertyMap(stream, step.keys);

    case 'constant':
      return mapTraverser(stream, () => step.value);

    case 'loops':
      return mapTraverser(stream, (_v, t) => t.loopCount);

    case 'sideEffect':
      return sideEffectStep(stream, step.plan, graph, ctx);

    case 'local':
      return localStep(stream, step.plan, graph, ctx);

    case 'none':
      if (step.pred === undefined) {
        // Legacy: drain and emit nothing.
        // eslint-disable-next-line require-yield -- generator-shaped but intentionally yields nothing
        return (function* () {
          for (const _ of stream) {
            // intentionally drop
          }
        })();
      }

      // TinkerPop 3.8: keep traversers whose iterable value has NO element
      // satisfying the predicate. Non-iterable values are filtered out.
      return filterTraverser(stream, (t) => {
        const v = t.value;

        if (
          v === null ||
          v === undefined ||
          typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
        ) {
          return false;
        }

        for (const x of v as Iterable<unknown>) {
          if (matches(step.pred!, x)) {
            return false;
          }
        }

        return true;
      });

    case 'aggregate':
      // `aggregate` is a COLLECTING BARRIER (TinkerPop `aggregate(global)`): it drains the
      // whole upstream into the side-effect eagerly, so a downstream slice/inject cannot
      // cancel it. `store` is the LAZY, non-barrier form.
      return aggregateStep(stream, step.key, ctx, true);

    case 'store':
      return aggregateStep(stream, step.key, ctx, false);

    case 'barrier':
      return barrierStep(stream);

    case 'cap':
      return capStep(stream, ctx, step.key);

    case 'id':
      return mapTraverser(stream, (v) => (isVertex(v) || isEdge(v) ? v.id : undefined));

    case 'label':
      return mapTraverser(stream, (v) => {
        if (isVertex(v) || isEdge(v)) {
          return firstLabel(v.labels) ?? null;
        }

        // For `{key, value}` property objects produced by `properties()`,
        // `label()` returns the key — matching TinkerPop's behavior of
        // treating the property's key field as its "label".
        if (v !== null && typeof v === 'object' && 'key' in v) {
          return v.key;
        }

        return undefined;
      });

    case 'path':
      return pathStep(stream, step.bys, graph, ctx);

    case 'count':
      return step.scope === 'local' ? mapTraverser(stream, countLocal) : countStep(stream);

    case 'fold':
    case 'toList':
      return foldStep(stream);

    case 'repeat':
      return repeatStep(stream, step, graph, ctx);

    case 'as':
      return asStep(stream, step.label);

    case 'select':
      return selectStep(stream, step.labels, step.pop ?? 'last', step.bys, graph, ctx);

    case 'selectColumn':
      return selectColumnStep(stream, step.column);

    case 'group': {
      const keyBy = step.bys?.[0] ?? keyToBy(step.keyBy);
      const valueBy = step.bys?.[1] ?? keyToBy(step.valueBy);

      return groupStep(stream, keyBy, valueBy, graph, ctx);
    }

    case 'groupCount': {
      const by = step.bys?.[0] ?? keyToBy(step.by);

      return groupCountStep(stream, by, graph, ctx);
    }

    case 'project':
      return projectStep(stream, step.keys, step.bys, graph, ctx);

    case 'tree':
      return treeStep(stream, step.bys, graph, ctx);

    case 'branch':
      return branchStep(stream, step.test, step.options, step.default, graph, ctx);

    case 'flatMap':
      return flatMapStep(stream, step.plan, graph, ctx);

    case 'map':
      return mapStep(stream, step.plan, graph, ctx);

    case 'mapFn':
      return mapTraverser(stream, (v, t) => step.fn(v, closureView(t, ctx)));

    case 'flatMapFn':
      return flatMapFnStep(stream, step.fn, ctx);

    case 'filterFn':
      return filterTraverser(stream, (t) => step.fn(t.value, closureView(t, ctx)));

    case 'sideEffectFn':
      return sideEffectFnStep(stream, step.fn, ctx);

    case 'foldFn':
      return foldFnStep(stream, step.seed, step.fn, ctx);

    case 'sample':
      return sampleStep(stream, step.n);

    case 'addV':
      return addVStep(stream, graph, step.label);

    case 'addE':
      return addEStep(stream, graph, step, ctx);

    case 'property':
      return propertyStep(stream, step.key, step.value, graph, ctx);

    case 'withSack':
      return withSackStep(stream, step.init, ctx);

    case 'sack':
      return sackStep(stream, step.op, step.bys, graph, ctx);

    case 'drop':
      return dropStep(stream, graph);
  }
};

// Re-export `evalMath` for any consumer that wants it; only the dispatcher
// references it through `mathStep`, so this is mostly future-proofing.
export { evalMath };
