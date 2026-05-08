/* eslint-disable no-shadow -- parameter names intentionally match the gremlin step builder API (e.g. label, value, match) */
import {
  appendStep,
  type By,
  type FilterClosure,
  type FlatMapClosure,
  type ID,
  isStepFn,
  type MapClosure,
  type Plan,
  type Predicate,
  type ReducerClosure,
  type SideEffectClosure,
  type Step,
  STEP_FN,
} from './ast.js';

type StepFn = (plan: Plan) => Plan;

// --- by() modulator builder --------------------------------------------
//
// Some steps (path, order, dedupe, select, group, groupCount, project) accept
// `.by(...)` to control how values are projected. Each `.by(...)` call
// returns a fresh builder whose AST node has one more entry in `bys`. We
// model the builder so it's still callable as a `StepFn` (i.e. it can be
// dropped straight into a `traversal(...)` chain).

// Tokens for `by()` — project to well-known facets of an element. Symbols
// (rather than string literals) so they don't collide with user-supplied
// property names.
export const T = {
  id: Symbol.for('@pl-graph/gremlin/T.id'),
  label: Symbol.for('@pl-graph/gremlin/T.label'),
  key: Symbol.for('@pl-graph/gremlin/T.key'),
  value: Symbol.for('@pl-graph/gremlin/T.value'),
} as const;

type Token = (typeof T)[keyof typeof T];

const TOKEN_TO_KIND: ReadonlyMap<symbol, 'id' | 'label' | 'key' | 'value'> = new Map([
  [T.id, 'id'],
  [T.label, 'label'],
  [T.key, 'key'],
  [T.value, 'value'],
]);

// Comparator symbols for `order().by(...)`. Pass alone (`by(Order.desc)`) for
// natural-order direction, or as the second arg (`by('age', Order.desc)`) to
// pair with a projection.
export const Order = {
  asc: Symbol.for('@pl-graph/gremlin/Order.asc'),
  desc: Symbol.for('@pl-graph/gremlin/Order.desc'),
} as const;

// Scope of a barrier-like step. `global` (default) operates over the whole
// stream; `local` confines the operation to each traverser's value (typically
// when that value is itself a list/map). Symbols are exported now so callers
// can write `count(Scope.local)`-style expressions; wiring them through
// `count`/`limit`/`range`/`sum`/etc. is a separate task — today they're
// declarative-only and any step that receives one will throw.
export const Scope = {
  global: Symbol.for('@pl-graph/gremlin/Scope.global'),
  local: Symbol.for('@pl-graph/gremlin/Scope.local'),
} as const;

// Property cardinality, used with `property(Cardinality.X, key, value)` once
// mutation lands. `single` overwrites; `list` appends; `set` appends only if
// not present. Symbols only for now — `property()` is still stubbed.
export const Cardinality = {
  single: Symbol.for('@pl-graph/gremlin/Cardinality.single'),
  list: Symbol.for('@pl-graph/gremlin/Cardinality.list'),
  set: Symbol.for('@pl-graph/gremlin/Cardinality.set'),
} as const;

type OrderSym = (typeof Order)[keyof typeof Order];

const ORDER_TO_DIR: ReadonlyMap<symbol, 'asc' | 'desc'> = new Map([
  [Order.asc, 'asc'],
  [Order.desc, 'desc'],
]);

// `by()` accepts:
//   - undefined  → identity (use the value as-is)
//   - string     → project by property name
//   - Token (T.x) → project to id / label / key / value
//   - Order.asc/desc → identity projection with comparator direction (order only)
//   - StepFn     → run a single-step sub-traversal (e.g. `count()`)
//   - Plan       → run a multi-step sub-traversal built via `traversal(...)`
type ByModulator = string | Token | OrderSym | StepFn | Plan;

type ByableStep<S extends Step> = StepFn & {
  readonly by: (modulator?: ByModulator, comparator?: OrderSym) => ByableStep<S>;
};

/**
 * What every sub-plan combinator (`where`, `filter`, `map`, `repeat`,
 * `union`, `choose`, ...) accepts. In TinkerPop terms: anywhere a `Traversal`
 * is expected — anonymous (`__.out()`) or rooted (`g.V()`). We accept both:
 *
 *   - `StepFn`  — what `out()`, `pipe(...)`, etc. produce
 *   - `Plan`    — what `traversal(...)` produces
 *
 * Closure-bearing combinators (`map`, `filter`, `flatMap`, `sideEffect`)
 * additionally accept a raw closure; the dispatch in each constructor
 * routes by shape.
 */
export type SubPlan = StepFn | Plan;

const isPlan = (x: unknown): x is Plan =>
  typeof x === 'object' && x !== null && 'steps' in (x as object);

/**
 * True if `x` is a sub-plan in either accepted shape (a `traversal(...)` or a
 * branded `StepFn`). Used by combinators that *also* accept a closure
 * (`map`, `filter`, `flatMap`, `sideEffect`) to route to the sub-plan branch.
 */
const isSubPlan = (x: unknown): x is SubPlan => isPlan(x) || isStepFn(x);

/**
 * Coerce either form to a `Plan`. The runtime accepts both; this is the one
 * conversion point so call sites stay shape-agnostic.
 */
const buildPlan = (sub: SubPlan): Plan =>
  isPlan(sub) ? sub : sub({ steps: [] });

/**
 * Compose multiple step constructors into a single branded StepFn.
 *
 * Use to build sub-plans inline:
 *
 *     filter(pipe(label(), is(eq('PERSON'))))   // sub-plan form, branded
 *     filter((v) => v.id === 1)                 // closure form
 *
 * `traversal(...)` works in the same slots now, so reach for whichever is
 * more readable for the call site.
 */
export const pipe = (...steps: StepFn[]): StepFn => {
  const fn = (plan: Plan): Plan => steps.reduce((p, s) => s(p), plan);
  Object.defineProperty(fn, STEP_FN, { value: true, enumerable: false });
  return fn as StepFn;
};

const toBy = (modulator: ByModulator | undefined, comparator?: OrderSym): By => {
  const direction = comparator !== undefined ? ORDER_TO_DIR.get(comparator) : undefined;
  // `by(Order.asc/desc)` alone — identity projection, comparator-only.
  if (typeof modulator === 'symbol' && ORDER_TO_DIR.has(modulator)) {
    return { kind: 'identity', direction: ORDER_TO_DIR.get(modulator) };
  }
  if (modulator === undefined) {
    return { kind: 'identity', direction };
  }
  if (typeof modulator === 'string') {
    return { kind: 'key', key: modulator, direction };
  }
  if (typeof modulator === 'symbol') {
    const tokenKind = TOKEN_TO_KIND.get(modulator);
    if (tokenKind) {
      return { kind: 'token', token: tokenKind, direction };
    }
    throw new Error(`Unrecognized symbol: ${String(modulator)}`);
  }
  if (isPlan(modulator)) {
    return { kind: 'traversal', plan: modulator, direction };
  }
  return { kind: 'traversal', plan: buildPlan(modulator), direction };
};

// Build a step node with optional `bys` and a `.by(...)` method that appends
// to it. The factory `make` rebuilds the node from a new bys array so each
// call is pure.
const makeByable = <S extends Step & { bys?: readonly By[] }>(
  make: (bys: readonly By[] | undefined) => S,
  bys: readonly By[] | undefined = undefined,
): ByableStep<S> => {
  const fn: StepFn = appendStep(make(bys));
  return Object.assign(fn, {
    by: (modulator?: ByModulator, comparator?: OrderSym) =>
      makeByable(make, [...(bys ?? []), toBy(modulator, comparator)]),
  });
};

// Sources
export const V = (...ids: ID[]): StepFn =>
  appendStep({ kind: 'V', ids: ids.length ? ids : undefined });

export const E = (...ids: ID[]): StepFn =>
  appendStep({ kind: 'E', ids: ids.length ? ids : undefined });

// Movement: vertex → vertex
export const out = (...labels: string[]): StepFn => appendStep({ kind: 'out', labels });
export const in_ = (...labels: string[]): StepFn => appendStep({ kind: 'in', labels });
export const both = (...labels: string[]): StepFn => appendStep({ kind: 'both', labels });

// Movement: vertex → edge
export const outE = (...labels: string[]): StepFn => appendStep({ kind: 'outE', labels });
export const inE = (...labels: string[]): StepFn => appendStep({ kind: 'inE', labels });
export const bothE = (...labels: string[]): StepFn => appendStep({ kind: 'bothE', labels });

// Movement: edge → vertex
export const outV = (): StepFn => appendStep({ kind: 'outV' });
export const inV = (): StepFn => appendStep({ kind: 'inV' });
export const bothV = (): StepFn => appendStep({ kind: 'bothV' });
export const otherV = (): StepFn => appendStep({ kind: 'otherV' });

// Filters
//
// `has` accepts four shapes (TinkerPop parity):
//   has(key, predicate)        — filter by predicate against property value
//   has(key, value)            — shorthand for has(key, eq(value))
//   has(label, key, predicate) — shorthand for hasLabel(label).has(key, pred)
//   has(label, key, value)     — shorthand for hasLabel(label).has(key, eq(value))
//
// Predicates are objects with an `op` discriminant; raw values are anything
// else. The runtime detection is preferred over compile-time overloads
// because TypeScript's `Predicate` union is structural and any plain object
// could in principle be a predicate; we'd rather have the dispatch live in
// one place than scattered through caller-side casts.
const isPredicate = (x: unknown): x is Predicate =>
  typeof x === 'object' && x !== null && 'op' in x;

export function has(key: string, valueOrPred: unknown): StepFn;
export function has(label: string, key: string, valueOrPred: unknown): StepFn;
export function has(a: string, b: unknown, c?: unknown): StepFn {
  if (c === undefined) {
    const pred = isPredicate(b) ? b : { op: 'eq' as const, value: b };
    return appendStep({ kind: 'has', key: a, pred });
  }
  const pred = isPredicate(c) ? c : { op: 'eq' as const, value: c };
  return appendStep({ kind: 'hasLabelAnd', label: a, key: b as string, pred });
}
export const hasLabel = (...labels: string[]): StepFn => appendStep({ kind: 'hasLabel', labels });
export const hasId = (...ids: ID[]): StepFn => appendStep({ kind: 'hasId', ids });
export const hasKey = (...keys: string[]): StepFn => appendStep({ kind: 'hasKey', keys });
export const simplePath = (): StepFn => appendStep({ kind: 'simplePath' });
export const cyclicPath = (): StepFn => appendStep({ kind: 'cyclicPath' });
// `dedupe(...labels)` accepts the legacy label-list form (an `as`/`select`
// modifier; not yet implemented). The projection modulator uses `.by(...)`.
export const dedupe = (...labels: string[]): ByableStep<Extract<Step, { kind: 'dedupe' }>> =>
  makeByable<Extract<Step, { kind: 'dedupe' }>>((bys) => ({
    kind: 'dedupe',
    labels: labels.length ? labels : undefined,
    bys,
  }));

// Cardinality
export const take = (n: number): StepFn => appendStep({ kind: 'take', n });
export const skip = (n: number): StepFn => appendStep({ kind: 'skip', n });
export const limit = (n: number): StepFn => appendStep({ kind: 'take', n });
export const range = (start: number, end: number): StepFn =>
  appendStep({ kind: 'range', start, end });
export const tail = (n = 1): StepFn => appendStep({ kind: 'tail', n });

// Predicates / no-ops / sources
export const is = (pred: Predicate): StepFn => appendStep({ kind: 'is', pred });
export const identity = (): StepFn => appendStep({ kind: 'identity' });
/**
 * Filter every traverser out — the stream ends here.
 *
 * Narrow use: in TinkerPop, `none()` is primarily a signal to a remote server
 * that `iterate()` was called and the client doesn't want results. Direct
 * local use is rare; if you need it, the traversal can usually be rewritten
 * to simply not produce traversers in the first place. Provided here for
 * spec parity.
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#none-step
 */
// `none` is polymorphic:
//   none()          — legacy: drain and emit nothing (debug-noop).
//   none(predicate) — TinkerPop 3.8: keep the traverser iff its iterable
//                     value has no element satisfying the predicate.
//                     Typically chained after `fold()`.
export function none(): StepFn;
export function none(pred: Predicate): StepFn;
export function none(pred?: Predicate): StepFn {
  return appendStep({ kind: 'none', pred });
}
export const inject = (...values: unknown[]): StepFn => appendStep({ kind: 'inject', values });
export const unfold = (): StepFn => appendStep({ kind: 'unfold' });

// Numeric/comparable aggregates (return a one-element stream)
export const sum = (): StepFn => appendStep({ kind: 'sum' });
export const min = (): StepFn => appendStep({ kind: 'min' });
export const max = (): StepFn => appendStep({ kind: 'max' });
export const mean = (): StepFn => appendStep({ kind: 'mean' });

// Sort. With no args, natural order on the values themselves; with a `key`,
// sort by that property (vertex/edge); pass `desc: true` to flip.
export const order = (
  config: { key?: string; desc?: boolean } = {},
): ByableStep<Extract<Step, { kind: 'order' }>> =>
  makeByable<Extract<Step, { kind: 'order' }>>((bys) => ({
    kind: 'order',
    ...config,
    bys,
  }));

// Stop the stream with an error. Useful for asserting traversal invariants.
export const fail = (message?: string): StepFn => appendStep({ kind: 'fail', message });

// --- Sub-traversal combinators -----------------------------------------

// Filter: keep traversers where the sub-plan yields at least one result.
export const where = (plan: SubPlan): StepFn =>
  appendStep({ kind: 'where', plan: buildPlan(plan) });

// Logical combinators over sub-plans, each starting from the current traverser.
export const and = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'and', plans: plans.map(buildPlan) });

export const or = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'or', plans: plans.map(buildPlan) });

// `not` is polymorphic:
//   not(subPlan)   → a step that filters out traversers whose sub-plan emits
//   not(predicate) → a negated predicate, usable inside has/is/etc.
//
// Disambiguation by the same `op`-discriminant check used in `has`. SubPlans
// are either functions (`StepFn`) or plan objects (`{ steps }`); predicates
// are objects with an `op` field.
export function not(plan: SubPlan): StepFn;
export function not(predicate: Predicate): Predicate;
export function not(arg: SubPlan | Predicate): StepFn | Predicate {
  if (isPredicate(arg)) {
    return { op: 'not', predicate: arg };
  }
  return appendStep({ kind: 'not', plan: buildPlan(arg) });
}

// Run each sub-plan from the current traverser; merge outputs in order.
export const union = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'union', plans: plans.map(buildPlan) });

// First non-empty sub-plan wins per traverser.
export const coalesce = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'coalesce', plans: plans.map(buildPlan) });

// Run plan; if empty, yield the original traverser unchanged.
export const optional = (plan: SubPlan): StepFn =>
  appendStep({ kind: 'optional', plan: buildPlan(plan) });

// If/then[/else] over sub-plans.
export const choose = (test: SubPlan, thenPlan: SubPlan, elsePlan?: SubPlan): StepFn =>
  appendStep({
    kind: 'choose',
    test: buildPlan(test),
    thenPlan: buildPlan(thenPlan),
    elsePlan: elsePlan ? buildPlan(elsePlan) : undefined,
  });

// `filter(plan)` keeps traversers whose plan yields ≥1; `filter(fn)` keeps
// traversers where `fn(value, traverser)` returns truthy. Sub-plans accept
// either a branded `StepFn` (e.g. `pipe(...)`) or a `Plan` (e.g.
// `traversal(...)`); a raw closure routes to the closure form.
export const filter = (
  arg: SubPlan | FilterClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'filter', plan: buildPlan(arg) })
    : appendStep({ kind: 'filterFn', fn: arg as FilterClosure });

// Inverse of `has`: filter elements that DON'T have any of the given keys.
export const hasNot = (...keys: string[]): StepFn => appendStep({ kind: 'hasNot', keys });

// Filter property objects (`{key, value}`) by value field.
export const hasValue = (...values: unknown[]): StepFn =>
  appendStep({ kind: 'hasValue', values });

// Yield the value of the current property/edge. For `{key, value}` from
// `properties()`, unwraps to the value; otherwise identity.
export const value = (): StepFn => appendStep({ kind: 'value' });

// Annotate stream with positional indexes: yields `[value, index]` per traverser.
export const index = (): StepFn => appendStep({ kind: 'index' });

// Evaluate an arithmetic expression. `_` references the current value.
export const math = (expr: string): StepFn => appendStep({ kind: 'math', expr });

// Declarative pattern match. STUBBED — executor throws.
export const match = (...patterns: SubPlan[]): StepFn =>
  appendStep({ kind: 'match', patterns: patterns.map(buildPlan) });

// Side-effect subgraph builder. STUBBED — executor throws.
export const subgraph = (key: string): StepFn => appendStep({ kind: 'subgraph', key });

// Three-arg `has(label, key, pred)`: filter by label AND property predicate.
export const hasLabelAnd = (label: string, key: string, pred: Predicate): StepFn =>
  appendStep({ kind: 'hasLabelAnd', label, key, pred });

// Project to id+label+(selected) properties.
export const elementMap = (...keys: string[]): StepFn =>
  appendStep({ kind: 'elementMap', keys: keys.length ? keys : undefined });

// Project all (or selected) properties as a single map of arrays.
export const propertyMap = (...keys: string[]): StepFn =>
  appendStep({ kind: 'propertyMap', keys: keys.length ? keys : undefined });

// Replace each traverser's value with a constant.
export const constant = (value: unknown): StepFn => appendStep({ kind: 'constant', value });

// Inside a `repeat`, the current iteration count (0-indexed).
export const loops = (): StepFn => appendStep({ kind: 'loops' });

// Run a plan or closure for its effect, then yield the original traverser
// unchanged. Sub-plans accept a `StepFn` or `Plan`; closure form is
// `(value, traverser) => void`.
export const sideEffect = (
  arg: SubPlan | SideEffectClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'sideEffect', plan: buildPlan(arg) })
    : appendStep({ kind: 'sideEffectFn', fn: arg as SideEffectClosure });

// Run a sub-plan with a barrier: each traverser sees only itself.
export const local = (plan: SubPlan): StepFn =>
  appendStep({ kind: 'local', plan: buildPlan(plan) });

// Side-effect: stash each traverser into a named bag for later `cap()`.
export const aggregate = (key: string): StepFn => appendStep({ kind: 'aggregate', key });

// `store(key)` is the lazy-eval sibling of `aggregate(key)`. Same observable
// behavior in v2 (no bulk traversers, no barrier), but kept distinct so a
// future optimizer can introduce a barrier on `aggregate` without touching
// `store`.
export const store = (key: string): StepFn => appendStep({ kind: 'store', key });

/**
 * Filter closure: keep traversers whose value is *present* in the named
 * side-effect bag (populated by `aggregate(key)` / `store(key)` upstream).
 *
 * Sugar over the closure-with-sideEffects pattern. Use as
 * `filter(withinBag('seen'))`. Mirrors the spec form `where(within('seen'))`.
 */
export const withinBag = (key: string): FilterClosure =>
  (v, t) => (t.sideEffects.get(key) ?? []).includes(v);

/**
 * Filter closure: keep traversers whose value is *absent* from the named
 * side-effect bag. Inverse of `withinBag`. Common in "exclude already-seen"
 * patterns: `aggregate('seen')` upstream, then `filter(withoutBag('seen'))`
 * downstream. Mirrors the spec form `where(without('seen'))`.
 */
export const withoutBag = (key: string): FilterClosure =>
  (v, t) => !(t.sideEffects.get(key) ?? []).includes(v);

// Force materialization of the upstream stream before continuing. Useful when
// a downstream step needs side-effects (e.g. `aggregate`) populated upstream.
export const barrier = (): StepFn => appendStep({ kind: 'barrier' });

// Read back the named bag from `aggregate` / `store`. Replaces the stream.
export const cap = (key: string): StepFn => appendStep({ kind: 'cap', key });

// Iteration: `repeat(body)` followed by `.times(n)` / `.until(...)` / `.emit(...)` /
// `.emitBefore(...)` modifiers.
//
// `.emit(pred?)` is TinkerPop's `repeat(body).emit(pred?)` post-form: emits
// AFTER each body application. `.emitBefore(pred?)` is the pre-form (TP's
// `emit(pred?).repeat(body)`): emits BEFORE each body application, including
// the input traverser at level 0.
//
// LIMITATION vs TinkerPop: until() placement (BEFORE→do-while vs AFTER→while)
// is not yet distinguished. Our until() always behaves as BEFORE-placement
// (do-while: check before applying body each iteration). Without `until()`
// and without `times()`, repeat is capped at 100 iterations.
type RepeatBuilder = StepFn & {
  times: (n: number) => RepeatBuilder;
  until: (pred: SubPlan) => RepeatBuilder;
  emit: (pred?: SubPlan) => RepeatBuilder;
  emitBefore: (pred?: SubPlan) => RepeatBuilder;
};

export const repeat = (body: SubPlan): RepeatBuilder => {
  const make = (config: {
    body: Plan;
    until?: Plan;
    emit?: Plan;
    emitBefore?: boolean;
    times?: number;
  }): RepeatBuilder => {
    const fn: StepFn = appendStep({ kind: 'repeat', ...config });
    return Object.assign(fn, {
      times: (n: number) => make({ ...config, times: n }),
      until: (pred: SubPlan) => make({ ...config, until: buildPlan(pred) }),
      emit: (pred?: SubPlan) =>
        make({ ...config, emit: pred ? buildPlan(pred) : { steps: [] }, emitBefore: false }),
      emitBefore: (pred?: SubPlan) =>
        make({ ...config, emit: pred ? buildPlan(pred) : { steps: [] }, emitBefore: true }),
    });
  };

  return make({ body: buildPlan(body) });
};

// Projection
export const values = (...keys: string[]): StepFn => appendStep({ kind: 'values', keys });
export const valueMap = (...keys: string[]): StepFn =>
  appendStep({ kind: 'valueMap', keys: keys.length ? keys : undefined });
export const properties = (...keys: string[]): StepFn =>
  appendStep({ kind: 'properties', keys });
export const id = (): StepFn => appendStep({ kind: 'id' });
export const label = (): StepFn => appendStep({ kind: 'label' });
export const path = (): ByableStep<Extract<Step, { kind: 'path' }>> =>
  makeByable<Extract<Step, { kind: 'path' }>>((bys) => ({ kind: 'path', bys }));

// Labeled positions / projection
// `as` is a TS keyword, so we expose it as `as_` (cf. `in_`).
export const as_ = (label: string): StepFn => appendStep({ kind: 'as', label });

// Pop modes for `select`. Use as the optional first argument:
//   `select('a')`               // default — last value
//   `select(Pop.first, 'a')`    // first value
//   `select(Pop.all, 'a')`      // all values as a list
export const Pop = {
  first: Symbol.for('@pl-graph/gremlin/Pop.first'),
  last: Symbol.for('@pl-graph/gremlin/Pop.last'),
  all: Symbol.for('@pl-graph/gremlin/Pop.all'),
} as const;

const POP_TO_STR: ReadonlyMap<symbol, 'first' | 'last' | 'all'> = new Map([
  [Pop.first, 'first'],
  [Pop.last, 'last'],
  [Pop.all, 'all'],
]);

export function select(...labels: string[]): ByableStep<Extract<Step, { kind: 'select' }>>;
export function select(
  pop: (typeof Pop)[keyof typeof Pop],
  ...labels: string[]
): ByableStep<Extract<Step, { kind: 'select' }>>;
export function select(
  ...args: [string | (typeof Pop)[keyof typeof Pop], ...string[]] | string[]
): ByableStep<Extract<Step, { kind: 'select' }>> {
  let pop: 'first' | 'last' | 'all' = 'last';
  let labels: readonly string[];
  if (typeof args[0] === 'symbol') {
    pop = POP_TO_STR.get(args[0]) ?? 'last';
    labels = args.slice(1) as string[];
  } else {
    labels = args as string[];
  }
  return makeByable<Extract<Step, { kind: 'select' }>>((bys) => ({
    kind: 'select',
    labels,
    pop,
    bys,
  }));
}

// Aggregation. `group()` collects the whole stream into a single
// `Map<key, value[]>`. The legacy config-object form (`group({ keyBy, valueBy })`)
// is still accepted; the modulator form is `group().by(keyBy).by(valueBy)`.
export const group = (
  config: { keyBy?: string; valueBy?: string } = {},
): ByableStep<Extract<Step, { kind: 'group' }>> =>
  makeByable<Extract<Step, { kind: 'group' }>>((bys) => ({
    kind: 'group',
    ...config,
    bys,
  }));

// `groupCount()` is `group` with values replaced by counts. Legacy config-object
// form `{ by }` still works; modulator form is `groupCount().by(...)`.
export const groupCount = (
  config: { by?: string } = {},
): ByableStep<Extract<Step, { kind: 'groupCount' }>> =>
  makeByable<Extract<Step, { kind: 'groupCount' }>>((bys) => ({
    kind: 'groupCount',
    ...config,
    bys,
  }));

// `project(keys, bys?)` emits a `{ [key]: value }` per traverser. `bys[i]`
// is the modulator for `keys[i]` (or omitted to project the traverser value
// itself). The optional `bys` arg accepts strings/StepFns/undefined for
// backward compatibility; the chained `.by(...)` form appends one at a time.
export const project = (
  keys: readonly string[],
  bys?: readonly (string | StepFn | undefined)[],
): ByableStep<Extract<Step, { kind: 'project' }>> => {
  const initial = bys?.map((b) => toBy(b));
  return makeByable<Extract<Step, { kind: 'project' }>>(
    (later) => ({ kind: 'project', keys, bys: later }),
    initial,
  );
};

// Terminals
export const count = (): StepFn => appendStep({ kind: 'count' });

// `fold()` collects the stream into an array.
// `fold(seed, reducer)` reduces the stream with a closure.
export function fold(): StepFn;
export function fold(seed: unknown, reducer: ReducerClosure): StepFn;
export function fold(seed?: unknown, reducer?: ReducerClosure): StepFn {
  if (reducer === undefined) {
    return appendStep({ kind: 'fold' });
  }
  return appendStep({ kind: 'foldFn', seed, fn: reducer });
}

export const toList = (): StepFn => appendStep({ kind: 'toList' });

// Terminal: collect paths into a nested Map.
// TODO: support `by()` modulators to project path elements (separate agent).
export const tree = (): ByableStep<Extract<Step, { kind: 'tree' }>> =>
  makeByable<Extract<Step, { kind: 'tree' }>>((bys) => ({ kind: 'tree', bys }));

// Random subset of N traversers (materializes the stream).
export const sample = (n: number): StepFn => appendStep({ kind: 'sample', n });

// `flatMap(plan)` or `flatMap(fn)`. Sub-plan form yields each output of the
// plan. Closure form: `(value, traverser) => Iterable<unknown>`.
export const flatMap = (
  arg: SubPlan | FlatMapClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'flatMap', plan: buildPlan(arg) })
    : appendStep({ kind: 'flatMapFn', fn: arg as FlatMapClosure });

// `map(plan)` or `map(fn)`. Sub-plan: replace value with the plan's first
// output; drop traverser if empty. Closure: `(value, traverser) => unknown`.
export const map = (
  arg: SubPlan | MapClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'map', plan: buildPlan(arg) })
    : appendStep({ kind: 'mapFn', fn: arg as MapClosure });

// --- Branch (switch over a sub-plan's result) --------------------------
// Builder: `branch(test).option(value, plan).option(value, plan).none(plan)`.
type BranchBuilder = StepFn & {
  option: (match: unknown, plan: SubPlan) => BranchBuilder;
  none: (plan: SubPlan) => BranchBuilder;
};

export const branch = (test: SubPlan): BranchBuilder => {
  const make = (config: {
    test: Plan;
    options: readonly { match: unknown; plan: Plan }[];
    default?: Plan;
  }): BranchBuilder => {
    const fn: StepFn = appendStep({ kind: 'branch', ...config });
    return Object.assign(fn, {
      option: (match: unknown, plan: SubPlan) =>
        make({ ...config, options: [...config.options, { match, plan: buildPlan(plan) }] }),
      none: (plan: SubPlan) => make({ ...config, default: buildPlan(plan) }),
    });
  };
  return make({ test: buildPlan(test), options: [] });
};

// --- Mutation (graph write) ---------------------------------------------

/**
 * Insert a new vertex into the graph and emit it as the next traverser.
 *
 * Subsequent `property(key, value)` calls bind values to the new vertex.
 * The label is optional; without one, the vertex is created label-less.
 *
 * Example: `traversal(addV('PERSON'), property('name', 'marko'))`.
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#addvertex-step
 */
export const addV = (label?: string): StepFn => appendStep({ kind: 'addV', label });

type AddEEndpointArg = string | SubPlan;

const toAddEEndpoint = (arg: AddEEndpointArg) =>
  typeof arg === 'string'
    ? ({ kind: 'tag' as const, label: arg })
    : ({ kind: 'plan' as const, plan: buildPlan(arg) });

/**
 * Builder returned by `addE(label)`. Both `.from()` and `.to()` are optional;
 * if only one is set, the current traverser fills the other slot. If neither
 * is set, the executor throws (an edge needs both endpoints).
 *
 * Each accepts a tag string (recalled via prior `as(label)`) or a sub-plan
 * (`traversal(V('2'))`, `inject(someVertex)`, etc.).
 */
type AddEBuilder = StepFn & {
  from: (arg: AddEEndpointArg) => AddEBuilder;
  to: (arg: AddEEndpointArg) => AddEBuilder;
};

/**
 * Insert a new edge and emit it as the next traverser.
 *
 * Common shapes:
 *   - `traversal(V('1'), addE('KNOWS').to(V('2')))`           // input is FROM
 *   - `traversal(V('1'), as_('a'), V('2'), addE('KNOWS').from('a'))` // tag-form
 *   - `traversal(addE('KNOWS').from(V('1')).to(V('2')))`      // both explicit
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#addedge-step
 */
export const addE = (label: string): AddEBuilder => {
  const make = (config: {
    label: string;
    from?: { kind: 'tag'; label: string } | { kind: 'plan'; plan: Plan };
    to?: { kind: 'tag'; label: string } | { kind: 'plan'; plan: Plan };
  }): AddEBuilder => {
    const fn: StepFn = appendStep({ kind: 'addE', ...config });
    return Object.assign(fn, {
      from: (arg: AddEEndpointArg) => make({ ...config, from: toAddEEndpoint(arg) }),
      to: (arg: AddEEndpointArg) => make({ ...config, to: toAddEEndpoint(arg) }),
    });
  };
  return make({ label });
};

type CardinalitySym = (typeof Cardinality)[keyof typeof Cardinality];

const CARDINALITY_TO_KIND: ReadonlyMap<symbol, 'single' | 'list' | 'set'> = new Map([
  [Cardinality.single, 'single'],
  [Cardinality.list, 'list'],
  [Cardinality.set, 'set'],
]);

/**
 * Set a property on the current vertex/edge.
 *
 * Two forms:
 *   - `property(key, value)` — single-cardinality (overwrite). Default.
 *   - `property(Cardinality.X, key, value)` — explicit cardinality. v2's
 *     storage model is single-valued (`Record<string, unknown>`), so `list`
 *     and `set` currently behave identically to `single`. The cardinality is
 *     still threaded through the AST so a future multi-cardinality executor
 *     pass can pick it up without a DSL break.
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#addproperty-step
 */
export function property(key: string, value: unknown): StepFn;
export function property(
  cardinality: CardinalitySym,
  key: string,
  value: unknown,
): StepFn;
export function property(
  ...args:
    | [string, unknown]
    | [CardinalitySym, string, unknown]
): StepFn {
  if (typeof args[0] === 'symbol') {
    const cardinality = CARDINALITY_TO_KIND.get(args[0]);
    if (cardinality === undefined) {
      throw new Error(`property(): unrecognized cardinality symbol ${String(args[0])}`);
    }
    return appendStep({ kind: 'property', key: args[1] as string, value: args[2], cardinality });
  }
  return appendStep({ kind: 'property', key: args[0] as string, value: args[1] });
}

/**
 * Remove the current vertex or edge from the graph. The traverser is dropped
 * (no value is emitted for it). Dropping a vertex cascades — any edges
 * incident to it are also removed.
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#drop-step
 */
export const drop = (): StepFn => appendStep({ kind: 'drop' });
