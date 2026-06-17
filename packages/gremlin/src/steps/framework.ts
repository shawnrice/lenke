//
// Shared scaffolding for step constructors. Each `steps/{group}.ts` imports
// from here. Nothing in this file is a step; everything here is either
// a token table (`T`/`Order`/`Scope`/`Cardinality`/`Pop`), a small type
// (`StepFn`/`SubPlan`/`ByableStep`), or a helper (`makeByable`/`buildPlan`
// /`isPredicate`/etc.).

import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import { appendStep, type By, isStepFn, type Plan, type Predicate, type Step } from '../ast.js';

// ---------- Core types ----------

export type StepFn = (plan: Plan) => Plan;

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

// ---------- Token tables ----------

// Tokens for `by()` — project to well-known facets of an element. Symbols
// (rather than string literals) so they don't collide with user-supplied
// property names.
export const T = {
  id: Symbol.for('@pl-graph/gremlin/T.id'),
  label: Symbol.for('@pl-graph/gremlin/T.label'),
  key: Symbol.for('@pl-graph/gremlin/T.key'),
  value: Symbol.for('@pl-graph/gremlin/T.value'),
} as const;

export type Token = (typeof T)[keyof typeof T];

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

export type OrderSym = (typeof Order)[keyof typeof Order];

const ORDER_TO_DIR: ReadonlyMap<symbol, 'asc' | 'desc'> = new Map([
  [Order.asc, 'asc'],
  [Order.desc, 'desc'],
]);

// Scope of a barrier-like step. `global` (default) operates over the whole
// stream; `local` confines the operation to each traverser's value (typically
// when that value is itself a list/map).
//
// Wired through `take`/`skip`/`limit`/`range`/`tail` today. Other consumers
// (`count`/`sum`/`min`/`max`/`mean`/etc.) accept the symbol at the type
// level but don't yet branch on it — those are tracked in `GAPS.md`.
export const Scope = {
  global: Symbol.for('@pl-graph/gremlin/Scope.global'),
  local: Symbol.for('@pl-graph/gremlin/Scope.local'),
} as const;

// Property cardinality, used with `property(Cardinality.X, key, value)`.
// `single` overwrites; `list` appends; `set` appends only if not present.
// Our storage is single-valued today; the cardinality is still threaded
// through the AST so a future multi-cardinality executor can pick it up.
export const Cardinality = {
  single: Symbol.for('@pl-graph/gremlin/Cardinality.single'),
  list: Symbol.for('@pl-graph/gremlin/Cardinality.list'),
  set: Symbol.for('@pl-graph/gremlin/Cardinality.set'),
} as const;

export type CardinalitySym = (typeof Cardinality)[keyof typeof Cardinality];

export const CARDINALITY_TO_KIND: ReadonlyMap<symbol, 'single' | 'list' | 'set'> = new Map([
  [Cardinality.single, 'single'],
  [Cardinality.list, 'list'],
  [Cardinality.set, 'set'],
]);

// Pop modes for `select`. Use as the optional first argument:
//   `select('a')`               // default — last value
//   `select(Pop.first, 'a')`    // first value
//   `select(Pop.all, 'a')`      // all values as a list
export const Pop = {
  first: Symbol.for('@pl-graph/gremlin/Pop.first'),
  last: Symbol.for('@pl-graph/gremlin/Pop.last'),
  all: Symbol.for('@pl-graph/gremlin/Pop.all'),
} as const;

export const POP_TO_STR: ReadonlyMap<symbol, 'first' | 'last' | 'all'> = new Map([
  [Pop.first, 'first'],
  [Pop.last, 'last'],
  [Pop.all, 'all'],
]);

// ---------- by() modulators ----------

// `by()` accepts:
//   - undefined  → identity (use the value as-is)
//   - string     → project by property name
//   - Token (T.x) → project to id / label / key / value
//   - Order.asc/desc → identity projection with comparator direction (order only)
//   - StepFn     → run a single-step sub-traversal (e.g. `count()`)
//   - Plan       → run a multi-step sub-traversal built via `traversal(...)`
export type ByModulator = string | Token | StepFn | Plan;

export type ByableStep<S extends Step> = StepFn & {
  readonly by: (modulator?: ByModulator, comparator?: OrderSym) => ByableStep<S>;
};

// ---------- Predicate / sub-plan introspection ----------

export const isPlan = (x: unknown): x is Plan =>
  typeof x === 'object' && x !== null && 'steps' in x;

/**
 * True if `x` is a sub-plan in either accepted shape (a `traversal(...)` or a
 * branded `StepFn`). Used by combinators that *also* accept a closure
 * (`map`, `filter`, `flatMap`, `sideEffect`) to route to the sub-plan branch.
 */
export const isSubPlan = (x: unknown): x is SubPlan => isPlan(x) || isStepFn(x);

/**
 * Coerce either form to a `Plan`. The runtime accepts both; this is the one
 * conversion point so call sites stay shape-agnostic.
 */
export const buildPlan = (sub: SubPlan): Plan => (isPlan(sub) ? sub : sub({ steps: [] }));

/**
 * Predicate-vs-value detection. Predicates are objects with an `op`
 * discriminant; raw values are anything else. Used by `has`, `not`, etc.
 * to dispatch on argument shape.
 */
export const isPredicate = (x: unknown): x is Predicate =>
  typeof x === 'object' && x !== null && 'op' in x;

// ---------- by() and ByableStep machinery ----------

export const toBy = (modulator: ByModulator | undefined, comparator?: OrderSym): By => {
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

    throw new PlGraphError(`Unrecognized symbol: ${String(modulator)}`, {
      code: ErrorCode.Unsupported,
    });
  }

  if (isPlan(modulator)) {
    return { kind: 'traversal', plan: modulator, direction };
  }

  return { kind: 'traversal', plan: buildPlan(modulator), direction };
};

// Build a step node with optional `bys` and a `.by(...)` method that appends
// to it. The factory `make` rebuilds the node from a new bys array so each
// call is pure.
export const makeByable = <S extends Step & { bys?: readonly By[] }>(
  make: (bys: readonly By[] | undefined) => S,
  bys?: readonly By[],
): ByableStep<S> => {
  const fn: StepFn = appendStep(make(bys));

  return Object.assign(fn, {
    by: (modulator?: ByModulator, comparator?: OrderSym) =>
      makeByable(make, [...(bys ?? []), toBy(modulator, comparator)]),
  });
};

// ---------- Scope token translation ----------

/**
 * Translate a `Scope.local` / `Scope.global` Symbol to its string token.
 * Used by cardinality steps that accept Scope as a first-arg overload.
 * Symbols don't survive `JSON.stringify`, so the AST stores the token
 * string — this is the conversion point.
 */
export const scopeTokenOf = (s: symbol): 'global' | 'local' => {
  if (s === Scope.local) {
    return 'local';
  }

  if (s === Scope.global) {
    return 'global';
  }

  throw new PlGraphError('Expected Scope.local or Scope.global', { code: ErrorCode.Unsupported });
};

// ---------- Re-exports the step files need from ast ----------

export { appendStep, STEP_FN } from '../ast.js';
export type {
  By,
  FilterClosure,
  FlatMapClosure,
  ID,
  MapClosure,
  Plan,
  Predicate,
  ReducerClosure,
  SideEffectClosure,
  Step,
} from '../ast.js';
