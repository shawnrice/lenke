import type { Edge, Graph, Vertex } from '@pl-graph/core';

import type {
  AddEEndpoint,
  By,
  FlatMapClosure,
  ID,
  Plan,
  Predicate,
  ReducerClosure,
  SideEffectClosure,
  Step,
} from './ast.js';
import { bothEdgesOf, inEdgesOf, outEdgesOf } from './graph-queries.js';
import { matches } from './predicates.js';

/**
 * Runtime traverser. Carries the current value and the path of values seen
 * to reach it. Path is immutable — branching produces fresh paths via
 * structural sharing.
 */
type Traverser<T> = {
  readonly value: T;
  readonly path: readonly unknown[];
  /** Number of repeat-body iterations entered so far. 0 outside any repeat. */
  readonly loopCount: number;
  /**
   * Labeled positions tagged via `as(label)`, recalled by `select(label)`.
   * A label can accumulate multiple values inside iterative steps (e.g.
   * `repeat(out().as('a'))`); `select(Pop.first|last|all, 'a')` picks how
   * to read. The default `select('a')` returns the last tagged value.
   */
  readonly tags: ReadonlyMap<string, readonly unknown[]>;
};

const emptyTags: ReadonlyMap<string, readonly unknown[]> = new Map();

const isEmptyPlan = (plan: Plan): boolean => plan.steps.length === 0;

const startTraverser = <T>(value: T): Traverser<T> => ({
  value,
  path: [value],
  loopCount: 0,
  tags: emptyTags,
});

const extend = <T>(prev: Traverser<unknown>, value: T): Traverser<T> => ({
  value,
  path: [...prev.path, value],
  loopCount: prev.loopCount,
  tags: prev.tags,
});

const incLoops = <T>(t: Traverser<T>): Traverser<T> => ({
  ...t,
  loopCount: t.loopCount + 1,
});

const isVertex = (x: unknown): x is Vertex =>
  typeof x === 'object' && x !== null && 'id' in x && !('from' in x);

const isEdge = (x: unknown): x is Edge =>
  typeof x === 'object' && x !== null && 'from' in x && 'to' in x;

const firstLabel = (s: ReadonlySet<string>): string | undefined => {
  for (const l of s) {
    return l;
  }
  return undefined;
};

/**
 * Per-run context — currently just the side-effects bag for
 * `aggregate(key)` / `cap(key)`. Passed by reference so all steps in a
 * single `run()` share the same bag.
 */
type RunContext = {
  readonly sideEffects: Map<string, unknown[]>;
};

const newContext = (): RunContext => ({ sideEffects: new Map() });

/**
 * Project a runtime `Traverser` plus the run's side-effects into the
 * read-only view that user closures see. Built lazily per-call (rather than
 * stored on every traverser) because side-effects are per-run, not per-
 * traverser; threading the same Map reference avoids per-traverser overhead.
 */
const closureView = (
  t: Traverser<unknown>,
  ctx: RunContext,
): {
  value: unknown;
  path: readonly unknown[];
  loopCount: number;
  tags: ReadonlyMap<string, readonly unknown[]>;
  sideEffects: ReadonlyMap<string, readonly unknown[]>;
} => ({
  value: t.value,
  path: t.path,
  loopCount: t.loopCount,
  tags: t.tags,
  sideEffects: ctx.sideEffects,
});

/**
 * Run a plan against a graph. Always returns an `Iterable<unknown>` —
 * terminal steps (`count`, `fold`, `toList`) yield exactly one value; other
 * steps yield zero or more. This matches Gremlin's "every step is a stream"
 * model and keeps `pipe(count(), is(gt(5)))` composable.
 */
export const run = (
  plan: Plan,
  graph: Graph,
): Iterable<unknown> => {
  const ctx = newContext();
  let stream: Iterable<Traverser<unknown>> | null = null;

  for (const step of plan.steps) {
    if (stream === null) {
      stream = applySource(step, graph);
      continue;
    }
    stream = applyStep(step, stream, graph, ctx);
  }

  return unwrap(stream ?? []);
};

/**
 * Eager terminal: run the plan and collect every emitted value into an array.
 *
 * Equivalent to `[...run(plan, graph)]`. Provided for parity with legacy and
 * because the intent ("I want the answer as an array, not a lazy iterable")
 * is common enough to deserve a name.
 */
export const toArray = (plan: Plan, graph: Graph): unknown[] =>
  [...run(plan, graph)];

/**
 * Eager terminal: run the plan and collect emitted values into a Set, dropping
 * duplicates by JS reference/primitive equality.
 *
 * Equivalent to `new Set(run(plan, graph))`. For value-based de-duplication
 * over vertices/edges/objects, prefer the `dedupe()` step inside the plan —
 * a `Set` only de-dupes by `===`, so two distinct vertex objects with the same
 * `id` would both be retained.
 */
export const toSet = (plan: Plan, graph: Graph): Set<unknown> =>
  new Set(run(plan, graph));

const unwrap = function* (stream: Iterable<Traverser<unknown>>): Iterable<unknown> {
  for (const t of stream) {
    yield t.value;
  }
};

const applySource = (
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

const injectAsSource = function* (values: readonly unknown[]): Iterable<Traverser<unknown>> {
  for (const v of values) {
    yield startTraverser(v);
  }
};

const sourceFromIds = function* <T extends { readonly id: string }>(
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

// eslint-disable-next-line complexity -- step-kind dispatch; complexity is inherent to the switch arity, not cognitive load
const applyStep = (
  step: Step,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {
  switch (step.kind) {
    case 'V':
    case 'E':
      throw new Error(`${step.kind} can only appear as the first step`);

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

    case 'has':
      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }
        return matches(step.pred, v.properties[step.key]);
      });

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
          return step.keys.some((k) => k in v.properties);
        }
        // Property-object form: filter the stream produced by `properties()`,
        // which yields `{key, value}` per property. Match if the object's
        // `key` field equals one of the given keys.
        if (v !== null && typeof v === 'object' && 'key' in v) {
          return step.keys.includes((v as { key: unknown }).key as string);
        }
        return false;
      });

    case 'simplePath':
      return filterTraverser(stream, (t) => !hasRevisit(t.path));

    case 'cyclicPath':
      return filterTraverser(stream, (t) => hasRevisit(t.path));

    case 'dedupe': {
      const seen = new Set<unknown>();
      const {labels} = step;
      const by = step.bys?.[0];
      return filterTraverser(stream, (t) => {
        // Multi-label form: dedupe by the tuple of tagged values at the given
        // labels. Joining with a NUL separator gives a stable string key for
        // the Set without colliding across reasonable inputs.
        const fallback = by !== undefined ? evalBy(by, t.value, graph, ctx) : t.value;
        const k =
          labels && labels.length > 0 ? tupleKey(labels.map((l) => t.tags.get(l))) : fallback;
        if (seen.has(k)) {
          return false;
        }
        seen.add(k);
        return true;
      });
    }

    case 'take':
      return takeTraversers(stream, step.n);

    case 'skip':
      return skipTraversers(stream, step.n);

    case 'range':
      if (step.end < 0) {
        return skipTraversers(stream, step.start);
      }
      return takeTraversers(skipTraversers(stream, step.start), Math.max(0, step.end - step.start));

    case 'tail':
      return tailTraversers(stream, step.n);

    case 'is':
      return filterTraverser(stream, (t) => matches(step.pred, t.value));

    case 'identity':
      return stream;

    case 'inject':
      return injectMidStream(stream, step.values);

    case 'unfold':
      return unfoldStream(stream);

    case 'sum':
      return aggregateNumber(stream, 'sum');
    case 'min':
      return aggregateComparable(stream, 'min');
    case 'max':
      return aggregateComparable(stream, 'max');
    case 'mean':
      return aggregateNumber(stream, 'mean');

    case 'values':
      return projectValues(stream, step.keys);

    case 'valueMap':
      return projectValueMap(stream, step.keys);

    case 'properties':
      return projectProperties(stream, step.keys);

    case 'order':
      return orderStep(stream, normalizeBys(step.bys, step.key), step.desc ?? false, graph, ctx);

    case 'fail':
      return failStep(stream, step.message);

    case 'where':
      // Two AST shapes share kind 'where'; TS narrows on which fields are set.
      return 'plan' in step
        ? whereSubPlanStep(stream, step.plan, graph)
        : whereCompareStep(stream, step, graph, ctx);

    case 'and':
      return filterTraverser(stream, (t) =>
        step.plans.every((p) => hasAny(applyPlanToStream(p, [t], graph))),
      );

    case 'or':
      return filterTraverser(stream, (t) =>
        step.plans.some((p) => hasAny(applyPlanToStream(p, [t], graph))),
      );

    case 'not':
      return filterTraverser(stream, (t) => !hasAny(applyPlanToStream(step.plan, [t], graph)));

    case 'union':
      return unionStep(stream, step.plans, graph);

    case 'coalesce':
      return coalesceStep(stream, step.plans, graph);

    case 'optional':
      return optionalStep(stream, step.plan, graph);

    case 'choose':
      return chooseStep(stream, step.test, step.thenPlan, step.elsePlan, graph);

    case 'filter':
      return whereSubPlanStep(stream, step.plan, graph);

    case 'hasNot':
      return filterStream(stream, (v) => {
        if (!isVertex(v) && !isEdge(v)) {
          return false;
        }
        return step.keys.every((k) => !(k in v.properties));
      });

    case 'value':
      return mapTraverser(stream, (v) => {
        if (
          v !== null &&
          typeof v === 'object' &&
          'key' in (v as object) &&
          'value' in (v as object)
        ) {
          return (v as { value: unknown }).value;
        }
        return v;
      });

    case 'index':
      return indexStep(stream);

    case 'math':
      return mathStep(stream, step.expr);

    case 'hasValue':
      return filterStream(stream, (v) => {
        if (
          v !== null &&
          typeof v === 'object' &&
          'value' in (v as object)
        ) {
          return step.values.includes((v as { value: unknown }).value);
        }
        return step.values.includes(v);
      });

    case 'match':
      throw new Error('match() is not yet implemented');

    case 'subgraph':
      throw new Error('subgraph() is not yet implemented');

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
        if (v === null || v === undefined || typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
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
    case 'store':
      // Today both append per-traverser without a barrier. Distinct AST kinds
      // so a future optimizer can introduce a barrier on `aggregate` only.
      return aggregateStep(stream, step.key, ctx);

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
          return (v as { key: unknown }).key;
        }
        return undefined;
      });

    case 'path':
      return pathStep(stream, step.bys, graph, ctx);

    case 'count':
      return countStep(stream);

    case 'fold':
    case 'toList':
      return foldStep(stream);

    case 'repeat':
      return repeatStep(stream, step, graph);

    case 'as':
      return asStep(stream, step.label);

    case 'select':
      return selectStep(stream, step.labels, step.pop ?? 'last', step.bys, graph, ctx);

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
      return branchStep(stream, step.test, step.options, step.default, graph);

    case 'flatMap':
      return flatMapStep(stream, step.plan, graph);

    case 'map':
      return mapStep(stream, step.plan, graph);

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
      return propertyStep(stream, step.key, step.value);

    case 'drop':
      return dropStep(stream, graph);
  }
};

// Build a stable string key from a tuple of values. Vertices/edges are keyed
// by `id` (graph-unique); other values fall through to JSON. NUL separates
// fields so distinct tuples can't collide via concatenation.
const tupleKey = (parts: readonly unknown[]): string =>
  parts
    .map((p) => {
      if (isVertex(p) || isEdge(p)) {
        return `@${p.id}`;
      }
      return JSON.stringify(p) ?? 'undefined';
    })
    .join('\x00');

// `by` legacy fallback: if a step has no `bys`, reconstruct one from a legacy
// property-name field (e.g. `order.key`, `group.keyBy`).
const keyToBy = (key: string | undefined): By =>
  key === undefined ? { kind: 'identity' } : { kind: 'key', key };

// Normalize legacy `key` field into a one-element `bys` array if `bys` is unset.
const normalizeBys = (
  bys: readonly By[] | undefined,
  legacyKey: string | undefined,
): readonly By[] => {
  if (bys && bys.length > 0) {
    return bys;
  }
  if (legacyKey !== undefined) {
    return [{ kind: 'key', key: legacyKey }];
  }
  return [{ kind: 'identity' }];
};

// Evaluate a `By` modulator against a single value. The traversal form runs
// the sub-plan with `value` as the starting traverser and projects to its
// first emitted result (or `undefined` if empty).
const evalBy = (by: By, value: unknown, graph: Graph, ctx: RunContext): unknown => {
  switch (by.kind) {
    case 'identity':
      return value;
    case 'key':
      if (isVertex(value) || isEdge(value)) {
        return value.properties[by.key];
      }
      return value;
    case 'traversal': {
      const out = applyPlanToStream(by.plan, [startTraverser(value)], graph, ctx);
      for (const t of out) {
        return t.value;
      }
      return undefined;
    }
    case 'token':
      return projectToken(by.token, value);
  }
};

// `T.id` / `T.label` / `T.key` / `T.value` projection.
const projectToken = (
  token: 'id' | 'label' | 'key' | 'value',
  value: unknown,
): unknown => {
  if (token === 'id') {
    return isVertex(value) || isEdge(value) ? value.id : undefined;
  }
  if (token === 'label') {
    return isVertex(value) || isEdge(value) ? (firstLabel(value.labels) ?? null) : undefined;
  }
  // `T.key` / `T.value` apply to property objects of shape `{ key, value }`
  // (as produced by `properties()`). For anything else, undefined.
  if (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    'value' in value
  ) {
    return (value as { key: unknown; value: unknown })[token];
  }
  return undefined;
};

const groupStep = function* (
  stream: Iterable<Traverser<unknown>>,
  keyBy: By,
  valueBy: By,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const result = new Map<unknown, unknown[]>();
  for (const t of stream) {
    const k = evalBy(keyBy, t.value, graph, ctx);
    const v = evalBy(valueBy, t.value, graph, ctx);
    const list = result.get(k);
    if (list) {
      list.push(v);
    } else {
      result.set(k, [v]);
    }
  }
  yield startTraverser(result);
};

const groupCountStep = function* (
  stream: Iterable<Traverser<unknown>>,
  by: By,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const result = new Map<unknown, number>();
  for (const t of stream) {
    const k = evalBy(by, t.value, graph, ctx);
    result.set(k, (result.get(k) ?? 0) + 1);
  }
  yield startTraverser(result);
};

const projectStep = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[],
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const by = bys?.[i] ?? { kind: 'identity' as const };
      out[keys[i]!] = evalBy(by, t.value, graph, ctx);
    }
    yield extend(t, out);
  }
};

const asStep = function* (
  stream: Iterable<Traverser<unknown>>,
  label: string,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const tags = new Map<string, readonly unknown[]>(t.tags);
    const existing = tags.get(label) ?? [];
    tags.set(label, [...existing, t.value]);
    yield { ...t, tags };
  }
};

// Pop modes for `select`: choose which value to recall when a label was
// tagged multiple times (e.g. inside `repeat`).
type Pop = 'first' | 'last' | 'all';

const recallTag = (
  tags: ReadonlyMap<string, readonly unknown[]>,
  label: string,
  pop: Pop,
): { ok: true; value: unknown } | { ok: false } => {
  const list = tags.get(label);
  if (!list || list.length === 0) {
    return { ok: false };
  }
  if (pop === 'first') {
    return { ok: true, value: list[0] };
  }
  if (pop === 'last') {
    return { ok: true, value: list[list.length - 1] };
  }
  return { ok: true, value: [...list] };
};

const selectStep = function* (
  stream: Iterable<Traverser<unknown>>,
  labels: readonly string[],
  pop: Pop,
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // bys[i] modulates the projection for labels[i]; missing entries fall
  // through to identity. Gremlin also allows a single `by()` to apply to all
  // labels — for the simple case we only honor positional `bys`.
  const byFor = (i: number): By => bys?.[i] ?? { kind: 'identity' };
  for (const t of stream) {
    if (labels.length === 1) {
      const lbl = labels[0]!;
      const r = recallTag(t.tags, lbl, pop);
      if (!r.ok) {
        continue;
      }
      yield extend(t, evalBy(byFor(0), r.value, graph, ctx));
      continue;
    }
    const out: Record<string, unknown> = {};
    let missing = false;
    for (let i = 0; i < labels.length; i++) {
      const lbl = labels[i]!;
      const r = recallTag(t.tags, lbl, pop);
      if (!r.ok) {
        missing = true;
        break;
      }
      out[lbl] = evalBy(byFor(i), r.value, graph, ctx);
    }
    if (missing) {
      continue;
    }
    yield extend(t, out);
  }
};

// --- Stream transformations ---------------------------------------------

const filterStream = function* (
  stream: Iterable<Traverser<unknown>>,
  pred: (v: unknown) => boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (pred(t.value)) {
      yield t;
    }
  }
};

const filterTraverser = function* (
  stream: Iterable<Traverser<unknown>>,
  pred: (t: Traverser<unknown>) => boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (pred(t)) {
      yield t;
    }
  }
};

const mapTraverser = function* (
  stream: Iterable<Traverser<unknown>>,
  fn: (v: unknown, t: Traverser<unknown>) => unknown,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield extend(t, fn(t.value, t));
  }
};

const takeTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  let i = 0;
  for (const t of stream) {
    if (i >= n) {
      return;
    }
    yield t;
    i++;
  }
};

const skipTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  let i = 0;
  for (const t of stream) {
    if (i < n) {
      i++;
      continue;
    }
    yield t;
  }
};

const tailTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  const buf: Traverser<unknown>[] = [];
  for (const t of stream) {
    buf.push(t);
    if (buf.length > n) {
      buf.shift();
    }
  }
  yield* buf;
};

const injectMidStream = function* (
  stream: Iterable<Traverser<unknown>>,
  values: readonly unknown[],
): Iterable<Traverser<unknown>> {
  for (const v of values) {
    yield startTraverser(v);
  }
  yield* stream;
};

const unfoldStream = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const v = t.value;
    if (
      v !== null &&
      typeof v !== 'string' &&
      typeof v === 'object' &&
      Symbol.iterator in (v as object)
    ) {
      for (const item of v as Iterable<unknown>) {
        yield extend(t, item);
      }
    } else {
      yield t;
    }
  }
};

// --- Aggregates: yield a single-element stream --------------------------

const aggregateNumber = function* (
  stream: Iterable<Traverser<unknown>>,
  kind: 'sum' | 'mean',
): Iterable<Traverser<unknown>> {
  let sum = 0;
  let count = 0;
  let sawNonNull = false;
  for (const t of stream) {
    if (t.value == null) {
      continue;
    }
    sawNonNull = true;
    sum += Number(t.value);
    count++;
  }
  if (!sawNonNull) {
    yield startTraverser(null);
    return;
  }
  yield startTraverser(kind === 'sum' ? sum : sum / count);
};

const aggregateComparable = function* (
  stream: Iterable<Traverser<unknown>>,
  kind: 'min' | 'max',
): Iterable<Traverser<unknown>> {
  let best: unknown;
  let sawNonNull = false;
  for (const t of stream) {
    if (t.value == null) {
      continue;
    }
    if (!sawNonNull) {
      best = t.value;
      sawNonNull = true;
    } else if (
      kind === 'min'
        ? (t.value as number | string) < (best as number | string)
        : (t.value as number | string) > (best as number | string)
    ) {
      best = t.value;
    }
  }
  if (!sawNonNull) {
    yield startTraverser(null);
    return;
  }
  yield startTraverser(best);
};

// --- Terminals as 1-element streams -------------------------------------

const countStep = function* (stream: Iterable<Traverser<unknown>>): Iterable<Traverser<unknown>> {
  let n = 0;
  for (const _ of stream) {
    n++;
  }
  yield startTraverser(n);
};

const foldStep = function* (stream: Iterable<Traverser<unknown>>): Iterable<Traverser<unknown>> {
  const list: unknown[] = [];
  for (const t of stream) {
    list.push(t.value);
  }
  yield startTraverser(list);
};

// --- Graph movement (uses vertex references on edges) -------------------

type AdjacencyKind = 'out' | 'in' | 'both' | 'outE' | 'inE' | 'bothE';

const adjacentEdges = (
  kind: AdjacencyKind,
  graph: Graph,
  v: Vertex,
  labels: readonly string[],
): Iterable<Edge> => {
  switch (kind) {
    case 'out':
    case 'outE':
      return outEdgesOf(graph, v, labels);
    case 'in':
    case 'inE':
      return inEdgesOf(graph, v, labels);
    case 'both':
    case 'bothE':
      return bothEdgesOf(graph, v, labels);
  }
};

const otherEndpoint = (
  kind: 'out' | 'in' | 'both',
  edge: Edge,
  v: Vertex,
): Vertex => {
  switch (kind) {
    case 'out':
      return edge.to as Vertex;
    case 'in':
      return edge.from as Vertex;
    case 'both':
      return (edge.from.id === v.id ? edge.to : edge.from) as Vertex;
  }
};

const traverseToVertex = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  step: { kind: 'out' | 'in' | 'both'; labels: readonly string[] },
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value)) {
      continue;
    }
    const v = t.value as Vertex;
    for (const e of adjacentEdges(step.kind, graph, v, step.labels)) {
      yield extend(t, otherEndpoint(step.kind, e, v));
    }
  }
};

const traverseToEdge = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  step: { kind: 'outE' | 'inE' | 'bothE'; labels: readonly string[] },
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value)) {
      continue;
    }
    const v = t.value as Vertex;
    for (const e of adjacentEdges(step.kind, graph, v, step.labels)) {
      yield extend(t, e);
    }
  }
};

const edgeToVertex = function* (
  stream: Iterable<Traverser<unknown>>,
  step: { kind: 'outV' | 'inV' | 'bothV' | 'otherV' },
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isEdge(t.value)) {
      continue;
    }
    const e = t.value;
    if (step.kind === 'outV') {
      yield extend(t, e.from);
    } else if (step.kind === 'inV') {
      yield extend(t, e.to);
    } else if (step.kind === 'bothV') {
      yield extend(t, e.from);
      yield extend(t, e.to);
    } else {
      // otherV — find the previous vertex in the path and emit the other endpoint.
      const prev = [...t.path].reverse().find((p): p is Vertex => isVertex(p));
      const other = prev?.id === e.from.id ? e.to : e.from;
      yield extend(t, other);
    }
  }
};

// --- Projection ---------------------------------------------------------

const projectValues = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[],
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    if (keys.length === 0) {
      for (const v of Object.values(props)) {
        yield extend(t, v);
      }
    } else {
      for (const key of keys) {
        if (key in props) {
          yield extend(t, props[key]);
        }
      }
    }
  }
};

const projectValueMap = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[] | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    if (!keys || keys.length === 0) {
      yield extend(t, { ...props });
    } else {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in props) {
          out[k] = props[k];
        }
      }
      yield extend(t, out);
    }
  }
};

// `path()` yields the array of values seen on the way to the current
// traverser. With `bys`, each path element is projected via `bys[i % bys.length]`
// — Gremlin's documented cycling semantics.
const pathStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!bys || bys.length === 0) {
      yield extend(t, [...t.path]);
      continue;
    }
    const out = t.path.map((v, i) => evalBy(bys[i % bys.length]!, v, graph, ctx));
    yield extend(t, out);
  }
};

// `elementMap(...keys?)` projects each element to `{ id, label, ...properties }`.
// With no keys, all properties are included; with keys, only those.
//
// Edges additionally get `IN` and `OUT` submaps holding `{ id, label }` for
// the in/out vertex — matching the Gremlin reference output for
// `g.E().elementMap()`. Vertices have no IN/OUT.
const projectElementMap = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[] | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    const out: Record<string, unknown> = {
      id: t.value.id,
      label: firstLabel(t.value.labels) ?? null,
    };
    if (isEdge(t.value)) {
      out.IN = {
        id: t.value.to.id,
        label: firstLabel(t.value.to.labels) ?? null,
      };
      out.OUT = {
        id: t.value.from.id,
        label: firstLabel(t.value.from.labels) ?? null,
      };
    }
    const targetKeys = keys && keys.length > 0 ? keys : Object.keys(props);
    for (const k of targetKeys) {
      if (k in props) {
        out[k] = props[k];
      }
    }
    yield extend(t, out);
  }
};

// `propertyMap(...keys?)` yields a single map of `{ key: [values...] }` per element.
// Each value is wrapped in an array to mimic Gremlin's multi-property semantics
// (even though our property model is single-valued).
const projectPropertyMap = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[] | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    const out: Record<string, unknown[]> = {};
    const targetKeys = keys && keys.length > 0 ? keys : Object.keys(props);
    for (const k of targetKeys) {
      if (k in props) {
        out[k] = [props[k]];
      }
    }
    yield extend(t, out);
  }
};

// `properties(...keys)` yields one `{ key, value }` object per matched property,
// flattening across multiple keys per element. With no keys, yields all
// properties of the element.
const projectProperties = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[],
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    const targetKeys = keys.length === 0 ? Object.keys(props) : keys;
    for (const key of targetKeys) {
      if (key in props) {
        yield extend(t, { key, value: props[key] });
      }
    }
  }
};

// `order` materializes the stream, sorts, then re-yields. Boundary step.
// `bys` is non-empty (caller normalizes legacy `key` into a one-element array).
// The first by is the primary sort key; subsequent bys are tie-breakers, in
// order. `desc` flips ALL keys uniformly — comparator-per-by would need
// closures and is deferred.
const orderStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[],
  desc: boolean,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const items = [...stream];
  const projected = items.map((t) => ({
    traverser: t,
    sortKeys: bys.map((by) => evalBy(by, t.value, graph, ctx)),
  }));
  // Per-by direction: prefer the By's `direction` field; fall back to the
  // step-level `desc` (legacy / `order({ desc: true })` form).
  const dirs = bys.map((by) => (by.direction ?? (desc ? 'desc' : 'asc')));
  projected.sort((a, b) => {
    for (let i = 0; i < bys.length; i++) {
      const sa = a.sortKeys[i] as number | string;
      const sb = b.sortKeys[i] as number | string;
      const flip = dirs[i] === 'desc' ? -1 : 1;
      if (sa < sb) {
        return -1 * flip;
      }
      if (sa > sb) {
        return 1 * flip;
      }
    }
    return 0;
  });
  for (const { traverser } of projected) {
    yield traverser;
  }
};

// `fail` throws as soon as the first traverser arrives. Useful as an
// assertion: `traversal(V(), hasLabel('Person'), out('knows'), fail('expected no neighbors'))`.
// eslint-disable-next-line require-yield -- throws before yielding; the generator shape is required by the step protocol
const failStep = function* (
  stream: Iterable<Traverser<unknown>>,
  message: string | undefined,
): Iterable<Traverser<unknown>> {
  for (const _ of stream) {
    throw new Error(message ?? 'fail() reached');
  }
};

// --- Sub-traversal helpers ---------------------------------------------

const hasAny = (stream: Iterable<Traverser<unknown>>): boolean => {
  for (const _ of stream) {
    return true;
  }
  return false;
};

// Sub-plan form: keep traversers whose sub-plan emits anything.
const whereSubPlanStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (hasAny(applyPlanToStream(plan, [t], graph))) {
      yield t;
    }
  }
};

// Two-key form: compare the value tagged at `startKey` to the value tagged
// at `pred.value` (treated as another `as_` label name) via the predicate's
// op. `bys` apply round-robin: bys[0] to start, bys[1] to end (falling back
// to bys[0] if only one is given, then to identity).
const whereCompareStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'where'; startKey: string }>,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const { startKey, pred, bys } = step;
  // Range predicates (between/inside/outside) carry `min`/`max` instead of a
  // single `value`, so they can't reference an end tag. The cross-tag form
  // only makes sense for single-value comparison predicates.
  const valueBearing = pred as Predicate & { value: unknown };
  if (!('value' in valueBearing)) {
    throw new Error(
      `where('${startKey}', ...): only single-value predicates are supported (eq, neq, gt, gte, lt, lte, within, without). Got op '${pred.op}'.`,
    );
  }
  const endKey = valueBearing.value as string;
  const startBy: By = bys?.[0] ?? { kind: 'identity' };
  const endBy: By = bys?.[1] ?? startBy;
  for (const t of stream) {
    const start = recallTag(t.tags, startKey, 'last');
    const end = recallTag(t.tags, endKey, 'last');
    if (!start.ok || !end.ok) {
      continue;
    }
    const startValue = evalBy(startBy, start.value, graph, ctx);
    const endValue = evalBy(endBy, end.value, graph, ctx);
    // Substitute the resolved end-tag value in for the predicate's raw
    // label name. e.g. `gt('b')` becomes `gt(endValue)` at evaluation.
    const resolved = { ...pred, value: endValue } as Predicate;
    if (matches(resolved, startValue)) {
      yield t;
    }
  }
};

const unionStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plans: readonly Plan[],
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    for (const plan of plans) {
      yield* applyPlanToStream(plan, [t], graph);
    }
  }
};

const coalesceStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plans: readonly Plan[],
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    for (const plan of plans) {
      const out = [...applyPlanToStream(plan, [t], graph)];
      if (out.length > 0) {
        yield* out;
        break;
      }
    }
  }
};

const optionalStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const out = [...applyPlanToStream(plan, [t], graph)];
    if (out.length > 0) {
      yield* out;
    } else {
      yield t;
    }
  }
};

const chooseStep = function* (
  stream: Iterable<Traverser<unknown>>,
  test: Plan,
  thenPlan: Plan,
  elsePlan: Plan | undefined,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const branch = hasAny(applyPlanToStream(test, [t], graph)) ? thenPlan : elsePlan;
    if (branch) {
      yield* applyPlanToStream(branch, [t], graph);
    } else {
      // Per TinkerPop spec: if test fails and no elsePlan, traverser passes
      // through unchanged (identity behavior).
      yield t;
    }
  }
};

// --- Repeat -------------------------------------------------------------

const repeatStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'repeat' }>,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  // Cap iterations to `times` if given; else 100 to avoid runaway.
  const maxIterations = step.times ?? 100;
  // `until(plan)` empty means "no until" — let `times` be the only stopper.
  // `emit(plan)` empty means "emit every traverser at every level".
  const hasUntil = step.until !== undefined && !isEmptyPlan(step.until);
  const hasEmit = step.emit !== undefined;
  const emitAll = hasEmit && step.emit !== undefined && isEmptyPlan(step.emit);
  const emitBefore = step.emitBefore === true;

  const matchesEmit = (t: Traverser<unknown>): boolean => {
    if (emitAll) {
      return true;
    }
    return hasAny(applyPlanToStream(step.emit!, [t], graph));
  };

  let frontier: Traverser<unknown>[] = [...stream].map(incLoops);

  for (let i = 0; i < maxIterations && frontier.length > 0; i++) {
    // Pre-form emit (TinkerPop's `emit(...).repeat(body)`): emit before each
    // body application, including the input traverser at level 0.
    if (hasEmit && emitBefore) {
      for (const t of frontier) {
        if (matchesEmit(t)) {
          yield t;
        }
      }
    }

    // Apply the body to advance the frontier.
    const next: Traverser<unknown>[] = [];
    const survivors: Traverser<unknown>[] = [];
    for (const t of frontier) {
      // until(plan) is checked BEFORE applying the body each iteration.
      if (hasUntil && hasAny(applyPlanToStream(step.until!, [t], graph))) {
        // This traverser is "done"; yield it and stop iterating it.
        yield t;
        continue;
      }
      survivors.push(t);
    }

    // Advance survivors through the body.
    for (const t of applyPlanToStream(step.body, survivors, graph)) {
      next.push(incLoops(t));
    }
    frontier = next;

    // Post-form emit (TinkerPop's default `repeat(body).emit(...)`): emit
    // after each body application. The final iteration's body output is
    // emitted here, so no additional post-loop yield is needed.
    if (hasEmit && !emitBefore) {
      for (const t of frontier) {
        if (matchesEmit(t)) {
          yield t;
        }
      }
    }
  }

  // Post-loop yield rules:
  //   - With `until()`: traversers exit via the until-yield above; nothing more.
  //   - With post-form emit: every body output was already emitted; nothing more.
  //   - With pre-form emit: pre-emit caught input + intermediates, but the
  //     final body output never had a "next iteration" to be pre-emitted, so
  //     yield it here.
  //   - With no emit: yield the final frontier (the natural repeat result).
  if (!hasUntil && (!hasEmit || emitBefore)) {
    yield* frontier;
  }
};

const applyPlanToStream = (
  plan: Plan,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {
  let current = stream;
  for (const step of plan.steps) {
    current = applyStep(step, current, graph, ctx);
  }
  return current;
};

const sideEffectStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    // Drain the sub-plan for its effect; discard outputs.
    for (const _ of applyPlanToStream(plan, [t], graph, ctx)) {
      // intentionally consume
    }
    yield t;
  }
};

// `local` runs the sub-plan against each traverser independently, so steps
// like `count()` or `fold()` operate per-traverser instead of over the whole
// stream.
const localStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield* applyPlanToStream(plan, [t], graph, ctx);
  }
};

const aggregateStep = function* (
  stream: Iterable<Traverser<unknown>>,
  key: string,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!ctx.sideEffects.has(key)) {
      ctx.sideEffects.set(key, []);
    }
    ctx.sideEffects.get(key)!.push(t.value);
    yield t;
  }
};

// Force eager materialization of the upstream stream. With v2's lack of
// bulk traversers there's nothing to collapse — this just guarantees the
// upstream side-effects have been driven to completion before downstream
// reads them.
const barrierStep = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  const buffered = [...stream];
  yield* buffered;
};

// `cap(key)` is a barrier: drain the upstream stream first (which is what
// populates side-effect bags via `aggregate`), then yield the bag as a single
// traverser.
const capStep = function* (
  stream: Iterable<Traverser<unknown>>,
  ctx: RunContext,
  key: string,
): Iterable<Traverser<unknown>> {
  for (const _ of stream) {
    // intentionally drain
  }
  yield startTraverser(ctx.sideEffects.get(key) ?? []);
};

// --- tree / branch / map / flatMap / sample ----------------------------

// `tree()` collects each traverser's path into a nested map. Each path
// becomes a chain of map keys: path[0] -> path[1] -> ... -> {}.
const treeStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const root = new Map<unknown, unknown>();
  for (const t of stream) {
    let cursor = root;
    t.path.forEach((node, i) => {
      // by(...) modulators are applied round-robin to successive path
      // positions, matching `path()`'s by-rotation semantics.
      const key = bys && bys.length > 0 ? evalBy(bys[i % bys.length]!, node, graph, ctx) : node;
      let next = cursor.get(key) as Map<unknown, unknown> | undefined;
      if (!next) {
        next = new Map<unknown, unknown>();
        cursor.set(key, next);
      }
      cursor = next;
    });
  }
  yield startTraverser(root);
};

// `branch(test).option(v, plan)...none(plan)` — per traverser, run the test
// plan, take its first result, and route to the matching option's plan
// (deep-equality on `match`), else `default` if present.
const branchStep = function* (
  stream: Iterable<Traverser<unknown>>,
  test: Plan,
  options: readonly { match: unknown; plan: Plan }[],
  defaultPlan: Plan | undefined,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    let testResult: unknown = undefined;
    let sawResult = false;
    for (const r of applyPlanToStream(test, [t], graph)) {
      testResult = r.value;
      sawResult = true;
      break;
    }
    let matched: Plan | undefined;
    if (sawResult) {
      for (const opt of options) {
        if (Object.is(opt.match, testResult) || opt.match === testResult) {
          matched = opt.plan;
          break;
        }
      }
    }
    const target = matched ?? defaultPlan;
    if (target) {
      yield* applyPlanToStream(target, [t], graph);
    }
  }
};

// `flatMap(plan)` — sub-plan's outputs replace the traverser value (0+).
const flatMapStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield* applyPlanToStream(plan, [t], graph);
  }
};

// --- Closure-bearing variants -----------------------------------------------

const flatMapFnStep = function* (
  stream: Iterable<Traverser<unknown>>,
  fn: FlatMapClosure,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    for (const v of fn(t.value, closureView(t, ctx))) {
      yield extend(t, v);
    }
  }
};

const sideEffectFnStep = function* (
  stream: Iterable<Traverser<unknown>>,
  fn: SideEffectClosure,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    fn(t.value, closureView(t, ctx));
    yield t;
  }
};

// `foldFn(seed, reducer)` — barrier step. Reduces the entire stream into a
// single accumulator and yields exactly one traverser carrying it.
const foldFnStep = function* (
  stream: Iterable<Traverser<unknown>>,
  seed: unknown,
  fn: ReducerClosure,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  let acc = seed;
  for (const t of stream) {
    acc = fn(acc, t.value, closureView(t, ctx));
  }
  yield startTraverser(acc);
};

// `map(plan)` — first output of the sub-plan replaces the traverser value.
// Drops traversers where the sub-plan is empty.
const mapStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    for (const r of applyPlanToStream(plan, [t], graph)) {
      yield r;
      break;
    }
  }
};

// `sample(n)` — Fisher-Yates pick-N over the materialized stream.
const sampleStep = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  const buf = [...stream];
  const k = Math.min(n, buf.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (buf.length - i));
    const tmp = buf[i]!;
    buf[i] = buf[j]!;
    buf[j] = tmp;
  }
  for (let i = 0; i < k; i++) {
    yield buf[i]!;
  }
};

// --- Mutation helpers --------------------------------------------------
//
// `addV` / `addE` / `property` / `drop` mutate the graph in place. The
// underlying `Graph.addVertex` / `addEdge` / `removeVertex` / `removeEdge`
// methods emit events, so subscribers see changes as they happen during
// traversal. Callers who need a transactional "all or nothing" semantic
// should clone the graph first (`graph.clone()`).

const addVStep = function* (
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
const runEndpointPlan = (
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
  rooted: Traverser<unknown>,
): Iterable<Traverser<unknown>> => {
  if (plan.steps.length === 0) {
    return [rooted];
  }
  const first = plan.steps[0]!;
  if (first.kind === 'V' || first.kind === 'E' || first.kind === 'inject') {
    let stream: Iterable<Traverser<unknown>> = applySource(first, graph);
    for (let i = 1; i < plan.steps.length; i++) {
      stream = applyStep(plan.steps[i]!, stream, graph, ctx);
    }
    return stream;
  }
  return applyPlanToStream(plan, [rooted], graph, ctx);
};

const resolveAddEEndpoint = (
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

const addEStep = function* (
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  step: { label: string; from?: AddEEndpoint; to?: AddEEndpoint },
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (step.from === undefined && step.to === undefined) {
      throw new Error(
        `addE('${step.label}'): at least one of .from() or .to() must be specified`,
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

const propertyStep = function* (
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

const dropStep = function* (
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

// `index()` — pair each value with its position in the stream.
const indexStep = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  let i = 0;
  for (const t of stream) {
    yield extend(t, [t.value, i]);
    i++;
  }
};

// `math(expr)` — evaluate a tiny infix arithmetic expression. Supports
// numeric literals, parens, `+ - * /`, and the identifier `_` referring to
// the current traverser value (coerced to Number). Other identifiers throw —
// full Gremlin math() with `as`-bound names is not yet supported.
const mathStep = function* (
  stream: Iterable<Traverser<unknown>>,
  expr: string,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield extend(t, evalMath(expr, Number(t.value)));
  }
};

// Recursive-descent parser for tiny arithmetic. Returns the evaluated number.
const evalMath = (expr: string, current: number): number => {
  let pos = 0;
  const peek = (): string => expr[pos] ?? '';
  const skip = () => {
    while (pos < expr.length && /\s/.test(expr[pos]!)) {
      pos++;
    }
  };
  const parsePrimary = (): number => {
    skip();
    const ch = peek();
    if (ch === '(') {
      pos++;
      const v = parseAdd();
      skip();
      if (peek() !== ')') {
        throw new Error(`math: expected ')' in ${expr}`);
      }
      pos++;
      return v;
    }
    if (ch === '_') {
      pos++;
      return current;
    }
    // Number literal (integer or decimal).
    const start = pos;
    if (ch === '-' || ch === '+') {
      pos++;
    }
    while (pos < expr.length && /[0-9.]/.test(expr[pos]!)) {
      pos++;
    }
    if (start === pos) {
      throw new Error(`math: unexpected '${ch}' in ${expr}`);
    }
    const lit = expr.slice(start, pos);
    const n = Number(lit);
    if (Number.isNaN(n)) {
      throw new Error(`math: bad number '${lit}' in ${expr}`);
    }
    return n;
  };
  const parseMul = (): number => {
    let left = parsePrimary();
    skip();
    while (peek() === '*' || peek() === '/') {
      const op = peek();
      pos++;
      const right = parsePrimary();
      left = op === '*' ? left * right : left / right;
      skip();
    }
    return left;
  };
  const parseAdd = (): number => {
    let left = parseMul();
    skip();
    while (peek() === '+' || peek() === '-') {
      const op = peek();
      pos++;
      const right = parseMul();
      left = op === '+' ? left + right : left - right;
      skip();
    }
    return left;
  };
  const result = parseAdd();
  skip();
  if (pos < expr.length) {
    throw new Error(`math: trailing input '${expr.slice(pos)}' in ${expr}`);
  }
  return result;
};

// --- Path utilities -----------------------------------------------------

const hasRevisit = (path: readonly unknown[]): boolean => {
  const seen = new Set<unknown>();
  for (const x of path) {
    if (seen.has(x)) {
      return true;
    }
    seen.add(x);
  }
  return false;
};
