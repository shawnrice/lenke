import { DEFAULT_CONFIG, isEdgeShaped, isVertexShaped } from '@lenke/core';
import type { Edge, Graph, Path, Vertex } from '@lenke/core';
import {
  type AlgorithmName,
  Duration,
  fromTaggedJson,
  isTemporal,
  LocalDate,
  LocalTime,
  LocalDateTime,
  LenkeRecord,
  temporalCmpTotal,
  temporalRelCmp,
  ZonedDateTime,
  ZonedTime,
} from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';
import { filter, map, skip, take, toArray } from '@lenke/fp';

import type {
  Clause,
  CompareOp,
  CountValue,
  Expr,
  LabelExpr,
  LinearQuery,
  NodePattern,
  PathPattern,
  PathMode,
  PathSelector,
  Projection,
  PropertyConstraint,
  Quantifier,
  ReturnItem,
  SortItem,
  Query,
  RelPattern,
  Segment,
  RemoveItem,
  SetItem,
  SetOp,
  Statement,
  TypeTest,
} from './ast.js';
import { isTxControl } from './ast.js';
import { labelsMatch, matchesLabel } from './graph-queries.js';

/**
 * The executor turns a parsed `Query` into result rows by *pattern matching*:
 * a declarative MATCH is evaluated as a sequence of nested loops that grow a
 * partial binding (variable -> graph element) one segment at a time. This is
 * the declarative<->imperative bridge — the language says "find this shape",
 * the executor picks the walk order (here, naive left-to-right).
 *
 * Rather than interpret the AST on every run, we *compile* it once: `compile`
 * lowers a `Query` into a tree of closures (a `Plan`) that captures all the
 * graph/param-independent decisions — operator dispatch, aggregate detection,
 * alias resolution, label-seed selection. The returned `Plan` is reusable:
 * `(graph, params) => Row[]`. Running it again skips the lexer, the parser, and
 * the per-node `switch` dispatch entirely. Params flow *through* the closures
 * (no module-global state), so a plan is reentrant.
 */

/** A bound element: a matched vertex or edge for a pattern variable. */
type Bound = Vertex | Edge;

/**
 * One candidate solution: the variables bound so far. Values are graph elements
 * after MATCH, but `WITH` can project arbitrary scalars into scope, so the value
 * type is `unknown`.
 */
export type Binding = ReadonlyMap<string, unknown>;

/** A projected result row: alias/derived-name -> value. */
export type Row = Record<string, unknown>;

/** Query parameters (`$name`), supplied at run time and threaded through plans. */
export type Params = Record<string, unknown>;

/**
 * The environment a compiled expression evaluates against: the current binding,
 * the query params, the graph (only EXISTS/COUNT subqueries read it), and — for
 * aggregates — the `group` of bindings being folded. Passing this explicitly
 * keeps expression evaluation a pure function of its inputs (no run-state global).
 */
export type EvalEnv = {
  binding: Binding;
  params: Params;
  graph: Graph;
  group?: readonly Binding[];
};

/**
 * A compiled expression. The structural `switch (expr.kind)` happens once, at
 * compile time; what's left is this closure, evaluated against an `EvalEnv`.
 */
export type CompiledExpr = (env: EvalEnv) => unknown;

/**
 * A reusable execution plan: bind a graph and params, get rows. This is the
 * artifact `compile` produces — analyze once, run many.
 *
 * `R` is the row shape you expect back — an opt-in, caller-side assertion (rows
 * are `Record<string, unknown>` at runtime; nothing is validated), so
 * `query<{ name: string }>(...)` returns `{ name: string }[]` and drops the
 * per-field cast. Defaults to `Row`.
 */
export type Plan<R extends Row = Row> = (graph: Graph, params?: Params) => R[];

// --- binding helpers ---------------------------------------------------------

export const withBinding = (
  binding: Binding,
  name: string | undefined,
  value: Bound | Path,
): Binding => {
  if (!name) {
    return binding;
  }

  const next = new Map(binding);
  next.set(name, value);

  return next;
};

/**
 * Is binding `value` to `name` consistent with what's already bound? An
 * unbound variable always binds; a bound one must refer to the same element
 * (this is what makes shared variables across patterns act as a join key).
 */
export const consistent = (binding: Binding, name: string | undefined, value: Bound): boolean => {
  if (!name) {
    return true;
  }

  const existing = binding.get(name);

  return existing === undefined || existing === value;
};

// ISO GQL: accessing a property that is absent — or a property of a NULL element
// (e.g. an unmatched OPTIONAL variable) — yields NULL, not `undefined`. Coalesce
// here so the whole pipeline (output rows, IS NULL, arithmetic) sees ISO's NULL.
export const propOf = (bound: unknown, key: string): unknown =>
  (bound as { properties?: Record<string, unknown> } | undefined)?.properties?.[key] ?? null;

// Element identity, mirroring the Rust `val_eq`: nodes/edges are equal iff same
// kind + same id; a non-element falls back to structural (value) equality.
const sameElement = (a: unknown, b: unknown): boolean => {
  if (isVertex(a) && isVertex(b)) {
    return a.id === b.id;
  }

  if (isEdge(a) && isEdge(b)) {
    return a.id === b.id;
  }

  if (isElement(a) || isElement(b)) {
    return false; // element vs non-element (or node vs edge)
  }

  return structuralEq(a, b);
};

// The graph-element predicates (`IS DIRECTED` / `IS SOURCE|DESTINATION OF` /
// `ALL_DIFFERENT` / `SAME`). Three-valued: `null` on a null operand or a type
// mismatch. Mirrors the Rust `eval_graph_pred`.
const graphPredResult = (predKind: string, vals: readonly unknown[]): boolean | null => {
  switch (predKind) {
    case 'directed':
      return isEdge(vals[0]) ? true : null; // every edge is directed; else unknown
    case 'sourceOf':
    case 'destOf': {
      const [node, edge] = vals;

      if (!isVertex(node) || !isEdge(edge)) {
        return null;
      }

      return (predKind === 'sourceOf' ? edge.from : edge.to).id === node.id;
    }
    case 'allDifferent':
    case 'same': {
      if (vals.some(isNullish)) {
        return null;
      }

      if (predKind === 'same') {
        return vals.every((v) => sameElement(v, vals[0]));
      }

      for (let i = 0; i < vals.length; i++) {
        for (let j = i + 1; j < vals.length; j++) {
          if (sameElement(vals[i], vals[j])) {
            return false;
          }
        }
      }

      return true;
    }
    default:
      return null;
  }
};

// Does a NON-null value match a scalar type category? Numeric split: `integer` =
// a whole-valued number, `float` = any number (one f64 numeric type; boundary
// inference). The open record (`ANY RECORD`) is a `TypeTest`, not a category —
// handled in `valueIsTypedTy`. Mirrors the Rust `category_matches`.
const categoryMatches = (v: unknown, category: string): boolean => {
  switch (category) {
    case 'any':
      return true;
    case 'null':
      return false;
    case 'bool':
      return typeof v === 'boolean';
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'float':
      return typeof v === 'number';
    case 'list':
      return Array.isArray(v);
    case 'date':
      return v instanceof LocalDate;
    case 'local_time':
      return v instanceof LocalTime;
    case 'local_datetime':
      return v instanceof LocalDateTime;
    case 'zoned_time':
      return v instanceof ZonedTime;
    case 'zoned_datetime':
      return v instanceof ZonedDateTime;
    case 'duration':
      return v instanceof Duration;
    default:
      return false;
  }
};

// The ISO value-type predicate `x IS TYPED <value type> [NOT NULL]`. Null conforms
// to any nullable type, so a null value is `!notNull`. A closed `RECORD {…}` is
// CLOSED on extras and matches each present field's value against its type (a field
// null/absent is OK unless the field is NOT NULL). Mirrors the Rust
// `value_is_typed_ty`.
const valueIsTypedTy = (v: unknown, ty: TypeTest, notNull: boolean): boolean => {
  if (isNullish(v)) {
    return !notNull;
  }

  if (ty.kind === 'scalar') {
    return categoryMatches(v, ty.category);
  }

  if (ty.kind === 'anyRecord') {
    return v instanceof LenkeRecord;
  }

  if (!(v instanceof LenkeRecord)) {
    return false;
  }

  // Closed: every present key must be a declared field.
  const declared = new Set(ty.fields.map(([k]) => k));

  for (const k of v.keys()) {
    if (!declared.has(k)) {
      return false;
    }
  }

  return ty.fields.every(([k, ft, fieldNotNull]) =>
    v.has(k) ? valueIsTypedTy(v.get(k), ft, fieldNotNull) : !fieldNotNull,
  );
};

// `PROPERTY_EXISTS(n, key)`: is `key` a *present* property of element `n`? A
// boolean for an element (distinguishing an absent key from a stored null — null
// is first-class), and `null` for a non-element / NULL (three-valued). `key in
// props` would walk the prototype chain, so use `hasOwnProperty`.
const propPresent = (bound: unknown, key: string): boolean | null => {
  const props = (bound as { properties?: Record<string, unknown> } | undefined)?.properties;

  return props == null ? null : Object.hasOwn(props, key);
};

// Scalar functions, three-valued logic & value helpers (leaf module).
import {
  AGGREGATES,
  ARITH,
  arithStep,
  asTruth,
  BOOL3,
  callScalar,
  cmpKey,
  COMPARE,
  concatStep,
  dataException,
  collectAggregates,
  everyAggregateIsCountStar,
  hasAggregate,
  inList,
  isNullish,
  makeRecord,
  nonNumericAgg,
  compareCodePoints,
  not3,
  numArg,
  numOf,
  percentileOf,
  recordGet,
  scalarArityOk,
  structuralEq,
  temporalSum,
  unsupportedTemporalAgg,
} from './executor/scalars.js';
import type { FuncExpr, Truth } from './executor/scalars.js';

// --- expression compilation --------------------------------------------------

/**
 * Bumped once per plan execution, so a compiled closure can cache something that is
 * constant WITHIN a run but not across runs — see the `in` arm's closed haystack.
 *
 * A compiled plan is cached and reused (item 229), so a closure outlives any one run
 * and cannot simply compute such a value once. Keying on this counter is what lets a
 * `$param` haystack be hashed per EXECUTION instead of per row.
 *
 * Re-entrant execution (a nested plan run inside one) only ever bumps it again, which
 * forces an extra rebuild of an execution-constant value — wasteful at worst, never
 * stale.
 */
let execEpoch = 0;

/**
 * Whether the query being compiled may MEMOIZE an uncorrelated subquery for the run.
 *
 * A subquery that references no outer variable has the same answer for every outer row, and the
 * TS engine re-ran it for each one: `COUNT { MATCH (:Person)-[:KNOWS]->(b) }` cost 4,102.8ms at
 * 2,000 vertices and 18,620.2 at 4,000 — quadratic, because the body walks a fixture that grows
 * with the row count — and did not finish in nine minutes at 200,000, where the native engine
 * answers in 21 (audit items 502, 503).
 *
 * The memo is keyed on `execEpoch`, which is bumped once per plan invocation, so a value never
 * survives into another run. Within a run it must also be safe, and that is what this flag is
 * for: a query that WRITES can change the answer between rows (`MATCH … SET … RETURN COUNT { … }`
 * is a different count per row), so memoization is switched off for the whole query whenever it
 * contains a write clause. Compile-time, because the decision is a property of the statement.
 *
 * It defaults to FALSE and is set only inside `compile`, so anything compiled through another
 * entry point — `compileValidator`, which runs against a graph mid-write — never memoizes.
 */
let memoUncorrelated = false;

/**
 * The subquery nodes that READ a name from their enclosing scope, marked while the compiler
 * validates scopes — the one pass that already walks every expression with the names bound
 * around it in hand.
 *
 * Deciding this statically is what keeps the memo free: the first version tested
 * `names.some(binding.has)` at RUN time, and even settled once per run it cost the correlated
 * one-hop degree 72.3/72.6 -> 77.0/77.1 ms at 200,000 rows, because the wrapper itself is a
 * call frame on a path that was not supposed to change. A correlated subquery is now left with
 * the closure it had.
 */
const correlatedSubqueries = new WeakSet<object>();

/**
 * `lv <op> rv` as a three-valued answer — the ONE definition of comparison semantics.
 *
 * Extracted from the `compare` arm so the element-local `cmpProps` loop can apply the SAME
 * rules to a property it read directly. Reimplementing them there would be the mistake
 * `patternCountOf`'s doc warns about ("a shortcut that half-applies a predicate is a wrong
 * answer"): the type handling below IS the semantics, not a detail around it.
 */
const compareTruth = (
  op: CompareOp,
  fn: (a: never, b: never) => boolean,
  lv: unknown,
  rv: unknown,
): Truth => {
  if (isNullish(lv) || isNullish(rv)) {
    return null; // UNKNOWN
  }

  // Equality is structural and holds across any types (mismatched types are
  // simply unequal). Ordering is only defined *within* one orderable
  // primitive type (number, string, or boolean) — comparing a number to a
  // string, or two graph elements, is UNKNOWN per ISO, not a JS coercion.
  if (op === '=' || op === '<>') {
    const eq = structuralEq(lv, rv);

    return op === '=' ? eq : !eq;
  }

  // Temporals: date/datetime (same kind) order chronologically; durations
  // and cross-kind pairs are UNKNOWN. `fn(c, 0)` applies the operator to the
  // -1/0/1 comparison result (e.g. `<` becomes `c < 0`).
  if (isTemporal(lv) && isTemporal(rv)) {
    const c = temporalRelCmp(lv, rv);

    return c === null ? null : (fn as (a: number, b: number) => boolean)(c, 0);
  }

  // Any remaining cross-type ordering is UNKNOWN → null, NOT a fault: a temporal vs
  // a non-temporal (a temporal is an object, so `orderable` is false below), or a
  // number vs a string, are incomparable and evaluate to null. In a schemaless graph
  // a property can hold heterogeneous types across nodes, so an incomparable row must
  // filter out of a WHERE rather than abort the whole query. Matches the engine,
  // cross-type equality's no-match, and the null/NaN-carrying model.
  const t = typeof lv;
  const orderable = t === typeof rv && (t === 'number' || t === 'string' || t === 'boolean');

  if (!orderable) {
    return null; // UNKNOWN
  }

  return (fn as (a: number | string, b: number | string) => boolean)(
    lv as number | string,
    rv as number | string,
  );
};

/** A haystack hashed for membership: the set, plus whether a NULL element was dropped. */
type Haystack = { set: ReadonlySet<unknown>; hasNull: boolean };

/**
 * Can this value go in a `Set` and give the same answer `structuralEq` would?
 *
 * For a primitive, `structuralEq` bottoms out at `a === b`, and `Set.has` is
 * SameValueZero — the two agree on everything including `0`/`-0`, and disagree on
 * exactly one value: **NaN**, which `Set.has` finds and `===` does not. So NaN is
 * excluded and `nan-comparison-policy`'s "predicates keep NaN JS-unordered" holds.
 *
 * The needle needs no such check. A list, record or temporal needle is absent from a
 * set of primitives, and `structuralEq(<primitive>, <non-primitive>)` is false as
 * well — every branch of it returns false before reaching `===`. Deliberately the
 * same whitelist as the Rust engine's `in_set` (item 185): `Bool`, `Str`, non-NaN
 * `Num`, with `Null` carried separately because a membership test cannot otherwise
 * tell FALSE from UNKNOWN.
 */
const hashableElement = (v: unknown): boolean =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && !Number.isNaN(v));

/** Hash a list of values for membership, or `null` if any element is not hashable. */
const hashValues = (items: readonly unknown[]): Haystack | null => {
  const set = new Set<unknown>();
  let hasNull = false;

  for (const v of items) {
    if (isNullish(v)) {
      hasNull = true;
      continue;
    }

    if (!hashableElement(v)) {
      return null;
    }

    set.add(v);
  }

  return { set, hasNull };
};

/**
 * Membership against a hashed haystack, answering exactly what `inList` answers.
 *
 * The empty-list case is why the `size`/`hasNull` test comes FIRST: `inList` loops
 * over the elements and only reaches its `sawUnknown` branch inside the loop, so
 * `null IN []` is **FALSE**, not UNKNOWN. Checking the needle first would quietly
 * turn that into null.
 */
const hashedIn = (v: unknown, { set, hasNull }: Haystack): Truth => {
  if (set.size === 0 && !hasNull) {
    return false;
  }

  if (isNullish(v)) {
    return null;
  }

  if (set.has(v)) {
    return true;
  }

  // A miss is only definitely FALSE when nothing was dropped: a NULL element makes
  // it UNKNOWN instead, which is the distinction a bare set cannot carry.
  return hasNull ? null : false;
};

/**
 * The literal values of a CLOSED list expression, or `null` if it is not one.
 *
 * `case 'list'` compiles to `items.map((f) => f(env))`, which rebuilds the array and
 * calls every element closure **per row**. For a constant haystack that is pure
 * waste, and it is why the inline spelling measured ~3x the `$param` one at every
 * length (item 268) before this existed.
 */
const closedListValues = (e: Expr): readonly unknown[] | null => {
  if (e.kind !== 'list') {
    return null;
  }

  const values: unknown[] = [];

  for (const it of e.items) {
    if (it.kind !== 'lit') {
      return null;
    }

    values.push(it.value);
  }

  return values;
};

/**
 * A uniform same-key `=`-OR-chain rewritten as the membership test it is, or `null`.
 *
 * `k = a OR k = b OR …` and `k IN [a, b, …]` are the same question, and `CLAUDE.md`
 * names that exact pair among the 100-300x spelling gaps this engine exists to not
 * have. Item 263 made the chain SEED an index; unindexed it still re-tested every term
 * per row where `IN` is one hashed probe — 200,000 rows, 33 terms: 91.52ms against
 * 8.83ms (item 270).
 *
 * THE EQUIVALENCE IS EXACT IN THREE-VALUED LOGIC, which is the part that needs care. A
 * null needle makes every `=` UNKNOWN and `OR` of UNKNOWNs is UNKNOWN, which is `IN`'s
 * null-needle answer; a NULL element makes a miss UNKNOWN (`UNKNOWN OR FALSE`) and
 * leaves a hit TRUE (`UNKNOWN OR TRUE`), which is exactly what the hashed haystack's
 * `hasNull` encodes.
 *
 * THE `kind` CHECK IS NOT REDUNDANT, though three other things also stop an `xor` here:
 * `uniformEqChain` flattens only `or` nodes, so an `xor` arrives as one branch and is
 * rejected by the `>= 2` floor and again by its `kind !== 'compare'` test. A mutant
 * removing this check alone therefore SURVIVES. But a mutant that first makes `flatten`
 * descend `xor` — a plausible edit if someone ever wants xor chains — survives WITH this
 * check and is caught WITHOUT it, so it defends a reachable drift. (Item 270: mutants
 * N6/N7. A single mutant could not have shown that; the layer that makes a guard
 * redundant has to be removed in the same mutant.)
 *
 * Applied in `compileExpr` rather than to the AST so every analysis pass still sees the
 * original `or` — `collectHints` in particular, whose own `uniformEqChain` seeding must
 * keep firing.
 */
const membershipFromEqChain = (e: Expr): Expr | null => {
  if (e.kind !== 'or') {
    return null;
  }

  const chain = uniformEqChain(e);

  return chain === undefined
    ? null
    : {
        kind: 'in',
        expr: { kind: 'prop', variable: chain.variable, key: chain.key },
        list: { kind: 'list', items: chain.values },
        negated: false,
      };
};

/**
 * Lower an expression to a closure. Every `case` resolves its sub-expressions
 * to closures *now* and captures them, so the run-time path is plain function
 * application — no AST re-traversal, no `kind`/`op` dispatch.
 */
// Compile-time side channel: while `compile` walks the tree, every `$name` it
// meets is recorded here so the plan can eager-validate all referenced params
// are bound before it runs (mirrors the Rust engine's `positional`). Set only
// for the duration of one synchronous `compile` call (JS is single-threaded, and
// sub-patterns compile in-line — no re-entrant `compile`), then cleared.
let paramCollector: Set<string> | null = null;

// Compile-time side channel: the names of unknown/unimplemented functions a
// *query* references, gathered while `compile` walks the tree so it can throw
// `UnknownFunction` eagerly (before running, and independent of row count /
// branch reachability). Set only for the duration of one query `compile`; left
// null while a validator predicate compiles, so a validator's unknown fn keeps
// its per-row fault (parity with the Rust `eval_predicate` path). Mirrors the
// Rust plan's `unknown_fns`, checked in `run_cquery_body`.
let unknownFnCollector: Set<string> | null = null;

// Compile-time side channel: the names of `$param`s used as a `LIMIT` / `OFFSET`
// bound. Their bound value must be a non-negative integer, so it is validated
// up-front in the plan closure (mirrors the Rust engine's `check_count_params`),
// making a bad bound fault before any row is produced — identically over zero
// rows or many. The name is also added to `paramCollector` so a missing bound
// param surfaces the usual `MissingParameter` error.
let countParamCollector: Set<string> | null = null;

// Resolve a `LIMIT` / `OFFSET` bound to a concrete count at execution: a literal
// passes through; a `$param` is read from the bound params (its value is already
// validated to be a non-negative integer up-front, in the plan closure).
export const resolveCount = (v: CountValue | undefined, params: Params): number | undefined => {
  if (v === undefined || typeof v === 'number') {
    return v;
  }

  return Number(params[v.param]);
};

export const compileExpr = (expr: Expr): CompiledExpr => {
  switch (expr.kind) {
    case 'lit': {
      const { value } = expr;

      return () => value;
    }
    case 'var': {
      const { name } = expr;

      return (env) => env.binding.get(name);
    }
    case 'param': {
      const { name } = expr;
      paramCollector?.add(name);

      // Own-property only: a query text referencing `$__proto__` / `$constructor`
      // must read undefined (an unbound param), never `Object.prototype`. The
      // Rust engine is immune (params live in a HashMap); this matches it. A
      // param the caller genuinely passed under that key is an own property and
      // still resolves.
      return (env) => {
        if (Object.hasOwn(env.params, name)) {
          return env.params[name];
        }

        // An unsupplied `$__now` (from a bare `current_*`) reads as null to match
        // the Rust engine; any other unbound param can't reach here (it fails the
        // eager validation above).
        return name === '__now' ? null : undefined;
      };
    }
    case 'prop': {
      const { variable, key } = expr;

      return (env) => propOf(env.binding.get(variable), key);
    }
    case 'property_exists': {
      const { variable, key } = expr;

      return (env) => propPresent(env.binding.get(variable), key);
    }
    case 'list': {
      const items = expr.items.map(compileExpr);

      return (env) => items.map((f) => f(env));
    }
    case 'record': {
      // ISO record constructor → a canonical (sorted, dup-last-wins) map value.
      const fields = expr.fields.map((f) => ({ key: f.key, fn: compileExpr(f.value) }));

      return (env) => makeRecord(fields.map((f) => [f.key, f.fn(env)] as const));
    }
    case 'index': {
      // ISO GQL list subscript `base[index]`: 0-based, out of range → null, and
      // null-safe. A STRING index on a record/map is field access; a non-string
      // index / non-integer list index → null. `numOf` mirrors native `num_of`.
      const baseF = compileExpr(expr.base);
      const idxF = compileExpr(expr.index);

      return (env) => {
        const base = baseF(env);
        const idx = idxF(env);

        if (base instanceof LenkeRecord) {
          return typeof idx === 'string' ? recordGet(base, idx) : null;
        }

        // A non-number index → null (the contract is "non-integer list index →
        // null"), NOT the throwing numOf — which diverged from Rust, and from this
        // path's own intent, on e.g. `list['1']` / `list[true]`.
        const i = typeof idx === 'number' ? idx : null;

        if (
          !Array.isArray(base) ||
          i === null ||
          !Number.isInteger(i) ||
          i < 0 ||
          i >= base.length
        ) {
          return null;
        }

        return base[i] ?? null;
      };
    }
    case 'field': {
      // `.field` chained off any expression. A record/map base reads the field by
      // name; a node/edge base reads its stored property via `propOf`; anything
      // else → null, exactly like the bare `prop` path.
      const baseF = compileExpr(expr.base);
      const { key } = expr;

      return (env) => {
        const base = baseF(env);

        return base instanceof LenkeRecord ? recordGet(base, key) : propOf(base, key);
      };
    }
    case 'func':
      return compileFunc(expr);
    case 'neg': {
      const fn = compileExpr(expr.expr);

      return (env) => {
        const v = numOf(fn(env));

        return v === null ? null : -v;
      };
    }
    case 'arith': {
      // n-ary left-associative fold: `head` then each `[op, operand]`. Every
      // operand is evaluated (no short-circuit — a fault propagates), matching
      // the old left-nested binary tree, but with no per-chain recursion depth.
      const head = compileExpr(expr.head);
      const steps = expr.tail.map(([op, e]) => ({ op, fn: ARITH[op], ce: compileExpr(e) }));

      return (env) => {
        let acc = head(env);

        for (const { op, fn, ce } of steps) {
          acc = arithStep(op, fn, acc, ce(env));
        }

        return acc;
      };
    }
    case 'concat': {
      const parts = expr.items.map(compileExpr);

      return (env) => {
        const vals = parts.map((p) => p(env));
        // `||` no longer JS-coerces. The NON-NULL operands must be homogeneous and
        // concatenable — all strings OR all lists — checked first and order-independently,
        // matching the native engine: a number/bool/temporal operand, or a string/list
        // mix, is a data exception even when a NULL is also present. A NULL operand then
        // makes the whole result NULL (propagation), handled by `concatStep`.
        const nonNull = vals.filter((v) => !isNullish(v));

        if (
          nonNull.length > 0 &&
          !nonNull.every((v) => typeof v === 'string') &&
          !nonNull.every((v) => Array.isArray(v))
        ) {
          return dataException(
            '|| requires all operands to be strings or all lists (values are not coerced)',
          );
        }

        let [acc] = vals;

        for (let i = 1; i < vals.length; i++) {
          acc = concatStep(acc, vals[i]);
        }

        return acc;
      };
    }
    case 'not': {
      const fn = compileExpr(expr.expr);

      return (env) => not3(asTruth(fn(env)));
    }
    case 'and': {
      // `AND` SHORT-CIRCUITS ON FALSE: a conjunct that settles the chain false makes every
      // later conjunct an INESSENTIAL part of the expression, and an inessential part is not
      // evaluated — so a throwing one does not throw. ISO/IEC 39075 leaves both halves of
      // this to the implementation, in its free `-implementation-dependent.xml`: `US008`
      // (the actual order of expression evaluation) and `UA004` (whether an exception from
      // the evaluation of an inessential part is actually raised). Both outcomes conform, so
      // the choice is ours to make on cost, and a FALSE is cheaper than an exception (user,
      // 2026-10-08).
      //
      // The matching side in Rust is `fold_operand`'s `must_narrow`, which evaluates the
      // second operand only over the rows the first left undecided and, when that operand can
      // raise, does so unconditionally rather than as a sampled perf choice.
      //
      // WRITTEN ORDER, deliberately — no cost-based reordering. A version of this partitioned
      // the conjuncts so the ones that cannot fault ran first, which agreed with Rust on more
      // WHERE shapes and disagreed on others it had no business touching: Rust reorders only
      // where its optimizer can seed a conjunct out of the chain, and in a projection it does
      // not reorder at all, so `RETURN (0 AND (1 IS NULL))` raised there and answered here.
      // Written order is the one rule both engines can hold everywhere. What that leaves is
      // the residual the divergence registry still declares: a filter whose settling conjunct
      // is UNKNOWN (Rust's filter drops the row, Kleene `AND` does not settle on it) or whose
      // cheap conjunct Rust's seek hoisted past a raising sibling.
      const fn = BOOL3.and;
      const parts = expr.items.map(compileExpr);

      return (env) => {
        let acc: Truth = true;

        for (const part of parts) {
          acc = fn(acc, asTruth(part(env)));

          // FALSE settles `AND` whatever the rest would say; UNKNOWN settles nothing (a
          // later FALSE still makes it false), which is why the test is `=== false` and not
          // `!== true`.
          if (acc === false) {
            return false;
          }
        }

        return acc;
      };
    }
    case 'or':
    case 'xor': {
      // A UNIFORM SAME-KEY `=`-CHAIN IS A MEMBERSHIP TEST, so it is lowered to one.
      // `k = a OR k = b OR …` and `k IN [a, b, …]` are the same question, and
      // `CLAUDE.md` names that exact pair among the 100-300x spelling gaps this engine
      // exists to not have. Item 263 made the chain SEED an index; unindexed, it still
      // re-tested every term per row where `IN` is one hashed probe — measured at
      // 200,000 rows: 33 terms 91.52ms against 8.83ms, 100 terms 263.82 against 9.51.
      //
      // The equivalence is exact in THREE-VALUED logic, which is the only part that
      // needs care: a null needle makes every `=` UNKNOWN and `OR` of UNKNOWNs is
      // UNKNOWN, matching `IN`'s null-needle answer; a NULL element makes a non-match
      // UNKNOWN (`UNKNOWN OR FALSE`) and leaves a match TRUE (`UNKNOWN OR TRUE`), which
      // is exactly what `hasNull` encodes.
      //
      // AND IT DOES NOT CONTRADICT THE PARAGRAPH BELOW. `OR` is not short-circuited
      // because an operand can RAISE and both engines must raise alike. Every operand
      // here is `prop <=> const` — `uniformEqChain` admits nothing else — and neither a
      // property read nor a structural `=` can raise (a cross-type `=` is a non-match,
      // not an error). So collapsing N non-raising operands into one probe is
      // unobservable, by item 259's rule that only non-raising operands may be moved.
      //
      // Done HERE rather than in the AST so every analysis pass still sees the original
      // `or` — `collectHints` in particular, whose `uniformEqChain` seeding must keep
      // firing.
      const membership = membershipFromEqChain(expr);

      if (membership !== null) {
        return compileExpr(membership);
      }

      // NOT short-circuited, and deliberately. `OR` has no counterpart to the conjunct
      // split in the Rust optimizer — there is nothing to seed an OR from — so both engines
      // evaluate every operand and both raise on `n.n > 0 OR n.s`. Skipping the second
      // operand here would AGREE with no one and would need the Rust `fold_operand`
      // transparency gate lifted to match. `XOR` cannot short-circuit at all: neither
      // operand is ever inessential.
      const fn = BOOL3[expr.kind];
      const parts = expr.items.map(compileExpr);

      return (env) => {
        let acc = asTruth(parts[0](env));

        for (let i = 1; i < parts.length; i++) {
          acc = fn(acc, asTruth(parts[i](env)));
        }

        return acc;
      };
    }
    case 'isNull': {
      const fn = compileExpr(expr.expr);
      const { negated } = expr;

      return (env) => {
        const isnull = isNullish(fn(env));

        return negated ? !isnull : isnull;
      };
    }
    case 'isTruth': {
      // `x IS [NOT] TRUE|FALSE|UNKNOWN` is an EXACT three-valued test, not a truthiness
      // coercion: a non-boolean x is simply not equal to TRUE/FALSE (the test is false),
      // and UNKNOWN tests for null — mirroring the native engine's `coalesce(x = <truth>,
      // false)`. Unlike a boolean CONTEXT (WHERE / AND / CASE …), it does NOT fault on a
      // non-boolean; it just reports "no". `null IS UNKNOWN` is true.
      const fn = compileExpr(expr.expr);
      const { truth, negated } = expr;

      return (env) => {
        const v = fn(env);
        const matches = truth === null ? isNullish(v) : v === truth;

        return negated ? !matches : matches;
      };
    }
    case 'isLabeled': {
      // `x IS [NOT] LABELED <label expr>` — does x's label set satisfy it?
      const fn = compileExpr(expr.expr);
      const { label, negated } = expr;

      return (env) => {
        const el = fn(env);
        const has = isElement(el) ? labelsMatch(el.labels, label) : false;

        return negated ? !has : has;
      };
    }
    case 'isTyped': {
      // `x IS [NOT] TYPED <value type> [NOT NULL]` — the ISO value-type predicate.
      const fn = compileExpr(expr.expr);
      const { ty, notNull, negated } = expr;

      return (env) => {
        const m = valueIsTypedTy(fn(env), ty, notNull);

        return negated ? !m : m;
      };
    }
    case 'graphPred': {
      // IS DIRECTED / IS SOURCE|DESTINATION OF / ALL_DIFFERENT / SAME.
      const argFns = expr.args.map(compileExpr);
      const { predKind, negated } = expr;

      return (env) => {
        const r = graphPredResult(
          predKind,
          argFns.map((f) => f(env)),
        );

        if (r === null) {
          return null;
        }

        return negated ? !r : r;
      };
    }
    case 'in': {
      const e = compileExpr(expr.expr);
      const { negated } = expr;

      // A CLOSED all-literal haystack is hashed ONCE, here at compile time. That
      // removes BOTH costs the linear form paid per row: `case 'list'` rebuilding
      // the array and calling an element closure per item, and `inList` then
      // scanning it. Measured at 200,000 rows on an unindexed key, `IN` over 500
      // inline literals went 312.98ms -> 7.07ms (item 268).
      const closed = closedListValues(expr.list);
      const constHay = closed === null ? null : hashValues(closed);

      if (constHay !== null) {
        return (env) => {
          const r = hashedIn(e(env), constHay);

          return negated ? not3(r) : r;
        };
      }

      const list = compileExpr(expr.list);

      // A CLOSED haystack that is not all-literal — a `$ids` param, or an inline list
      // whose items are params — has a value that is constant WITHIN an execution but
      // not across executions. `closedList` is the same predicate the seeding path
      // uses for exactly this set of shapes (item 184). Hash it ONCE per execution,
      // keyed on `execEpoch`.
      //
      // Evaluating the haystack against the first row's env and reusing it is sound
      // precisely BECAUSE it is closed: a `lit`/`param` tree never reads the binding,
      // so every row would compute the same value.
      //
      // KEYING ON THE ARRAY'S IDENTITY INSTEAD WAS A 2.9x REGRESSION, and it is worth
      // saying why, because identity looks like the obvious key. `case 'list'` rebuilds
      // its array per ROW, so for an inline list of params the identity check missed on
      // every row and re-hashed the whole haystack each time — strictly worse than the
      // linear scan it replaced. Measured at 100 terms, 200,000 rows:
      // `IN [$a, …]` went 203.73ms (pre-268) -> 587.42ms (identity memo) -> hashed here.
      // An execution-scoped key cannot have that failure mode, because it never hashes
      // anything that varies per row.
      if (closedList(expr.list)) {
        let epoch = -1;
        let hay: unknown;
        let hashed: Haystack | null = null;

        return (env) => {
          if (epoch !== execEpoch) {
            epoch = execEpoch;
            hay = list(env);
            hashed = Array.isArray(hay) ? hashValues(hay) : null;
          }

          // `hashed` is null for a non-array binding (`$ids` bound to a number → the
          // whole predicate is UNKNOWN) or a non-hashable element (a NaN param), and
          // both keep `inList` over the cached value.
          const result = hashed === null ? inList(e(env), hay) : hashedIn(e(env), hashed);

          return negated ? not3(result) : result;
        };
      }

      // A haystack that genuinely varies per row — a property, a function result. It is
      // re-evaluated and scanned linearly, which is the right answer for it: hashing a
      // fresh list per row could only add work.
      return (env) => {
        const result = inList(e(env), list(env));

        return negated ? not3(result) : result;
      };
    }
    case 'compare': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      const { op } = expr;
      const fn = COMPARE[op];

      return (env) => compareTruth(op, fn, l(env), r(env));
    }
    case 'case':
      return compileCase(expr);
    // Each of the three correlated-subquery forms is memoized when it is NOT correlated: one
    // evaluation per plan invocation instead of one per row (item 503).
    case 'exists':
      return memoizeIfUncorrelated(expr, compileExists(expr));
    case 'countSubquery':
      return memoizeIfUncorrelated(expr, compileCountSubquery(expr));
    case 'valueSubquery':
      return memoizeIfUncorrelated(expr, compileValueSubquery(expr));
    case 'letIn':
      return compileLetIn(expr);
  }
};

/**
 * Compile a braced subquery body (`{ pattern, … [WHERE pred] }`) into a MATCH
 * clause. The sub-pattern is compiled once; at run time it is matched seeded with
 * the outer binding, so EXISTS/COUNT are correlated.
 */
const compileSubMatch = (sub: { patterns: readonly PathPattern[]; where?: Expr }): CMatch => ({
  kind: 'match',
  optional: false,
  patterns: sub.patterns.map(compilePath),
  where: sub.where ? compileExpr(sub.where) : undefined,
  nullVars: [],
  ...matchVarSets(sub.patterns, sub.where),
});

/**
 * Reachability fast path for `EXISTS { (a)-[:T]->+/*(b …) }`: a single unbounded
 * var-length segment from an already-bound `a` is *reachability* — BFS the reached
 * set and stop at the first vertex satisfying the endpoint, instead of enumerating
 * trails (exponential; testing an *unreachable* target hits the trail budget and
 * faults). Mirrors the native `any_match_reachable`. Returns `undefined` when the
 * shape doesn't apply.
 */
const existsReachable = (
  graph: Graph,
  sub: CMatch,
  binding: Binding,
  params: Params,
): boolean | undefined => {
  if (sub.patterns.length !== 1 || sub.patterns[0].segments.length !== 1) {
    return undefined;
  }

  const [path] = sub.patterns;
  const [{ rel, node }] = path.segments;
  const { quantifier: q } = rel;

  if (!q) {
    return undefined;
  }

  const startVar = path.start.variable;
  const types = relTypeNames(rel.label);

  if (
    q.max !== null ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    hasPredicate(rel.pred) ||
    types === null ||
    startVar === undefined ||
    !binding.has(startVar) ||
    hasPredicate(path.start.pred)
  ) {
    return undefined;
  }

  const startV = binding.get(startVar) as Vertex;
  const out = rel.direction === 'out';
  const nbrs = (v: Vertex): Vertex[] => outNeighbors(graph, v, out, types ?? undefined);
  // Is `v` a valid endpoint (label + inline pred + the EXISTS WHERE)?
  const hit = (v: Vertex): boolean => {
    const bound = matchNode(binding, node, v, params, graph);

    return (
      bound !== null &&
      (sub.where === undefined || asTruth(sub.where({ binding: bound, params, graph })) === true)
    );
  };

  // `->*` also admits the zero-length path — the start itself.
  if (q.min === 0 && hit(startV)) {
    return true;
  }

  const seen = new Set<string>();
  const stack: Vertex[] = [];
  const visit = (w: Vertex): boolean => {
    if (seen.has(w.id)) {
      return false;
    }

    seen.add(w.id);
    stack.push(w);

    return true;
  };

  for (const w of nbrs(startV)) {
    if (visit(w) && hit(w)) {
      return true;
    }
  }

  while (stack.length > 0) {
    for (const w of nbrs(stack.pop()!)) {
      if (visit(w) && hit(w)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * The SHAPE half of `existsOneHop`, decided ONCE at compile time: everything that depends on the
 * sub-pattern's text rather than on the row's binding. `undefined` when the shape is not a
 * single directed hop off a correlated start.
 *
 * WHY THIS IS SPLIT. `existsOneHop` ran its whole analysis per OUTER ROW — ten conditions plus a
 * `relTypeNames` that ALLOCATES an array — and a correlated `EXISTS` runs once a row. Measured
 * at 200,000 nodes / 1,000,000 edges (item 492): `MATCH (n:Person) WHERE EXISTS { MATCH
 * (n)-[:KNOWS]->(x) } RETURN count(*)` cost **87.8 ms in TS against 1.2 in native**, i.e. 439 ns
 * a node for a question that is "does this vertex have an out-edge of this type". The degree
 * probe was already there (item 211); what was not was deciding ONCE that it applies.
 *
 * `startVar` is returned rather than resolved: whether it is BOUND is a per-row question, and
 * the two conditions that must stay per-row are exactly the two item 211 lists — the start must
 * be bound, and (for the count form) the far variable must not be.
 */
const oneHopExistsShape = (
  sub: CMatch,
): { startVar: string; out: boolean; types: string[] | undefined; free: boolean } | undefined => {
  if (sub.patterns.length !== 1 || sub.patterns[0].segments.length !== 1) {
    return undefined;
  }

  const [path] = sub.patterns;
  const [{ rel, node }] = path.segments;
  const startVar = path.start.variable;
  const types = relTypeNames(rel.label);

  if (
    rel.quantifier !== undefined ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    hasPredicate(rel.pred) ||
    types === null ||
    startVar === undefined ||
    path.pathVar !== undefined ||
    path.selector !== 'walk' ||
    hasPredicate(path.start.pred)
  ) {
    return undefined;
  }

  return {
    startVar,
    out: rel.direction === 'out',
    types: types ?? undefined,
    // An UNCONSTRAINED endpoint — no label, no props, no predicate, and no subquery `WHERE` —
    // makes every neighbour an answer, so the question collapses to "is there an edge of these
    // types". `EXISTS { (u)-[:E]->() }` is that shape, and it is the one this came for.
    free: node.label === undefined && !hasPredicate(node.pred) && sub.where === undefined,
  };
};

/** ISO EXISTS: TRUE iff the correlated sub-pattern has at least one match. */
const compileExists = (expr: Extract<Expr, { kind: 'exists' }>): CompiledExpr => {
  const sub = compileSubMatch(expr);
  // Decided once. The per-row closure below then does only what depends on the ROW.
  const shape = oneHopExistsShape(sub);
  const [firstPattern] = sub.patterns;
  const far: CNode | undefined = shape === undefined ? undefined : firstPattern.segments[0].node;

  return (env) => {
    const reach = existsReachable(env.graph, sub, env.binding, env.params);

    if (reach !== undefined) {
      return reach;
    }

    if (shape !== undefined) {
      const startV = env.binding.get(shape.startVar) as Vertex | undefined;

      if (startV !== undefined) {
        return oneHopExists(env, shape, startV, sub, far as CNode);
      }
    }

    const matches = matchClauseBindings(env.graph, sub, env.binding, env.params)[Symbol.iterator]();

    return !matches.next().done;
  };
};

/** The per-ROW half: one adjacency probe, and the endpoint test only when the shape needs it. */
const oneHopExists = (
  env: EvalEnv,
  shape: NonNullable<ReturnType<typeof oneHopExistsShape>>,
  startV: Vertex,
  sub: CMatch,
  far: CNode,
): boolean => {
  const { graph, params, binding } = env;
  // The vertex's OWN adjacency box (`Vertex.adjFrom` / `adjTo`, items 162 and 321), not a hash of
  // its id into the graph's map. This closure runs once per OUTER ROW, and a string-keyed
  // `Map.get` on a 200,000-entry map is ~190 ns (item 194) — measured here as most of the
  // 543 ns a call this shape was paying (item 492).
  const byType = shape.out ? startV.adjFrom : startV.adjTo;

  if (byType === undefined) {
    return false; // no edges in this direction at all
  }

  // A FREE endpoint asks only whether a bucket is non-empty — no generator frame, no edge
  // visited. `edgesOfTypes` yields `Edge` objects and dedupes multi-label edges through a `Set`;
  // neither is needed to answer "is there one" (item 492).
  //
  // The size read rather than a `has`: `deIndexEdgeLabel` DELETES a per-type entry when it
  // empties, so the two are equivalent today and a mutant swapping them survives. Kept as the
  // size read because it does not depend on that invariant, and said plainly rather than
  // claimed as a correctness requirement — an earlier version of this comment asserted an empty
  // bucket could persist, which the store does not allow.
  // A FREE endpoint is free only if nothing has BOUND it. `shape.free` is a compile-time fact
  // about the pattern text — no label, no inline predicate, no sub-`WHERE` — and boundness is a
  // run-time one, exactly as `degreeCountSubquery`'s far-variable check is. Without this, an
  // endpoint variable the OUTER row already bound was ignored and the arm answered "does `u`
  // have an edge of these types" instead of "is `u` joined to THAT vertex":
  //
  //   MATCH (x), (y) WHERE y.n = 3 AND EXISTS { (x)-[:T]->(y) }   answered x = a AND x = d
  //   MATCH (x) WHERE EXISTS { (x)-[:T]->(x) }                    answered every x with an edge
  //
  // Both are wrong, both returned the correct answer from the native engine, and no test
  // covered either (item 525). The second is the self-loop question, which is why
  // `degreeCountSubquery` has had the same check since item 211.
  if (shape.free && (far.variable === undefined || !binding.has(far.variable))) {
    const { types } = shape;

    if (types === undefined) {
      for (const set of byType.values()) {
        if (set.size > 0) {
          return true;
        }
      }

      return false;
    }

    return types.some((t) => (byType.get(t)?.size ?? 0) > 0);
  }

  // A LABEL-ONLY endpoint with no sub-`WHERE`. `matchNode` would do the same label test and
  // then ALLOCATE a binding (`withBinding`) for an endpoint variable nothing reads — once per
  // edge, over the whole adjacency when the answer is no. The two remaining parts of
  // `matchNode` are kept verbatim: the label, and `consistent`, which is what makes a
  // REPEATED endpoint variable (`EXISTS { (u)-[:T]->(u) }`, or one bound outside) still mean
  // identity rather than "any neighbour". Only the allocation goes.
  //
  // Measured at 200,000 vertices / 1,000,000 edges (item 525): `EXISTS { (x)-[:E]->(b:Half) }`
  // cost 277.6 ms against 95.0 for the FREE-endpoint arm, which answers from a bucket size.
  if (sub.where === undefined && !hasPredicate(far.pred)) {
    const { label, variable } = far;

    for (const e of edgesOfTypes(byType, shape.types)) {
      const landed = shape.out ? e.to : e.from;

      if (matchesLabel(landed, label) && consistent(binding, variable, landed)) {
        return true;
      }
    }

    return false;
  }

  for (const e of edgesOfTypes(byType, shape.types)) {
    const landed = shape.out ? e.to : e.from;
    const bound = matchNode(binding, far, landed, params, graph);

    if (
      bound !== null &&
      (sub.where === undefined || asTruth(sub.where({ binding: bound, params, graph })) === true)
    ) {
      return true;
    }
  }

  return false;
};

/** ISO count subquery: the number of matches of the correlated sub-pattern. */
/**
 * `COUNT { (u)-[:T]->(x) }` where `u` is already bound is a DEGREE, and answering it as one skips
 * the matcher entirely.
 *
 * A correlated subquery runs once per outer row, and `matchClauseBindings` is a general matcher:
 * on 20,000 vertices at degree 3 it cost **1614ns an outer row** to produce three bindings, where
 * the same degrees computed by a grouped hop count cost **291ns**. Materializing the bindings was
 * not the problem — removing the `[...spread]` bought 2% — the matcher invocation was (item 211).
 *
 * `null` unless the shape really is a degree. Every condition below exists because the alternative
 * is a different question:
 *
 *   - ONE pattern, ONE segment, no path variable — anything else is not a single hop.
 *   - an anonymous, DIRECTED rel. A rel variable would be bindable and `both` would count a
 *     self-loop from both ends, which `side` does not do.
 *   - a PLAIN start and far node (no inline constraint), because `side` applies a label and
 *     nothing else. A far LABEL is fine — that is exactly `side`'s last argument.
 *   - no sub-`WHERE`.
 *   - the far variable must differ from the start's: `COUNT { (u)-[:T]->(u) }` counts self-loops,
 *     not degree. This one is REDUNDANT with the runtime far-variable check below — the start is
 *     bound by definition, so a far variable equal to it is bound too — and mutation confirms
 *     removing it changes no answer. It stays as the cheaper, earlier statement of the rule, and
 *     because it is the condition a reader expects to find at compile time.
 *
 * Two conditions can only be checked at RUN time, because the subquery's own text does not say
 * which names the outer scope has bound:
 *
 *   - the START must BE bound. `COUNT { (z)-[:T]->(x) }` with `z` free scans every `z`, which is
 *     not a degree of anything.
 *   - the FAR variable must NOT be bound. `COUNT { (u)-[:T]->(w) }` with `w` bound outside counts
 *     the edges from `u` to THAT `w`, not `u`'s degree.
 *
 * Either failing falls back to the general count, so the fast path never answers a question it was
 * not handed.
 */
/** One hop of a degree-shaped subquery, after the guards. */
const hopOf = (
  seg: Segment,
): {
  out: boolean;
  types: string[] | undefined;
  label: LabelExpr | undefined;
  variable: string | undefined;
} | null => {
  const { rel, node } = seg;

  // An anonymous DIRECTED rel. A rel variable is bindable — and bound OUTSIDE it correlates on
  // that one edge, which is the far-variable hazard again (`(p)-[r:T]->(z)` answers 1, not the
  // degree). `both` counts both directions, which `side` does not.
  if (
    !plainRel(rel) ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    !plainNode(node)
  ) {
    return null;
  }

  const types = relTypeNames(rel.label);

  return types === null
    ? null
    : { out: rel.direction === 'out', types, label: node.label, variable: node.variable };
};

/**
 * `COUNT { (u)-[:T]->(x) }` — or `(u)-[:T1]->(x)-[:T2]->(y)` — where `u` is already bound is a
 * DEGREE, and answering it as one skips the matcher.
 *
 * A correlated subquery runs once per outer row, and `matchClauseBindings` is a general matcher: on
 * 20,000 vertices at degree 3 the one-hop form cost **1614ns an outer row** to produce three
 * bindings, where the same degrees via a grouped hop count cost **291ns**. Materializing the
 * bindings was not the problem — removing the `[...spread]` bought 2% — the matcher invocation was
 * (item 211). The two-hop form cost **4943ns** and is item 212.
 *
 * `null` unless the shape really is a degree. Each compile-time condition is in `hopOf` above or
 * here because the alternative is a different question: ONE pattern, no path variable, one or two
 * segments; plain nodes throughout; no sub-`WHERE`; and no repeated variable, since
 * `COUNT { (u)-[:T]->(u) }` counts self-loops rather than degree.
 *
 * Conditions that can only be checked at RUN time, because the subquery's own text does not say
 * which names the outer scope has bound:
 *
 *   - the START must BE bound. `COUNT { (z)-[:T]->(x) }` with `z` free scans every `z`, which is
 *     not a degree of anything.
 *   - every INNER variable must NOT be bound. `COUNT { (u)-[:T]->(w) }` with `w` bound outside
 *     counts the edges from `u` to THAT `w`, not `u`'s degree — and the same applies to a two-hop
 *     pattern's middle.
 *
 * Either failing falls back to the general count, so the fast path never answers a question it was
 * not handed.
 */
/**
 * `COUNT { (x)-[:T]->(b[:L]) WHERE <pred on b> }` — a one-hop degree with a LANDING PREDICATE.
 *
 * `degreeCountSubquery` declines on its FIRST line when the body carries a `WHERE`, so this
 * shape fell back to materializing the body's bindings once per outer row. Measured at 200,000
 * vertices / 1,000,000 edges (item 524):
 *
 * ```text
 *   COUNT { (x)-[:KNOWS]->(b) }                      100.6 ms   (takes the degree rung)
 *   COUNT { (x)-[:KNOWS]->(b:Half) }                 362.3      (takes it, with a label)
 *   COUNT { (x)-[:KNOWS]->(b) WHERE b.age > 50 }     745.6      (declined — this one)
 * ```
 *
 * The two rows above it are the diagnosis AND the controls: the rung exists and carries a
 * label, so the third is not slow everywhere — it is refused.
 *
 * The admission is narrow on purpose, and each clause buys something:
 *
 *   - ONE segment. A deeper chain's predicate would have to be applied at the right hop, and
 *     `twoHopSide` / `threeHopSide` walk without ever naming an intermediate — a different
 *     question, left to the general path.
 *   - The `WHERE` reads the LANDING VARIABLE and nothing else (`freePredicateVars`). A free
 *     outer name would make this a correlated filter rather than a per-neighbour one.
 *   - NO subquery in the predicate. This one is CONSERVATISM, not necessity, and its mutant
 *     says so by surviving: the scratch binding is allocated per `countOf` CALL, so a nested
 *     subquery that re-enters this rung gets its own, and reading the outer `b` out of the
 *     scratch map is exactly what it should do. Widening it is a measurable change of its own
 *     — a per-neighbour subquery is not obviously cheaper here than the general path — so it
 *     is left refused and recorded rather than quietly admitted.
 *
 * Three-valued logic is the general path's, not a simplification of it: a neighbour counts only
 * on a clean TRUE, so UNKNOWN (a null operand) does not count, and a FAULT propagates rather
 * than being swallowed — `WHERE` in a subquery body raises exactly as it does at the top level.
 */
const landingPredDegreeCount = (
  expr: Extract<Expr, { kind: 'countSubquery' }>,
): {
  startVar: string;
  inner: readonly string[];
  countOf: (v: Vertex, env: EvalEnv) => number;
} | null => {
  const { where } = expr;

  if (where === undefined || expr.patterns.length !== 1 || hasSubquery(where)) {
    return null;
  }

  const [path] = expr.patterns;

  if (path.pathVar !== undefined || path.segments.length !== 1) {
    return null;
  }

  const { start } = path;
  const startVar = start.variable;

  if (startVar === undefined || !plainNode(start) || start.label !== undefined) {
    return null;
  }

  const [seg] = path.segments;
  const hop = hopOf(seg);

  // A repeated variable is a self-join, not a degree — `(u)-[:T]->(u)` counts self-loops.
  // REDUNDANT today, and its mutant survives: if the landing names the anchor, the call site's
  // `binding.has(inner[0])` is already true (the anchor had to be bound to get here) and the
  // rung stands down there instead. Kept as the local statement of the invariant; the call
  // site's check is the one with teeth.
  if (hop === null || hop.variable === undefined || hop.variable === startVar) {
    return null;
  }

  const landing = hop.variable;

  for (const free of freePredicateVars(where)) {
    if (free !== landing) {
      return null;
    }
  }

  const pred = gatePredicate(where);
  const { out, types, label } = hop;

  return {
    startVar,
    inner: [landing],
    countOf: (v, env) => {
      // ONE scratch binding per OUTER ROW, rewritten per neighbour, rather than one binding
      // per match. The predicate reads `landing` and nothing else, which is what makes a
      // single-entry map a complete environment for it — and per CALL rather than per rung,
      // so two nested invocations never share one.
      const binding = new Map<string, unknown>();
      const { params, graph } = env;

      return sideOfVertexGated(v, out, types, label, (node) => {
        binding.set(landing, node);

        return asTruth(pred({ binding, params, graph })) === true;
      });
    },
  };
};

const degreeCountSubquery = (
  expr: Extract<Expr, { kind: 'countSubquery' }>,
): {
  startVar: string;
  inner: readonly string[];
  count: (graph: Graph, id: string) => number;
  // Present only for the shapes that can read the anchor's box — the one-hop degree. The
  // two-hop side still resolves mid-vertices by id, which is a different question.
  countOf?: (v: Vertex, graph: Graph) => number;
} | null => {
  if (expr.where !== undefined || expr.patterns.length !== 1) {
    return null;
  }

  const [path] = expr.patterns;

  // THREE segments is the deepest this answers. Each extra hop makes the walk one degree wider
  // (the last hop is a `side`, every earlier one iterates), so the saving against materializing
  // the bindings is a factor of the degree and the recursion depth has to be bounded by
  // something — the native twin stops at the same place for the same reason (item 496).
  if (path.pathVar !== undefined || path.segments.length < 1 || path.segments.length > 3) {
    return null;
  }

  const { start } = path;
  const startVar = start.variable;

  if (startVar === undefined || !plainNode(start) || start.label !== undefined) {
    return null;
  }

  const hops = path.segments.map(hopOf);

  if (hops.some((h) => h === null)) {
    return null;
  }

  const [h1, h2, h3] = hops as {
    out: boolean;
    types: string[] | undefined;
    label: LabelExpr | undefined;
    variable: string | undefined;
  }[];
  const inner = hops.map((h) => h?.variable).filter((v): v is string => v !== undefined);

  // A repeated variable is a self-join, not a degree: `(u)-[:T]->(u)` counts self-loops, and
  // `(u)-[:T1]->(x)-[:T2]->(x)` counts triangles back to the middle.
  if (new Set([startVar, ...inner]).size !== inner.length + 1) {
    return null;
  }

  if (h2 === undefined) {
    return {
      startVar,
      inner,
      // The ONE-hop degree reads the anchor's adjacency box; see `sideOfVertex` for why `side`
      // itself is left on the id (item 355) and what claim this is taken under (item 493).
      countOf: (v, _graph) => sideOfVertex(v, h1.out, h1.types, h1.label),
      count: (graph, id) => side(graph, id, h1.out, h1.types, h1.label),
    };
  }

  const plan: TwoHopSide = {
    firstOut: h1.out,
    t1: h1.types,
    midLabel: h1.label,
    secondOut: h2.out,
    t2: h2.types,
    farLabel: h2.label,
  };

  if (h3 !== undefined) {
    // The first hop is walked here and the remaining TWO are `twoHopSide`'s, so `plan` above
    // becomes the tail rather than the whole chain: its `firstOut`/`t1`/`midLabel` are hop TWO's.
    const three: ThreeHopSide = {
      firstOut: h1.out,
      t1: h1.types,
      mid1Label: h1.label,
      rest: {
        firstOut: h2.out,
        t1: h2.types,
        midLabel: h2.label,
        secondOut: h3.out,
        t2: h3.types,
        farLabel: h3.label,
      },
    };

    return { startVar, inner, count: (graph, id) => threeHopSide(graph, id, three) };
  }

  return { startVar, inner, count: (graph, id) => twoHopSide(graph, id, plan) };
};

/**
 * Wrap a compiled subquery so an UNCORRELATED one is evaluated ONCE per plan invocation.
 *
 * `freePredicateVars` already answers the admission question exactly: it returns the OUTER names
 * an expression reads, with the subquery's own pattern bindings excluded, so an empty set IS
 * "this body does not depend on the row". A `$param` is not a variable and does not appear
 * there, which is correct — params are fixed for the run too.
 *
 * `execEpoch` is the guard. Compiled plans are CACHED across executions (`planCache`), so a
 * closure-local value with no epoch would be served to a later run against a mutated graph; with
 * it, the memo is scoped to exactly one `plan(graph, params)` call. The same mechanism already
 * backs the `in` arm's hashed haystack.
 */
const memoizeIfUncorrelated = (
  expr: Extract<Expr, { kind: 'exists' | 'countSubquery' | 'valueSubquery' }>,
  fn: CompiledExpr,
): CompiledExpr => {
  if (!memoUncorrelated || correlatedSubqueries.has(expr)) {
    return fn;
  }

  let epoch = -1;
  let value: unknown;

  return (env) => {
    if (epoch !== execEpoch) {
      value = fn(env);
      epoch = execEpoch;
    }

    return value;
  };
};

const compileCountSubquery = (expr: Extract<Expr, { kind: 'countSubquery' }>): CompiledExpr => {
  const sub = compileSubMatch(expr);
  const degree = degreeCountSubquery(expr);
  // The `WHERE` twin of the rung above; `degreeCountSubquery` refuses a body that carries one.
  // Mutually exclusive by construction, so the order is not load-bearing here.
  const gated = degree === null ? landingPredDegreeCount(expr) : null;

  // COUNT the iterator; do not materialize it. `[...matches].length` built an ARRAY per outer row
  // purely to read its length, and a correlated subquery runs once per row — so
  // `RETURN COUNT { (u)-[:T]->(x) }` over 20,000 vertices at degree 3 allocated 20,000 arrays to
  // hold 60,000 bindings it then threw away. `compileExists` above never had this: it pulls one
  // with `matches.next()` and stops.
  //
  // Measured on exactly that shape (audit item 211): 1650ns an outer row against 262ns for the
  // same degrees computed by a grouped hop count, which is the floor this should be near.
  return (env) => {
    if (degree !== null) {
      const anchor = env.binding.get(degree.startVar);

      // Every INNER variable being UNBOUND is what makes this a degree rather than a pair or
      // triple count, and `has` is the check — a variable bound to `null` is still bound.
      if (isVertex(anchor) && !degree.inner.some((v) => env.binding.has(v))) {
        return degree.countOf === undefined
          ? degree.count(env.graph, anchor.id)
          : degree.countOf(anchor, env.graph);
      }
    }

    if (gated !== null) {
      const anchor = env.binding.get(gated.startVar);

      if (isVertex(anchor) && !env.binding.has(gated.inner[0])) {
        return gated.countOf(anchor, env);
      }
    }

    // `[Symbol.iterator]()` because `matchClauseBindings` is typed `Iterable<Binding>`, not
    // `Iterator` — it is a generator at run time, so `.next()` WORKS and the tests passed, but
    // only `bun run typecheck` catches that it is not typed. (Which is why typecheck is its own
    // gate here: see the CI lesson in `local-gates-vs-ci`.)
    const matches = matchClauseBindings(env.graph, sub, env.binding, env.params)[Symbol.iterator]();
    let n = 0;

    // `.next()` rather than `for…of` so there is no per-iteration binding to name and discard —
    // the same loop shape `compileExists` uses.
    while (!matches.next().done) {
      n += 1;
    }

    return n;
  };
};

/**
 * ISO `VALUE { … RETURN e }`: a scalar (single-value) correlated subquery.
 * Collect every correlated match, then: an aggregate RETURN folds the whole
 * group to one value (0 rows → the aggregate's empty answer); a non-aggregate
 * RETURN yields NULL for 0 rows, the value for exactly one, and a **cardinality
 * error** for more than one (ISO: a scalar subquery must not deliver >1 row) —
 * loud, never a silent first-of-many. Mirrors the native `value_subquery`.
 */
/**
 * Aggregate names a one-hop `VALUE { … }` body may ride the adjacency walk with (item 557).
 *
 * FOUR names are left off DELIBERATELY, and not for an order reason: native REFUSES `collect`,
 * `collect_list`, both stddevs AND `count(<arg>)` inside a subquery body (`RETURN CollectList(…)
 * is not supported in …`) while TS answers all of them. Those are open divergences, found by
 * probing this very enum and recorded at item 557 — optimizing a shape the two engines disagree
 * about would only make the divergent answer arrive faster.
 *
 * `count(*)` is absent for a different reason: it has had its own rung since item 499 lowered it
 * onto the degree path, and that path reads a bucket size without visiting an edge.
 */
const HOP_VALUE_AGGREGATES: ReadonlySet<string> = new Set(['min', 'max', 'sum', 'avg']);

/**
 * `VALUE { MATCH (u)-[:T]->(x) [WHERE p] RETURN <agg>(x.k) }` — ONE scalar aggregate over a
 * one-hop pattern from an anchor the outer row already bound.
 *
 * The count spelling has had a rung since item 499 lowered it onto the degree path; every OTHER
 * aggregate materialized the whole match set per outer row — a `Binding` Map per neighbour plus
 * the array holding them — and the enum shows exactly that split. 200,000 vertices / 200,000
 * edges, one case per process:
 *
 * ```text
 *   VALUE { … RETURN count(*) }         27.07 ms     on the degree rung
 *   VALUE { … RETURN avg(x.age) }      154.73        5.7x
 *   VALUE { … RETURN sum(x.age) }      155.16
 *   VALUE { … RETURN max(x.age) }      161.03        5.9x
 *   VALUE { … RETURN min(x.age) }      170.50        6.3x
 * ```
 *
 * The native engine answers all of them in 4.7-5.8 ms, so the gap is TS-only.
 *
 * This streams the anchor's adjacency instead, collecting the argument's VALUES into one array
 * per outer row and handing them to the same {@link aggregateOverValues} the general path calls
 * — so the two routes cannot drift on a nullish rule or an empty group. The admission mirrors
 * {@link landingPredDegreeCount}'s: one segment, a plain unlabelled anchor, a landing variable
 * that is not the anchor (a repeated variable is a self-join, not a degree), and a `WHERE` that
 * reads the landing variable and nothing else.
 */
const hopValueAggregate = (
  expr: Extract<Expr, { kind: 'valueSubquery' }>,
): {
  startVar: string;
  landing: string;
  name: string;
  valueOf: (v: Vertex, env: EvalEnv) => unknown;
} | null => {
  const { ret, where } = expr;

  if (expr.patterns.length !== 1 || ret.kind !== 'func' || ret.distinct) {
    return null;
  }

  // `star` is `count(*)`, which this rung never takes — so a star is a refusal outright.
  if (ret.star || !HOP_VALUE_AGGREGATES.has(ret.name)) {
    return null;
  }

  if (where !== undefined && hasSubquery(where)) {
    return null;
  }

  const [path] = expr.patterns;

  if (path.pathVar !== undefined || path.segments.length !== 1) {
    return null;
  }

  const { start } = path;
  const startVar = start.variable;

  if (startVar === undefined || !plainNode(start) || start.label !== undefined) {
    return null;
  }

  const [seg] = path.segments;
  const hop = hopOf(seg);

  if (hop === null || hop.variable === undefined || hop.variable === startVar) {
    return null;
  }

  const landing = hop.variable;

  for (const free of freePredicateVars(where ?? { kind: 'lit', value: true })) {
    if (free !== landing) {
      return null;
    }
  }

  // The argument must read the LANDING and nothing else, for the same reason the predicate must:
  // the scratch binding below holds that one name, so an outer reference would resolve to
  // `undefined` rather than to the outer row's value.
  const [argExpr] = ret.args;

  if (ret.args.length !== 1 || argExpr === undefined || hasSubquery(argExpr)) {
    return null;
  }

  // `freePredicateVars` is general over `Expr` despite its name — it is the same walk the
  // predicate check above uses, and the aggregate's argument is just another expression.
  for (const free of freePredicateVars(argExpr)) {
    if (free !== landing) {
      return null;
    }
  }

  const pred = where === undefined ? undefined : gatePredicate(where);
  const argFn = compileExpr(argExpr);
  const { out, types, label } = hop;

  return {
    startVar,
    landing,
    name: ret.name,
    valueOf: (v, env) => {
      // ONE scratch binding and ONE array per OUTER ROW, against the general path's `Binding`
      // Map per neighbour plus an array of them.
      const binding = new Map<string, unknown>();
      const { params, graph } = env;
      const values: unknown[] = [];

      sideOfVertexGated(v, out, types, label, (node) => {
        binding.set(landing, node);

        if (pred !== undefined && asTruth(pred({ binding, params, graph })) !== true) {
          return false;
        }

        // Nullish values are dropped exactly as the general path's `nonNull` filter drops them,
        // which is what makes `aggregateOverValues` below the same fold on the same input.
        const value = argFn({ binding, params, graph });

        if (!isNullish(value)) {
          values.push(value);
        }

        return false;
      });

      return aggregateOverValues(ret.name, values, 0);
    },
  };
};

const compileValueSubquery = (expr: Extract<Expr, { kind: 'valueSubquery' }>): CompiledExpr => {
  const sub = compileSubMatch(expr);
  const retFn = compileExpr(expr.ret);
  const isAgg = hasAggregate(expr.ret);
  const hopAgg = hopValueAggregate(expr);

  return (env) => {
    if (hopAgg !== null) {
      const anchor = env.binding.get(hopAgg.startVar);

      // The anchor BOUND and the landing UNBOUND is what makes this a degree-shaped fold rather
      // than a test of a pair — the same run-time check `degreeCountSubquery`'s call site makes.
      if (isVertex(anchor) && !env.binding.has(hopAgg.landing)) {
        return hopAgg.valueOf(anchor, env);
      }
    }

    const matches = [...matchClauseBindings(env.graph, sub, env.binding, env.params)];

    if (isAgg) {
      // Fold over the group: `count(*)` reads its length, other aggregates read
      // `env.group`; a plain sub-expression reads the first match (or the outer
      // binding when there were none).
      const base = matches[0] ?? env.binding;

      return retFn({ ...env, binding: base, group: matches });
    }

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      dataException(
        'a VALUE scalar subquery returned more than one row; add an aggregate ' +
          '(e.g. count/collect), a LIMIT-like bound, or a more selective pattern',
      );
    }

    return retFn({ ...env, binding: matches[0] });
  };
};

/**
 * ISO `<let value expression>`: `LET x = e, … IN body END`. Binds each local into
 * a fresh extended binding (left-to-right, so a later binding sees earlier ones),
 * then evaluates the body against it. The group / aggregate context is preserved
 * so an aggregate binding folds over the same group and the body reads the
 * resulting scalar. Mirrors the native `CExpr::LetIn`.
 */
const compileLetIn = (expr: Extract<Expr, { kind: 'letIn' }>): CompiledExpr => {
  const bindings = expr.bindings.map((b) => ({ name: b.var, fn: compileExpr(b.expr) }));
  const bodyFn = compileExpr(expr.body);

  return (env) => {
    const local = new Map(env.binding);
    const scoped: EvalEnv = { ...env, binding: local };

    for (const { name, fn } of bindings) {
      local.set(name, fn(scoped));
    }

    return bodyFn(scoped);
  };
};

/**
 * Compile an ISO CASE expression. A simple CASE (with `subject`) returns the
 * first branch whose value equals the subject; a searched CASE returns the first
 * branch whose condition is exactly TRUE. No match falls to ELSE (or NULL).
 */
const compileCase = (expr: Extract<Expr, { kind: 'case' }>): CompiledExpr => {
  const subject = expr.subject ? compileExpr(expr.subject) : undefined;
  // `then` is the ISO GQL CASE…WHEN…THEN branch, not a thenable; never awaited.
  // eslint-disable-next-line unicorn/no-thenable
  const whens = expr.whens.map((w) => ({ when: compileExpr(w.when), then: compileExpr(w.then) }));
  const elseFn = expr.elseExpr ? compileExpr(expr.elseExpr) : undefined;

  return (env) => {
    if (subject) {
      const s = subject(env);

      for (const w of whens) {
        const wv = w.when(env);

        // `subject = when` with SQL/ISO null semantics: NULL never matches, and
        // the match is the engine's VALUE equality (`structuralEq`, what `=` uses),
        // not JS `===` — native lowers simple CASE to searched `WHEN subject = v`, so
        // two temporals/lists/records holding the same value must match.
        if (!isNullish(s) && !isNullish(wv) && structuralEq(s, wv)) {
          return w.then(env);
        }
      }
    } else {
      for (const w of whens) {
        if (asTruth(w.when(env)) === true) {
          return w.then(env);
        }
      }
    }

    return elseFn ? elseFn(env) : null;
  };
};

const compileFunc = (expr: FuncExpr): CompiledExpr => {
  if (AGGREGATES.has(expr.name)) {
    return compileAggregate(expr);
  }

  const { name } = expr;
  const args = expr.args.map(compileExpr);

  // Resolve the function NAME eagerly while a *query* compiles — before any row
  // runs. An unknown function is never valid regardless of row count or branch
  // reachability, so `bogus_fn(x)` must fault identically over zero rows, one
  // row, or inside a never-taken `CASE` branch. Previously the `UnknownFunction`
  // fault fired only from the per-row `callScalar`, so an empty result set (or a
  // dead branch) silently returned `[]`. The name is recorded into the
  // query-scoped `unknownFnCollector`; `compile` throws once it finishes walking
  // the tree (mirrors the Rust plan's `unknown_fns`, checked in `run_cquery_body`
  // before the first row). A validator predicate compiles with the collector
  // unset, so its unknown-fn timing stays per-row — matching the Rust
  // `eval_predicate` path (both engines surface a validator's unknown fn at write
  // time, not declare time).
  if (unknownFnCollector && !isKnownScalarFn(name)) {
    unknownFnCollector.add(name);
  }

  // Reject the wrong argument count EAGERLY, while the query compiles — native
  // rejects arity in its parser, before any row runs, so `abs(1, 2)` or `mod(1)`
  // must fault identically over zero rows or inside a never-taken branch (not
  // silently drop the extra arg / read the missing one as null, as the per-row
  // dispatch otherwise would). `scalarArityOk` returns `undefined` for a name it
  // does not govern (unknown fns, aggregates, path accessors) — those keep their
  // own resolution path. E_SYNTAX matches native's parse-time classification.
  if (scalarArityOk(name, expr.args.length) === false) {
    throw new LenkeError(`${name}() called with the wrong number of arguments`, {
      code: ErrorCode.Syntax,
    });
  }

  return (env) =>
    callScalar(
      name,
      args.map((f) => f(env)),
      env.graph.limits,
    );
};

// A shared empty probe arg list — `callScalar` treats absent args as null, so a
// KNOWN scalar function resolves to null (never throwing `UnknownFunction`);
// only a genuinely unknown name reaches the `UnknownFunction` throw.
const FN_PROBE_ARGS: readonly unknown[] = [];

/**
 * Compile-time name resolution for a scalar function. Probes the shared scalar
 * dispatch with placeholder args: the ONLY source of `ErrorCode.UnknownFunction`
 * is an unresolved name (every known function returns — or throws some *other*
 * error — on null args), so a thrown `UnknownFunction` means the name is bogus.
 * Any other throw means the name DID resolve (its real per-row error, e.g. bad
 * arity, still stands). Reachability-independent by construction — the name is
 * resolved whether or not the call ever executes.
 */
const isKnownScalarFn = (name: string): boolean => {
  try {
    callScalar(name, FN_PROBE_ARGS, DEFAULT_CONFIG.limits);

    return true;
  } catch (error) {
    return !(error instanceof LenkeError && error.code === ErrorCode.UnknownFunction);
  }
};

/**
 * A streaming accumulator for the aggregates that are pure LEFT FOLDS over their group's
 * non-null values. `count`, `min` and `max` are the whole set for now, and the reason the
 * others are absent is specific rather than caution:
 *
 * - `sum`/`avg` inspect the WHOLE group before choosing a path (`values.some(isTemporal)`
 *   takes precedence over `values.some(Array.isArray)`). That IS expressible as a fold —
 *   `temporalSum` is itself a left fold — but it needs `{mode, sawArray}` state and its own
 *   item, because getting the precedence subtly wrong is a cross-engine divergence.
 * - `stddev_*` need the moments, `collect`/`collect_list`/percentiles genuinely need every
 *   value, and a `DISTINCT` aggregate needs `distinctByValueKey` over the whole group.
 *
 * **The array path below is DEFINED in terms of these**, which is the condition item 297 set
 * when it left this work: an accumulator that does not also drive the array path becomes a
 * second definition of the semantics, and then the two can drift. There is one definition.
 */
export type AggFold = {
  readonly init: () => unknown;
  readonly step: (acc: unknown, v: unknown) => unknown;
  readonly finish: (acc: unknown) => unknown;
};

const COUNT_FOLD: AggFold = {
  init: () => 0,
  step: (acc) => (acc as number) + 1,
  finish: (acc) => acc,
};

const extremumFold = (wantMin: boolean): AggFold => ({
  init: () => undefined,
  step: (acc, v) => {
    if (acc === undefined) {
      return v;
    }

    const ord = compareValues(v, acc);

    return (wantMin ? ord < 0 : ord > 0) ? v : acc;
  },
  finish: (acc) => (acc === undefined ? null : acc),
});

/**
 * The aggregate's percentile fraction, or `0` for a name that has none — and `null` to REFUSE.
 *
 * `percentile_cont`/`percentile_disc` are the only two-argument aggregates, and the second
 * argument must be a numeric literal. Anything else (wrong arity, a non-literal fraction) is
 * refused rather than diagnosed, so the general path raises exactly the error it always raised.
 * The clamp mirrors `compileAggregate`'s, because the two must agree on the fraction before they
 * can agree on the answer.
 */
export const percentileFraction = (e: Extract<Expr, { kind: 'func' }>): number | null => {
  if (e.name !== 'percentile_cont' && e.name !== 'percentile_disc') {
    return e.args.length === 1 ? 0 : null;
  }

  const [, f] = e.args;

  if (e.args.length !== 2 || f?.kind !== 'lit' || typeof f.value !== 'number') {
    return null;
  }

  return Math.min(1, Math.max(0, f.value));
};

/**
 * The fold for an aggregate, or `undefined` when it must see the whole group. `DISTINCT` is
 * refused here rather than at the call site so there is one place to read the answer from.
 */
/**
 * Are all of an UN-GROUPED aggregate projection's sort keys plain references to its own output
 * columns?
 *
 * Such a projection delivers exactly ONE row, so `DISTINCT` and `ORDER BY` are both identities on
 * it — the argument `detectCountShortcut` already makes for SKIP/LIMIT, extended to the other two
 * clauses at item 544 and to the four aggregate rungs at item 545. A row cannot be deduplicated
 * away from itself and cannot be reordered.
 *
 * The one thing a rung still cannot skip is a sort key that might FAULT: `ORDER BY 1 / 0` raises
 * on the general path, and a shortcut that never evaluated the key would answer past it. A
 * reference to a column the projection just produced cannot fault beyond producing it, so that is
 * the whole admission — and it is read off the AST, because the compiled sort items are closures.
 *
 * Only the `kind === 'var'` half is load-bearing, and mutation says so: dropping the NAME check,
 * or emptying the name set, leaves every answer unchanged. The first is equivalent by
 * construction — an aggregating projection's ORDER BY resolves against the OUTPUT columns, so any
 * valid `var` key already names one — and the second only makes the rungs decline, which is
 * slower and not wrong. Both are kept as the local statement of the rule.
 */
export const sortsOnOutputOnly = (
  ret: Extract<Clause, { kind: 'return' }>,
  proj: CProjection,
): boolean => {
  const names = new Set(proj.items.map((it) => it.name));

  return (ret.projection.orderBy ?? []).every(
    (sort) => sort.expr.kind === 'var' && names.has(sort.expr.name),
  );
};

export const foldFor = (name: string, star: boolean, distinct: boolean): AggFold | undefined => {
  if (distinct || star) {
    return undefined; // count(*) has its own O(groups) path; DISTINCT needs every value
  }

  switch (name) {
    case 'count':
      return COUNT_FOLD;
    case 'min':
      return extremumFold(true);
    case 'max':
      return extremumFold(false);
    default:
      return undefined;
  }
};

/** Run a fold over an already-materialized group's values — the array path. */
const runFold = (fold: AggFold, values: unknown[]): unknown => {
  let acc = fold.init();

  for (const v of values) {
    acc = fold.step(acc, v);
  }

  return fold.finish(acc);
};

/**
 * Compile an aggregate. The argument expression is lowered once; at run time we
 * fold it over the `group` of bindings (or `[binding]` when called outside an
 * aggregating projection).
 */
/**
 * Apply an aggregate to an already-collected list of its argument's VALUES (audit item 468).
 *
 * Extracted verbatim from `compileAggregate`'s closure, which computed `values` by mapping a
 * group of BINDINGS through the argument expression and then ran this switch. The switch needs
 * only the name, the values and the percentile fraction — nothing from the binding — so the two
 * halves separate cleanly, and that separation is what lets a caller who can produce the values
 * more cheaply skip the group entirely.
 *
 * There is ONE implementation: `compileAggregate` calls this, and so does the scan shortcut. A
 * hand-written streaming fold would have been a second one, and for `sum` it could not even be
 * written — the operation is chosen by looking at the WHOLE collection (a temporal anywhere
 * means `temporalSum`, an array anywhere throws), which item 467 is the entry about.
 */
export const aggregateOverValues = (name: string, values: unknown[], frac: number): unknown => {
  switch (name) {
    // These three go through `foldFor`'s accumulator rather than reimplementing it, so the
    // streaming path and the array path cannot drift apart (item 297's condition).
    case 'count':
      return runFold(COUNT_FOLD, values);
    // `sum` over DURATIONs folds via the same `dur + dur` (overflow throws);
    // `avg` over any temporal, and `sum` over a non-DURATION, are loud data
    // exceptions rather than a silent NaN → null. Mirrors the native engine.
    // A temporal ANYWHERE in the group (not just the first row) makes the
    // aggregate unrepresentable — a heterogeneous numeric+temporal column must
    // throw, not silently coerce the temporal to `NaN`→`null`. Native faults
    // per-value, so we scan for any temporal to stay byte-identical.
    case 'sum':
      if (values.some(isTemporal)) {
        return temporalSum(values);
      }

      if (values.some(Array.isArray)) {
        throw nonNumericAgg();
      }

      return values.reduce<number>((s, v) => s + numArg(v), 0);
    case 'avg':
      if (values.some(isTemporal)) {
        throw unsupportedTemporalAgg();
      }

      if (values.some(Array.isArray)) {
        throw nonNumericAgg();
      }

      return values.length === 0
        ? null
        : values.reduce<number>((s, v) => s + numArg(v), 0) / values.length;
    case 'min':
      return runFold(extremumFold(true), values);
    case 'max':
      return runFold(extremumFold(false), values);
    case 'collect':
    case 'collect_list':
      return values;
    case 'percentile_cont':
      return percentileOf(values, frac, true);
    case 'percentile_disc':
      return percentileOf(values, frac, false);
    // ISO population / sample standard deviation, one-pass over the group's
    // numeric values — the SAME formula the native engine uses, so the f64
    // result is byte-identical. `stddev_pop` null over 0 rows; `stddev_samp`
    // null over fewer than 2; the summed squared deviation is clamped at 0 so
    // float cancellation can't slip a tiny negative into sqrt.
    case 'stddev_pop':
    case 'stddev_samp': {
      const sample = name === 'stddev_samp';
      const n = values.length;

      // Type-check the values (via `numArg`) BEFORE the count short-circuit: a non-numeric
      // value is a data exception even when there are too few rows to compute a deviation,
      // so `stddev_samp(true)` FAULTS rather than returning null. Matches the native engine
      // and `sum`/`avg`/`percentile`. An empty group has nothing to check → null below.
      let s = 0;
      let sq = 0;

      for (const v of values) {
        const x = numArg(v);
        s += x;
        sq += x * x;
      }

      if (sample ? n < 2 : n === 0) {
        return null;
      }

      const variance = (sq - (s * s) / n) / (sample ? n - 1 : n);

      return Math.sqrt(Math.max(0, variance));
    }
    default:
      return null;
  }
};

const compileAggregate = (expr: FuncExpr): CompiledExpr => {
  const { name, star, distinct } = expr;

  // ISO forbids an aggregate whose argument contains another aggregate.
  if (expr.args[0] && hasAggregate(expr.args[0])) {
    throw new LenkeError(`aggregate function ${name}() cannot contain another aggregate`, {
      code: ErrorCode.Unsupported,
    });
  }

  // `count(*)` is the only aggregate with no argument expression; anything else
  // argless (`sum()`, bare `count()`) is malformed — reject it cleanly rather
  // than dereferencing an absent argument at fold time.
  if (!expr.args[0] && !(name === 'count' && star)) {
    throw new LenkeError(`aggregate function ${name}() requires an argument`, {
      code: ErrorCode.Unsupported,
    });
  }

  // Percentile aggregates take `(value, literal fraction)`. A malformed call
  // (wrong arity / non-literal fraction) is rejected, mirroring the native engine.
  const isPercentile = name === 'percentile_cont' || name === 'percentile_disc';
  let frac = 0;

  if (isPercentile) {
    const [, f] = expr.args;

    if (expr.args.length !== 2 || f?.kind !== 'lit' || typeof f.value !== 'number') {
      throw new LenkeError(`${name}() requires a numeric literal fraction`, {
        code: ErrorCode.Unsupported,
      });
    }

    frac = Math.min(1, Math.max(0, f.value));
  }

  const argFn = expr.args[0] ? compileExpr(expr.args[0]) : undefined;

  return (env) => {
    const group = env.group ?? [env.binding];

    if (name === 'count' && star) {
      return group.length;
    }

    // Already folded during grouping: the bindings were never retained, so there is nothing
    // to map over and the answer is waiting. Keyed by this aggregate's AST node, which is
    // the same object the streaming path compiled its argument from.
    const preFolded = (group as unknown as Record<symbol, unknown>)[FOLDED] as
      | ReadonlyMap<object, { readonly v: unknown }>
      | undefined;

    if (preFolded !== undefined) {
      const hit = preFolded.get(expr);

      if (hit !== undefined) {
        return hit.v;
      }
    }

    const raw = group.map((b) => argFn!({ ...env, binding: b, group }));
    const nonNull = raw.filter((v) => !isNullish(v));
    // DISTINCT dedups STRUCTURALLY by valueKey (mirroring Rust val_key / dense id),
    // not by reference-identity `new Set` — which would keep value-equal but distinct
    // object instances (temporals, lists, records) separate. e.g. count(DISTINCT
    // DATE'2020-01-01') over two rows must be 1, and count(DISTINCT [x]) dedups too.
    const values = distinct ? distinctByValueKey(nonNull) : nonNull;

    return aggregateOverValues(name, values, frac);
  };
};

/**
 * Compile a standalone boolean predicate (a declarative VALIDATOR constraint,
 * see `@lenke/gql`'s `createValidator`) into a closure that evaluates it against
 * a single graph element bound to `varName`, with empty params. Returns the
 * three-valued result — `true` / `false` / `null` (UNKNOWN) — computed by the
 * *same* expression evaluator a `WHERE` clause uses, so a validator and a `WHERE`
 * agree bit-for-bit. SQL-`CHECK` callers reject only on a definite `false`; a
 * `null` passes. `graph` is read only by an EXISTS/COUNT subquery in the
 * predicate (rare in a validator, but supported for parity with `WHERE`).
 */
export const compileValidator = (
  expr: Expr,
  varName: string,
): ((element: Vertex | Edge, graph: Graph) => boolean | null) => {
  const fn = compileExpr(expr);

  return (element, graph) => {
    const binding: Binding = new Map([[varName, element]]);

    return asTruth(fn({ binding, params: {}, graph }));
  };
};

/** Collect the variables a sub-pattern introduces (start node, each hop's rel + node). */
const patternBoundVars = (p: PathPattern, into: Set<string>): void => {
  const addNode = (n: NodePattern): void => {
    if (n.variable !== undefined) {
      into.add(n.variable);
    }
  };

  if (p.pathVar !== undefined) {
    into.add(p.pathVar);
  }

  addNode(p.start);

  for (const seg of p.segments) {
    // The inner source `(x)` and target `(y)` group variables of a subpath, plus any
    // intermediate nodes / edges of a MULTI-element repetition unit.
    if (seg.hopFrom !== undefined) {
      addNode(seg.hopFrom);
    }

    if (seg.hopTo !== undefined) {
      addNode(seg.hopTo);
    }

    for (const extra of seg.unitRest ?? []) {
      if (extra.rel.variable !== undefined) {
        into.add(extra.rel.variable);
      }

      addNode(extra.node);
    }

    if (seg.rel.variable !== undefined) {
      into.add(seg.rel.variable);
    }

    addNode(seg.node);
  }
};

/**
 * Collect every FREE variable a predicate references — a `var`/`prop` name that
 * is NOT bound by an enclosing `EXISTS`/`COUNT` sub-pattern. A VALIDATOR
 * predicate has exactly one legitimate free variable, the declared `varName`
 * (the element under test); a reference to any *other* free name (a typo like
 * `x.age` when the binding is `u`, or a bare `age`) is unbound, so the predicate
 * silently evaluates to UNKNOWN and the SQL-`CHECK` never fires. `createValidator`
 * walks this set and rejects such a predicate at declare time. Sub-query pattern
 * variables are bound *within* the sub-query, so they are correctly NOT free and
 * must not be flagged. Mirrors the Rust `free_predicate_vars` (`plan.rs`).
 */
export const freePredicateVars = (expr: Expr): Set<string> => {
  const free = new Set<string>();

  const walkPattern = (p: PathPattern, bound: ReadonlySet<string>): void => {
    const walkNode = (n: NodePattern): void => {
      for (const c of n.properties ?? []) {
        walk(c.value, bound);
      }

      if (n.where) {
        walk(n.where, bound);
      }
    };

    walkNode(p.start);

    for (const seg of p.segments) {
      for (const c of seg.rel.properties ?? []) {
        walk(c.value, bound);
      }

      if (seg.rel.where) {
        walk(seg.rel.where, bound);
      }

      walkNode(seg.node);
    }
  };

  // `EXISTS { … }` / `COUNT { … }`: the sub-pattern binds its own variables, so
  // extend the bound set before descending into its inline predicates/WHERE —
  // those bindings aren't free references, but outer names still are. Extracted
  // from `walk` to keep that switch under the complexity budget.
  const walkSubquery = (
    e: Extract<Expr, { kind: 'exists' | 'countSubquery' | 'valueSubquery' }>,
    bound: ReadonlySet<string>,
  ): void => {
    const inner = new Set(bound);

    for (const p of e.patterns) {
      patternBoundVars(p, inner);
    }

    for (const p of e.patterns) {
      walkPattern(p, inner);
    }

    if (e.where) {
      walk(e.where, inner);
    }

    // A VALUE subquery's RETURN expression also reads the subquery's own bindings.
    if (e.kind === 'valueSubquery') {
      walk(e.ret, inner);
    }
  };

  // A CASE expression's operands: subject (simple CASE), every WHEN/THEN, and
  // ELSE. Extracted from `walk` to keep that switch under the complexity budget.
  const walkCase = (e: Extract<Expr, { kind: 'case' }>, bound: ReadonlySet<string>): void => {
    if (e.subject) {
      walk(e.subject, bound);
    }

    for (const w of e.whens) {
      walk(w.when, bound);
      walk(w.then, bound);
    }

    if (e.elseExpr) {
      walk(e.elseExpr, bound);
    }
  };

  // `LET x = e, … IN body END`: each binding may reference outer vars and prior
  // LET locals; the local it introduces then shadows for later bindings and the
  // body. Extracted from `walk` to keep that switch under the complexity budget.
  const walkLetIn = (e: Extract<Expr, { kind: 'letIn' }>, bound: ReadonlySet<string>): void => {
    const inner = new Set(bound);

    for (const b of e.bindings) {
      walk(b.expr, inner);
      inner.add(b.var);
    }

    walk(e.body, inner);
  };

  const walkAll = (exprs: Iterable<Expr>, bound: ReadonlySet<string>): void => {
    for (const x of exprs) {
      walk(x, bound);
    }
  };

  const walk = (e: Expr, bound: ReadonlySet<string>): void => {
    switch (e.kind) {
      case 'var':
        if (!bound.has(e.name)) {
          free.add(e.name);
        }

        return;
      case 'property_exists':
      case 'prop':
        if (!bound.has(e.variable)) {
          free.add(e.variable);
        }

        return;
      case 'lit':
      case 'param':
        return;
      case 'index':
        walk(e.base, bound);
        walk(e.index, bound);

        return;
      case 'field':
        walk(e.base, bound);

        return;
      case 'neg':
      case 'not':
      case 'isNull':
      case 'isTruth':
      case 'isLabeled':
      case 'isTyped':
        walk(e.expr, bound);

        return;
      case 'compare':
        walk(e.left, bound);
        walk(e.right, bound);

        return;
      case 'arith':
        walk(e.head, bound);

        for (const [, el] of e.tail) {
          walk(el, bound);
        }

        return;
      case 'list':
      case 'concat':
      case 'and':
      case 'or':
      case 'xor':
        walkAll(e.items, bound);

        return;
      case 'in':
        walk(e.expr, bound);
        walk(e.list, bound);

        return;
      case 'record':
        walkAll(
          e.fields.map((f) => f.value),
          bound,
        );

        return;
      case 'case':
        walkCase(e, bound);

        return;
      case 'func':
      case 'graphPred':
        walkAll(e.args, bound);

        return;
      case 'exists':
      case 'countSubquery':
      case 'valueSubquery':
        walkSubquery(e, bound);

        return;
      case 'letIn':
        walkLetIn(e, bound);

        return;
      default: {
        // Exhaustiveness, and it is load-bearing rather than tidiness. Callers
        // use this set in BOTH directions: the count shortcut REJECTS a predicate
        // naming an unknown variable (safe if the set over-reports) and ELIDES a
        // binding for a slot the predicate never mentions (safe only if it does
        // not UNDER-report). A new `Expr` kind that nobody added a case for would
        // report no free variables for its operands and silently break the second
        // use. This turns that into a compile error.
        const unhandled: never = e;

        throw new Error(`freePredicateVars: unhandled expression ${JSON.stringify(unhandled)}`);
      }
    }
  };

  walk(expr, new Set());

  return free;
};

// --- value / ordering helpers ------------------------------------------------

/** Derive a column name for a RETURN item that has no explicit `AS` alias. */
export const columnName = (expr: Expr): string => {
  switch (expr.kind) {
    case 'var':
      return expr.name;
    case 'prop':
      return `${expr.variable}.${expr.key}`;
    case 'property_exists':
      return `property_exists(${expr.variable}, ${expr.key})`;
    default:
      return 'expr';
  }
};

/** A coarse type ordering so ORDER BY/min/max have a *total* order across types. */
const typeRank = (v: unknown): number => {
  switch (typeof v) {
    case 'number':
      return 0;
    case 'string':
      return 1;
    case 'boolean':
      return 2;
    default:
      // Num < Str < Bool < Temporal < List < Record < Map < Null — the SAME cross-type
      // total order as the native engine's `Value::rank`, so `list_sort`/ORDER BY/min/max
      // over a mixed-compound column agree (e.g. a list sorts before a map).
      if (isTemporal(v)) {
        return 3;
      }

      if (Array.isArray(v)) {
        return 4;
      }

      return v instanceof LenkeRecord ? 5 : 6; // Record, then Map / plain object
  }
};

/**
 * Compare two values for ORDER BY; nulls sort last. Values of different types
 * are ordered by a fixed type rank first (number < string < boolean < other),
 * so a column mixing types has a deterministic total order rather than the
 * unstable result of raw JS `<` across types.
 */
const compareValues = (a: unknown, b: unknown): number => {
  if (isNullish(a) && isNullish(b)) {
    return 0;
  }

  if (isNullish(a)) {
    return 1;
  }

  if (isNullish(b)) {
    return -1;
  }

  const ra = typeRank(a);
  const rb = typeRank(b);

  if (ra !== rb) {
    return ra < rb ? -1 : 1;
  }

  // Temporals (same rank) compare by the deterministic total order (date/datetime
  // chronological, duration lexicographic) — mirrors the Rust `cmp_total`.
  if (isTemporal(a) && isTemporal(b)) {
    return temporalCmpTotal(a, b);
  }

  // Lists compare element-wise (lexicographic, shorter-is-less on a prefix),
  // recursing through the same order — mirrors the Rust `cmp_total`. Without this
  // they'd fall to `x < y`, which coerces arrays to strings (`[10] < [9]`), so
  // `min`/`max` and `ORDER BY` over lists would diverge from the native engine.
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);

    for (let i = 0; i < n; i++) {
      const c = compareValues(a[i], b[i]);

      if (c !== 0) {
        return c;
      }
    }

    if (a.length < b.length) {
      return -1;
    }

    return a.length > b.length ? 1 : 0;
  }

  // Records: keys are canonical (sorted), so compare field-by-field (key then
  // value), shorter-is-less — a total order for ORDER BY/DISTINCT even though ISO
  // defines no relational `<`/`>` on records. Mirrors the Rust `cmp_total`.
  if (a instanceof LenkeRecord && b instanceof LenkeRecord) {
    const ae = [...a];
    const be = [...b];
    const n = Math.min(ae.length, be.length);

    for (let i = 0; i < n; i++) {
      const kc = cmpKey(ae[i][0], be[i][0]);

      if (kc !== 0) {
        return kc;
      }

      const vc = compareValues(ae[i][1], be[i][1]);

      if (vc !== 0) {
        return vc;
      }
    }

    if (ae.length < be.length) {
      return -1;
    }

    return ae.length > be.length ? 1 : 0;
  }

  // Rank 4 is the catch-all group (graph elements, plus any list/record pair the
  // branches above did not match — a list vs a record). The native `cmp_total`
  // returns Equal for all of those, leaving them in stable order. Falling through
  // to `<` would order them by their JS string coercions ("1,2" vs "[object Map]"),
  // an accidental order the native engine does not have.
  if (ra === 4) {
    return 0;
  }

  const x = a as number | string;
  const y = b as number | string;

  // Strings compare by Unicode code point (matching Rust str::cmp), not JS's
  // UTF-16 code-unit order — see compareCodePoints.
  if (typeof x === 'string' && typeof y === 'string') {
    return compareCodePoints(x, y);
  }

  // NaN is the GREATEST value and equals itself. Not an absolute-last like null:
  // it is an ordinary member of the total order sitting at the top, so DESC puts
  // it first and `max()` keeps it — Java's `Double.compareTo` and SQL's float
  // order. Mirrors the Rust `cmp_total`.
  //
  // Without this, both `x < y` and `x > y` are false and the fallthrough returns
  // 0, making the comparator NON-total. We own the comparator but not the sort
  // ALGORITHM (V8 `Array.sort` is not Rust's `slice::sort_by`), so that let the
  // algorithm leak: `RETURN sqrt(n.m) AS v ORDER BY v DESC` returned
  // `null, 3, 2, null` here against `NaN, 2, NaN, 3` in native, for the same
  // input. Every other type in this function already commits to a total order;
  // numbers were the one that fell through.
  //
  // Reachable through a projection (`sqrt(-1)`), not through storage: a stored
  // non-finite is coerced to null at the write.
  if (typeof x === 'number' && typeof y === 'number') {
    const xNaN = Number.isNaN(x);
    const yNaN = Number.isNaN(y);

    if (xNaN || yNaN) {
      if (xNaN && yNaN) {
        return 0;
      }

      return xNaN ? 1 : -1;
    }
  }

  if (x < y) {
    return -1;
  }

  return x > y ? 1 : 0;
};

/**
 * Compare two ORDER BY keys, honoring direction and ISO `NULLS FIRST/LAST`. Null
 * placement is absolute (first or last in the final order), independent of the
 * direction applied to non-null values. With no explicit null ordering, nulls
 * sort LAST (ISO GQL leaves the default unspecified, so we pin one for
 * cross-engine determinism — the Rust `compare_sort` matches).
 */
export const compareSort = (
  a: unknown,
  b: unknown,
  descending: boolean,
  nullsFirst: boolean | undefined,
): number => {
  const aNull = isNullish(a);
  const bNull = isNullish(b);

  if (aNull && bNull) {
    return 0;
  }

  if (aNull || bNull) {
    const first = nullsFirst ?? false;

    return aNull === first ? -1 : 1;
  }

  return compareValues(a, b) * (descending ? -1 : 1);
};

// The replacer used only for nested containers (below): `JSON.stringify` maps
// NaN/±Infinity all to `null`, collapsing them with each other AND with real null —
// a byte-identity break vs the Rust `val_key`, which keys numbers by bit pattern
// (so `[NaN]`, `[Infinity]`, `[null]` are three groups). This tags non-finite
// numbers as bare `#…` tokens and prefixes every string with `$`, keeping the two
// key-spaces disjoint at any depth — a real string `"#Infinity"` (→ `"$#Infinity"`)
// can never collide with the number `Infinity` (→ `"#Infinity"`).
const keyReplacer = (_k: string, val: unknown): unknown => {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : `#${val}`;
  }

  return typeof val === 'string' ? `$${val}` : val;
};

/**
 * Stable distinct/group key for a projected value, partitioning exactly as the
 * Rust `val_key`. Primitives and graph elements are keyed inline (the common
 * DISTINCT/GROUP BY case — no `JSON.stringify`, so it's off the hot path); only a
 * nested container (list/record/temporal/path — rare as a group key) pays the
 * `JSON.stringify` + `keyReplacer` cost, which is what makes nested non-finite safe.
 * Type-tag prefixes (`n`/`s`/`b`/`@`/`#`/`N`) keep the primitive key-spaces disjoint
 * from each other and from container JSON (which starts with `{`/`[`).
 */
export const valueKey = (v: unknown): string => {
  switch (typeof v) {
    case 'number':
      if (!Number.isFinite(v)) {
        return `#${v}`;
      }

      // `-0` and `0` are ONE group: `-0 = 0` is true, and the distinction is
      // normalized everywhere else (ORDER BY, sign(), the result JSON, the
      // property index), so keeping them apart here alone produced two groups
      // that both rendered as `0`. `String(-0)` is already "0", so the plain
      // template does it — mirrors the Rust `group_num_bits`.
      return `n${v}`;
    case 'string':
      return `s${v}`;
    case 'boolean':
      return v ? 'bT' : 'bF';
    case 'object':
      if (v === null) {
        return 'N';
      }

      if ('id' in v) {
        return `@${String(v.id)}`;
      }

      // Lists are native arrays (the common container key): recurse through the
      // inline keyer — no JSON.stringify, and nested non-finite is handled by the
      // element's own `#…` tag. `[` can't collide with a record's `{` (below) or
      // any primitive prefix. A manual loop (no `.map` intermediate) keeps this on
      // the hot path for large DISTINCT/GROUP BY over projected tuples.
      if (Array.isArray(v)) {
        let key = '[';

        for (const item of v) {
          key += `${valueKey(item)},`;
        }

        return `${key}]`;
      }

      // A record recurses through this keyer (like a list above), NOT through
      // JSON.stringify: stringify renders -0 as `0`, so `{b: -0}` and `{b: 0}`
      // collapsed into one DISTINCT group here while the native `value_key` —
      // which recurses and keys numbers by bit pattern — kept them apart. Mirrors
      // the Rust `Value::Map` arm's `{k=<key>,…}` shape.
      if (v instanceof LenkeRecord) {
        let key = '{';

        for (const [name, field] of v) {
          key += `${name}=${valueKey(field)},`;
        }

        return `${key}}`;
      }

      // Temporal / path — rarer as a group key, and neither has a -0 to lose;
      // JSON.stringify + the replacer keeps their nested non-finite safe.
      return JSON.stringify(v, keyReplacer) ?? 'undefined';
    default:
      // undefined / bigint / symbol are outside the value model; a stable fallback.
      return `j${String(v)}`;
  }
};
const rowKey = (b: Binding): string => [...b].map(([k, v]) => `${k}=${valueKey(v)}`).join('');

/** Keep the first occurrence of each distinct value, keyed structurally by
 *  `valueKey` (so value-equal temporals/lists/records collapse) — the DISTINCT
 *  aggregate dedup, matching the Rust engine's `val_key` / dense-id partition. */
const distinctByValueKey = (values: readonly unknown[]): unknown[] => {
  const seen = new Set<string>();
  const out: unknown[] = [];

  for (const v of values) {
    const k = valueKey(v);

    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }

  return out;
};

// --- projection compilation --------------------------------------------------

/** A projected output column: its name and the closure producing its value. */
export type CReturnItem = { name: string; fn: CompiledExpr; isAgg: boolean };
type CSortItem = { fn: CompiledExpr; descending: boolean; nullsFirst?: boolean };

/**
 * A compiled projection body (shared by `RETURN` and `WITH`). All the structural
 * analysis — alias resolution, aggregate detection, picking the GROUP BY keys —
 * is done here, once.
 */
export type CProjection = {
  star: boolean;
  distinct: boolean;
  items: readonly CReturnItem[];
  /** True when any non-`*` item aggregates → implicit grouping kicks in. */
  aggregating: boolean;
  /** Every aggregate is `count(*)`, so a group needs a COUNT and a representative — not its
   *  bindings. See `compileProjection`; the saving is O(rows) → O(groups). */
  countedGroups: boolean;
  /**
   * Every aggregate in the projection is a pure LEFT FOLD (`foldFor`), so a group needs an
   * ACCUMULATOR per aggregate plus a representative — not its bindings. The saving is the
   * same O(rows) -> O(groups) as `countedGroups`, extended past `count(*)` (item 377).
   * `undefined` when any aggregate must see the whole group.
   */
  foldedAggs?: readonly {
    readonly expr: object;
    readonly fold: AggFold;
    readonly argFn: CompiledExpr;
  }[];
  /** The non-aggregate item closures, used to build each group's key. */
  groupKeys: readonly CompiledExpr[];
  /**
   * The variable each EXPLICIT `GROUP BY` element references, for the bare-name
   * and `n.key` spellings — checked against the binding before grouping.
   *
   * ISO GQL's `groupingElement` is a `bindingVariableReference`, so the name has
   * to be bound already. An unbound one reads as null here, which keys every row
   * the same and silently returns ONE group holding the first row's values.
   * There is no compile-time scope in this engine, so the binding — which IS the
   * scope — is what we check, once, rather than per row.
   */
  groupKeyNames: readonly string[];
  /**
   * Can NO item in this projection RAISE? Only three expression shapes qualify — a bare variable
   * reference, a single-level property read (`a.k`, which yields null for an absent key) and a
   * literal — plus `RETURN *`, which copies binding entries. Everything else is assumed to
   * fault: `CAST` does, arithmetic over a non-number does, a cross-type temporal comparison
   * does, a function or subquery may.
   *
   * It exists for ONE caller: paging an unordered stream may skip BINDINGS instead of projecting
   * every row and paging the results, but only where the projection it is skipping could not
   * have raised. Item 426 measured that `RETURN a.u AS s SKIP 199995 LIMIT 5` projects all
   * 200,000 rows to return five (48.8-51.3 ms, against 35.5 for the same query WITH an
   * `ORDER BY`, whose top-k already projects only survivors) — and established that skipping
   * unconditionally is a BEHAVIOUR change, because both engines currently fault on a skipped
   * row's `CAST`. Gating on this keeps the faulting shapes byte-identical with native and takes
   * the win only where there is nothing to observe.
   */
  cannotFault: boolean;
  /** ISO HAVING — a post-aggregation predicate on each group (SELECT only). */
  having?: CompiledExpr;
  orderBy: readonly CSortItem[];
  /**
   * True when any ORDER BY key references an OUTPUT column. When false the sort
   * keys come from the input binding alone, so `ORDER BY … LIMIT n` can keep only
   * the top-k *input* bindings and project just those (see `applyProjection`).
   * Mirrors the Rust `CProjection::order_needs_output`, which asks the same
   * question as a slot test (`refs_slot_below(expr, out_len)`) — output slots come
   * first in the ORDER BY scope, so a name that is both an alias and an input
   * variable resolves to the OUTPUT column in both engines.
   */
  orderNeedsOutput: boolean;
  skip?: CountValue;
  limit?: CountValue;
};

// Register a LIMIT/OFFSET bound param so it is both bound-checked (MissingParameter)
// and value-checked (non-negative integer) up-front, exactly like the Rust plan.
const noteCountParam = (v: CountValue | undefined): void => {
  if (v !== undefined && typeof v === 'object') {
    paramCollector?.add(v.param);
    countParamCollector?.add(v.param);
  }
};

/**
 * `ORDER BY <alias>` rewritten as the expression the alias names — or
 * `undefined` when the alias is not a plain column of an input variable.
 *
 * `ORDER BY a` IS `ORDER BY n.age` when the projection says `n.age AS a`, and it
 * must not be a different plan. Left alone it read an OUTPUT column, which
 * forces `orderNeedsOutput` and gives up the top-k — so the alias spelling both
 * ran slower (measured 1.8x in the Rust engine over 20k rows) and, with a LIMIT,
 * projected every row where its twin projected only the emitted ones. That
 * second difference was observable: a faulting projection threw for one spelling
 * and not the other.
 *
 * Only the DIRECT column shapes are substituted, and never across a shadowed
 * name — if the item's variable is itself an output name, the sort scope
 * resolves that name to the output column and there is nothing to rewrite to.
 * Mirrors the Rust `alias_definition`.
 */
const aliasDefinition = (
  sortExpr: Expr,
  projection: Projection,
  outNames: ReadonlySet<string>,
): Expr | undefined => {
  if (sortExpr.kind !== 'var' || projection.star) {
    return undefined;
  }

  const item = projection.items.find((i) => (i.alias ?? columnName(i.expr)) === sortExpr.name);

  // An aggregate is defined over the GROUP, not over any one input row.
  //
  // DEFENSIVE, not load-bearing, and mutation says so: substituting an aggregate changes no answer,
  // because the sort runs AFTER aggregation, so `count(*)` as a sort key still folds over the same
  // group and gives the same number as the output column. Checked against groups of DIFFERENT sizes
  // (1, 2, 3), since equal-sized groups make the two readings agree by luck. The two guards above —
  // the `var` test and the `star` test — are equivalent for a related reason: with a non-`var` key
  // `sortExpr.name` is undefined and with `RETURN *` there are no items, so the lookup below finds
  // nothing either way. All three stay as the statement of intent (audit item 213).
  if (item === undefined || hasAggregate(item.expr)) {
    return undefined;
  }

  // ANY expression that reads only INPUT variables is substitutable, not just a direct
  // column. `n.age + 1 AS a … ORDER BY a` is the same question as `ORDER BY n.age + 1`, and
  // restricting this to `var`/`prop` left the computed case as a live CROSS-ENGINE
  // DIVERGENCE, not merely a slow spelling (audit item 145):
  //
  //     RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY a LIMIT 2
  //       ts      RAISED                     <- projected every row, so `b` faulted
  //       native  [{a:2,b:1},{a:3,b:2}]      <- projected only the two emitted rows
  //
  // while the `ORDER BY n.age + 1` spelling returns those rows in BOTH. Native is the
  // consistent one: it inlines the alias into the sort-key scope, keeps the top-k over INPUT
  // bindings, and so never projects `b` for a row it does not emit.
  //
  // A SUBQUERY cannot be substituted, and the guard below cannot see why: `freePredicateVars`
  // returns the EMPTY set for `exists` / `countSubquery` / `valueSubquery` — it does not descend
  // into one at all — so a subquery's internal variables are invisible to the shadowing test.
  //
  // Substituting one is a wrong ANSWER, not a slow plan, and it was a live cross-engine
  // divergence (audit item 213):
  //
  //     RETURN COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c
  //       ts      [2, 1]   <- unsorted
  //       native  [1, 2]
  //
  // The sort key became the subquery itself; the output is then overlaid on the binding (see
  // `orderNeedsOutput` below), which bound `c` to the COUNT VALUE, so the sub-pattern's `(c)`
  // matched a number, counted 0 for every row, and every key compared equal. The alias need only
  // collide with a variable the subquery binds — which no fuzzer generates, and which is why this
  // survived to be found by hand.
  //
  // Declining sends it to the non-substituted path, which sorts by the output column and agrees
  // with native. The cost is item 145's top-k-over-input-bindings for subquery items only.
  if (hasSubquery(item.expr)) {
    return undefined;
  }

  // Substituting is sound exactly when no free name of the expression is an OUTPUT name — a
  // shadowed name would resolve to the output column in the sort scope and mean something
  // else. The `var` and `prop` cases are subsumed: their free sets are `{name}` and
  // `{variable}`.
  //
  // It cannot change WHICH expressions are evaluated per row, only whether a row OBJECT is
  // built: the substituted expression becomes the sort key, which is evaluated for every row
  // either way. What changes is that OTHER projected items are no longer evaluated for rows
  // the top-k discards — which is precisely what native already does.
  for (const name of freePredicateVars(item.expr)) {
    if (outNames.has(name)) {
      return undefined;
    }
  }

  return item.expr;
};

/**
 * Fault on a `GROUP BY` naming something the binding does not carry.
 *
 * Unbound reads as null, which keys every row the same: the query silently
 * returned ONE group holding the first row's values instead of the grouping the
 * reader asked for. `GROUP BY zzz` did it as readily as `GROUP BY <a RETURN
 * alias>` — and the alias is the common way in, because `RETURN n.t AS t … GROUP
 * BY t` reads as if it should work. It cannot: `GROUP BY` sits INSIDE the return
 * body and groups the input bindings, while `ORDER BY` is a separate statement
 * applied after the projection, which is why an alias resolves there. The two
 * clauses differ by design.
 *
 * Mirrors the Rust `check_unbound_group_keys`, which asks the same question
 * against the lowering scope.
 */
const assertGroupKeysBound = (names: readonly string[], binding: Binding): void => {
  for (const name of names) {
    if (!binding.has(name)) {
      throw new LenkeError(
        `GROUP BY references an unbound variable: ${name}. GROUP BY groups the ` +
          `INPUT bindings, so it cannot see a RETURN alias (ORDER BY, which runs ` +
          `after the projection, can). Bind it first — \`LET ${name} = …\` or ` +
          `\`WITH … AS ${name}\` — or group by the property directly.`,
        { code: ErrorCode.UnknownFunction },
      );
    }
  }
};

const compileProjection = (projection: Projection): CProjection => {
  const items: CReturnItem[] = projection.items.map((i) => ({
    name: i.alias ?? columnName(i.expr),
    fn: compileExpr(i.expr),
    isAgg: hasAggregate(i.expr),
  }));
  noteCountParam(projection.skip);
  noteCountParam(projection.limit);
  // Explicit GROUP BY keys DRIVE grouping (and force it on, even without an
  // aggregate); absent → implicit grouping by the non-aggregate items.
  const groupByExprs = projection.groupBy ?? [];
  const having = projection.having ? filterPredicate(projection.having) : undefined;
  const aggregating =
    !projection.star &&
    (items.some((i) => i.isAgg) || groupByExprs.length > 0 || having !== undefined);
  // MAY THE GROUPS BE COUNTED RATHER THAN KEPT? `applyProjection`'s aggregating branch retains
  // every binding so the aggregate closures can map over them — which made `RETURN count(*)`
  // O(ROWS) and OOM-killed a 5-hop count under a 4 GB cap (item 296 measured it: ~640 bytes a
  // path over 6.25M paths). `count(*)` is the one aggregate that reads nothing but the group's
  // SIZE, so when every aggregate in the projection is `count(*)` the bindings are dead weight
  // and a counter plus one representative suffices — O(GROUPS).
  //
  // `having` is excluded rather than analysed: it receives the group too and may do anything
  // with it, and keeping the guarantee local is worth more than covering `HAVING count(*) > n`.
  const countedGroups =
    aggregating &&
    having === undefined &&
    projection.items.every((i) => everyAggregateIsCountStar(i.expr)) &&
    (projection.orderBy ?? []).every((o) => everyAggregateIsCountStar(o.expr));
  // MAY THE GROUPS BE FOLDED rather than kept? The same question `countedGroups` asks, for
  // the aggregates that are left folds. Admission is deliberately narrow:
  //   - every aggregate in every projection item AND every ORDER BY key must be foldable,
  //     because one that is not would reach for bindings that were never kept;
  //   - `having` is excluded exactly as it is for counted groups — it receives the group and
  //     may do anything with it;
  //   - `countedGroups` wins when it applies, since a counter is cheaper than an accumulator.
  // The argument expression is compiled HERE, once, and the aggregate's AST node identifies
  // the slot — the same node the closure in `compileAggregate` looks itself up by.
  const foldableOf = (
    expr: Expr,
  ): { expr: object; fold: AggFold; argFn: CompiledExpr }[] | undefined => {
    const out: { expr: object; fold: AggFold; argFn: CompiledExpr }[] = [];

    for (const a of collectAggregates(expr)) {
      const fold = foldFor(a.name, a.star, a.distinct);
      const [arg] = a.args;

      if (fold === undefined || arg === undefined) {
        return undefined;
      }

      out.push({ expr: a, fold, argFn: compileExpr(arg) });
    }

    return out;
  };
  const foldedAggs = (():
    | typeof undefined
    | { expr: object; fold: AggFold; argFn: CompiledExpr }[] => {
    if (!aggregating || countedGroups || having !== undefined) {
      return undefined;
    }

    const all: { expr: object; fold: AggFold; argFn: CompiledExpr }[] = [];

    for (const e of [
      ...projection.items.map((i) => i.expr),
      ...(projection.orderBy ?? []).map((o) => o.expr),
    ]) {
      const part = foldableOf(e);

      if (part === undefined) {
        return undefined;
      }

      all.push(...part);
    }

    // No aggregates at all means plain grouping — nothing to fold, so keep the normal path.
    return all.length > 0 ? all : undefined;
  })();
  // See `CProjection.cannotFault`. The allowlist is deliberately tiny and STRUCTURAL — a
  // shape is fault-free because of what it is, not because of an analysis of what it contains,
  // so a new `Expr` arm cannot be admitted by accident.
  const cannotFault =
    projection.star ||
    (projection.items.length > 0 &&
      projection.items.every(
        (i) => i.expr.kind === 'var' || i.expr.kind === 'prop' || i.expr.kind === 'lit',
      ));
  const groupKeys =
    groupByExprs.length > 0
      ? groupByExprs.map((e) => compileExpr(e))
      : items.filter((i) => !i.isAgg).map((i) => i.fn);
  // Only the shapes ISO allows (a bare name) plus the property spelling we accept
  // on top of it. A grouping key built from a larger expression is outside the
  // grammar and is not checked.
  const groupKeyNames = groupByExprs
    .map((e) => {
      if (e.kind === 'var') {
        return e.name;
      }

      return e.kind === 'prop' ? e.variable : undefined;
    })
    .filter((n): n is string => n !== undefined);
  // ORDER BY keys are evaluated against the projected output overlaid on the
  // input binding (see `applyProjection`), so output aliases resolve even inside
  // an expression — `ORDER BY n + 2` uses the column `n`, not the input variable.
  const outNames = new Set(items.map((i) => i.name));
  const sortKeys = (projection.orderBy ?? []).map((s) => ({
    ...s,
    expr: aliasDefinition(s.expr, projection, outNames) ?? s.expr,
  }));
  const orderBy: CSortItem[] = sortKeys.map((s) => ({
    fn: compileExpr(s.expr),
    descending: s.descending,
    nullsFirst: s.nullsFirst,
  }));
  // Does a sort key read an output column? With `RETURN *` every in-scope
  // variable IS carried to the output, so any variable reference counts.
  // Asked of the REWRITTEN keys: `ORDER BY a` where `a` is `n.age` reads no
  // output column once it is spelled `ORDER BY n.age`, which is the point.
  const orderNeedsOutput = sortKeys.some((s) => {
    const refs = freePredicateVars(s.expr);

    return projection.star ? refs.size > 0 : [...refs].some((n) => outNames.has(n));
  });

  return {
    star: projection.star,
    distinct: projection.distinct,
    items,
    aggregating,
    countedGroups,
    ...(foldedAggs ? { foldedAggs } : {}),
    cannotFault,
    groupKeys,
    groupKeyNames,
    ...(having ? { having } : {}),
    orderBy,
    orderNeedsOutput,
    skip: projection.skip,
    limit: projection.limit,
  };
};

/** Build the output binding for one input binding (or aggregate group). */
const projectBinding = (
  proj: CProjection,
  binding: Binding,
  params: Params,
  graph: Graph,
  group?: readonly Binding[],
): Binding => {
  if (proj.star) {
    return new Map(binding);
  }

  const env: EvalEnv = { binding, params, graph, group };
  const out = new Map<string, unknown>();

  for (const item of proj.items) {
    out.set(item.name, item.fn(env));
  }

  return out;
};

/**
 * `projectBinding`'s twin, writing the output ROW directly.
 *
 * The no-sort path built a projected `Map` and then had `mapToRow` copy it into a
 * plain object — two allocations and two iterations per row where one of each will
 * do. Nothing downstream of that path wants the `Map` form: it exists for the
 * ORDER BY overlay and for DISTINCT's row keys, and neither is present here.
 *
 * BYTE-IDENTITY. Column order is the output's observable shape, and it is
 * unchanged: `mapToRow` walks the `Map` in insertion order, which is
 * `proj.items` order (or the input binding's, under `*`), and this writes the
 * same keys in the same order. A repeated column name keeps its first position
 * in both a `Map` and an object, and `item.fn` is called in the same order, so a
 * projection that throws throws on the same row at the same point.
 */
export const projectRow = (
  proj: CProjection,
  binding: Binding,
  params: Params,
  graph: Graph,
): Row => {
  const row: Row = {};

  if (proj.star) {
    for (const [k, v] of binding) {
      row[k] = v;
    }

    return row;
  }

  const env: EvalEnv = { binding, params, graph };

  for (const item of proj.items) {
    row[item.name] = item.fn(env);
  }

  return row;
};

/**
 * `Row`s for the shape that needs no sort, no dedup and no paging — the same
 * five conditions `applyProjection` fast-paths (item 113). `undefined` means
 * "not this shape", and the caller falls back to the general
 * `map(mapToRow, applyProjection(…))`.
 *
 * Lazy, like the path it replaces: a row is projected when it is pulled.
 */
export const projectedRows = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Row[] => {
  if (
    proj.aggregating ||
    proj.orderBy.length > 0 ||
    proj.distinct ||
    resolveCount(proj.skip, params) !== undefined ||
    resolveCount(proj.limit, params) !== undefined
  ) {
    return toArray(map(mapToRow, applyProjection(proj, bindings, params, graph)));
  }

  return toArray(map((b: Binding) => projectRow(proj, b, params, graph), bindings));
};

/**
 * The `cap` rows that sort first under `cmp`, in sorted order — an O(n log cap)
 * bounded selection instead of sorting all n rows to keep a small prefix. Streams
 * its input (only `cap` rows are ever held). Ties break by original stream
 * position, so the result is byte-identical to a *stable* full sort + `slice(0,
 * cap)`. Used for `ORDER BY … LIMIT k`.
 */
/**
 * REJECTED, with its numbers (audit item 424): replacing the `{ v, i }` wrapper below with two
 * PARALLEL ARRAYS (`vals`/`idxs`, swapped together, plus a `lessThanRoot` that compares a
 * candidate against the root without building an entry for it) measured **50.1 -> 48.9 ms, 2.4%**,
 * five alternated rounds at nine reps each, 200,000 rows answering `ORDER BY u LIMIT 5`.
 *
 * The wrapper is allocated for EVERY input row, including the overwhelming majority immediately
 * rejected — it is built before the `less(e, heap[0])` test that throws it away — so 200,000
 * objects are allocated to keep five. That is the same per-row allocation item 113 removed from
 * the pass-through projection path, and it bought 2%: V8's young-generation bump allocation is
 * near-free, and the extra array indirection costs back most of what removing it saves. Under the
 * repo's 10% floor, so not taken.
 *
 * The corollary is worth more than the change would have been: **"it allocates per row" is not by
 * itself a cost in this engine.** Two further allocations per row sit on the top-k call site in
 * `applyProjection` (the `{ b, keys }` wrapper and the `orderBy.map` key array), and the same
 * arithmetic prices removing both at roughly 5% — also under the floor. The measured gap on that
 * shape is 50.1 ms against the `max(a.u)` fold's 20.7 over the same rows, and it is NOT allocation.
 *
 * Also, do not measure this shape at three reps: both sides are bimodal at ~50 ms and ~90-95 ms,
 * so min-of-3 picks a mode rather than a cost (the first A/B read 58.0 -> 86.1 and the second
 * 95.0 -> 50.7, from the same two builds). Nine reps settles it, which is what
 * `ts-spelling-probe` already says about this engine.
 */
const boundedTopK = <T>(rows: Iterable<T>, cap: number, cmp: (a: T, b: T) => number): T[] => {
  if (cap <= 0) {
    return [];
  }

  type E = { v: T; i: number };
  const heap: E[] = []; // max-heap by `less`: the root is the worst (largest) kept
  const less = (a: E, b: E): boolean => {
    const c = cmp(a.v, b.v);

    return c !== 0 ? c < 0 : a.i < b.i; // index tiebreak reproduces stable order
  };
  const swap = (x: number, y: number) => {
    const t = heap[x];
    heap[x] = heap[y];
    heap[y] = t;
  };
  const up = (start: number) => {
    let i = start;

    while (i > 0) {
      const p = (i - 1) >> 1;

      if (!less(heap[p], heap[i])) {
        break; // parent already >= child
      }

      swap(i, p);
      i = p;
    }
  };
  const down = (start: number) => {
    let i = start;

    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;

      if (l < heap.length && less(heap[m], heap[l])) {
        m = l;
      }

      if (r < heap.length && less(heap[m], heap[r])) {
        m = r;
      }

      if (m === i) {
        break;
      }

      swap(i, m);
      i = m;
    }
  };

  let idx = 0;

  for (const v of rows) {
    const e = { v, i: idx };
    idx += 1;

    if (heap.length < cap) {
      heap.push(e);
      up(heap.length - 1);
    } else if (less(e, heap[0])) {
      heap[0] = e; // better than the worst kept — evict the root
      down(0);
    }
  }

  heap.sort((a, b) => {
    if (less(a, b)) {
      return -1;
    }

    return less(b, a) ? 1 : 0;
  });

  return heap.map((e) => e.v);
};

/**
 * Paging an UNORDERED stream whose projection cannot raise: skip the BINDINGS, then project only
 * the page. `null` when the shape does not fit, so the caller falls through.
 *
 * `applyProjection`'s generic tail projects every row and pages the PROJECTED ones, which item
 * 426 measured at 48.8-51.3 ms for `RETURN a.u AS s SKIP 199995 LIMIT 5` over 200,000 nodes —
 * MORE than the 35.5 the same query costs WITH an `ORDER BY`, whose top-k already projects only
 * survivors. Adding an `ORDER BY` making a query faster is the spelling asymmetry this repo is
 * named after. This closes it at 1.96-2.09x, landing on the 25.6 ms general-stream floor item 426
 * measured with a constant sort key.
 *
 * `proj.cannotFault` is what keeps this byte-identical rather than a behaviour change: both
 * engines currently DO fault on a skipped row's `CAST` (`skipcast_426` is the evidence, checked
 * natively), and that is a conformance question against the engine's own "project exactly the
 * rows you emit" rule, not something an optimization pass settles. Where the projection could not
 * have raised there is nothing to observe, so the rows and their order are unchanged and native
 * agrees by construction.
 *
 * EXTRACTED from `applyProjection` rather than written inline, because the complexity cap
 * objected at 38 against a limit of 35 — the same cap that was right to object at item 377, and
 * the same answer: the branch's six conditions become one call. The HOT loop is still one loop
 * over `bindings`, and this is called once per query, so neither of item 159's effects applies.
 *
 * Only a positive SKIP. `limitBound` alone already short-circuits through `take` without
 * projecting the tail, and `skipBound === 0` is the pass-through in the caller.
 *
 * The `!proj.aggregating` guard is REDUNDANT and kept, which mutation established rather than my
 * reading it: every aggregate is an `Expr` of kind `func`, which the `cannotFault` allowlist
 * already refuses, so an aggregating projection can never reach here. Dropping the guard leaves
 * all 12 tests green. It stays because the implication runs through `compileProjection`'s
 * allowlist rather than anything local, and a future allowlist entry would otherwise silently
 * admit a shape with no per-input row to page.
 */
const pagedFaultFreeRows = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
  skipBound: number | undefined,
  limitBound: number | undefined,
): Iterable<Binding> | null => {
  if (
    proj.aggregating ||
    proj.orderBy.length > 0 ||
    proj.distinct ||
    skipBound === undefined ||
    skipBound <= 0 ||
    !proj.cannotFault
  ) {
    return null;
  }

  const afterSkip = skip(skipBound, bindings);

  return map(
    (b: Binding) => projectBinding(proj, b, params, graph),
    limitBound === undefined ? afterSkip : take(limitBound, afterSkip),
  );
};

/**
 * Apply a projection (`RETURN` or `WITH` body) to a set of bindings: implicit
 * grouping/aggregation, then DISTINCT, ORDER BY, SKIP, LIMIT. Returns the
 * projected bindings — `RETURN` turns these into rows, `WITH` feeds them on.
 */
/** A counted group mid-accumulation: its size, and the first binding seen (the representative
 *  the rest of the projection reads as `group[0]`). */
type CountedGroup = { rep: Binding; n: number };

/**
 * A `Binding[]` stand-in that knows its LENGTH and holds ONE binding.
 *
 * `count(*)` compiles to `group.length` and nothing else, so when every aggregate in a
 * projection is `count(*)` the other `n - 1` bindings are never read and retaining them is what
 * made an aggregating projection O(rows) (item 296: a 5-hop `count(*)` OOM-killed under a 4 GB
 * cap, ~640 bytes a path). This gives the group its size without them.
 *
 * IT IS A LIE, SO IT IS A LOUD ONE. The array is length-1 with the real `length` reported on
 * top, which means an index past 0 would silently read `undefined` — a wrong answer of exactly
 * the kind this engine is least able to detect. The Proxy turns any numeric read past the
 * representative into a thrown error instead, so if a future aggregate reaches for the bindings
 * the failure names the cause rather than returning a plausible number. It is built once per
 * GROUP, never per row, so the Proxy costs nothing that matters.
 *
 * `compileProjection`'s `countedGroups` is what guarantees only `.length` and `[0]` are read;
 * this is the backstop for that guarantee, not a substitute for it.
 */
/**
 * Folded aggregate values ride on the group VIEW under this symbol rather than through a new
 * parameter on `projectBinding`/`Env`. `countedGroupView` already established that the group
 * handed to the aggregates may be a stand-in; this carries the one extra thing a folded group
 * needs, and keeps the change local to the two places that know about streaming.
 */
const FOLDED = Symbol('lenke.foldedAggregates');

/** A group whose foldable aggregates are already computed: size, representative, values. */
const foldedGroupView = (
  rep: Binding,
  n: number,
  folded: ReadonlyMap<object, { readonly v: unknown }>,
): Binding[] =>
  new Proxy<Binding[]>([rep], {
    get(target, prop, recv) {
      if (prop === FOLDED) {
        return folded;
      }

      if (prop === 'length') {
        return n;
      }

      if (typeof prop === 'string' && /^\d+$/.test(prop) && Number(prop) > 0) {
        throw new LenkeError(
          `lenke: a folded group of ${n} was indexed at ${prop}; an aggregate that needs every ` +
            'binding must not be admitted to the streaming path (see `foldFor`)',
          { code: ErrorCode.Unsupported },
        );
      }

      return Reflect.get(target, prop, recv) as unknown;
    },
  });

const countedGroupView = (rep: Binding, n: number): Binding[] =>
  new Proxy<Binding[]>([rep], {
    get(target, prop, recv) {
      if (prop === 'length') {
        return n;
      }

      if (typeof prop === 'string' && /^\d+$/.test(prop) && Number(prop) > 0) {
        throw new LenkeError(
          `lenke: a counted group of ${n} was indexed at ${prop}; only count(*) may stream a ` +
            'group, so this aggregate needs the bindings retained (see `countedGroups`)',
          { code: ErrorCode.Unsupported },
        );
      }

      return Reflect.get(target, prop, recv) as unknown;
    },
  });

/** One bucket of a folded grouping: a representative, a row count, one accumulator each. */
type FoldedBucket = { rep: Binding; n: number; accs: unknown[] };

type FoldedAgg = { readonly expr: object; readonly fold: AggFold; readonly argFn: CompiledExpr };

/**
 * Step one binding into its group's accumulators and DISCARD it. Lifted out of
 * `applyProjection` because the complexity cap was right: the grouping loop already carries
 * three bucket shapes, and this one has a loop of its own.
 */
const stepFolded = (
  folds: Map<string, FoldedBucket>,
  key: string,
  b: Binding,
  foldedAggs: readonly FoldedAgg[],
  params: Params,
  graph: Graph,
): void => {
  let seen = folds.get(key);

  if (seen === undefined) {
    seen = { rep: b, n: 0, accs: foldedAggs.map((a) => a.fold.init()) };
    folds.set(key, seen);
  }

  seen.n += 1;

  for (const [i, a] of foldedAggs.entries()) {
    const v = a.argFn({ binding: b, params, graph });

    // The array path folds over `nonNull` (and would then apply DISTINCT, which is why
    // `foldFor` refuses it), so the streaming step must skip nullish the SAME way — this is
    // the one place the two paths could disagree, and the DISTINCT differential pins it.
    if (!isNullish(v)) {
      seen.accs[i] = a.fold.step(seen.accs[i], v);
    }
  }
};

/** Finish a folded bucket into the group view the rest of `applyProjection` understands. */
const finishFolded = (
  { rep, n, accs }: FoldedBucket,
  foldedAggs: readonly FoldedAgg[],
): Binding[] => {
  const done = new Map<object, { readonly v: unknown }>();

  for (const [i, a] of foldedAggs.entries()) {
    done.set(a.expr, { v: a.fold.finish(accs[i]) });
  }

  return foldedGroupView(rep, n, done);
};

/**
 * Build the group buckets for an aggregating projection. Extracted from `applyProjection`
 * because the complexity cap was right to object (item 377): this is now THREE bucket shapes
 * — kept bindings, counted groups (item 297) and folded accumulators — and the choice between
 * them, which is more than one function should hold alongside ordering, DISTINCT and paging.
 */
const buildGroups = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Map<string, Binding[]> => {
  const groups = new Map<string, Binding[]>();
  // ONE grouping key is the overwhelmingly common shape, and for it the row key IS the
  // value key: `valueKey` is already type-prefixed and injective, so `JSON.stringify([k])`
  // is injective in exactly the same `k` that `k` itself is — the stringify, the
  // intermediate array and the `.map` closure are pure cost, paid per ROW. Several keys
  // keep the stringify, which stays injective across a boundary a plain join does not: a
  // string cell may contain whatever separator the join picks.
  const soleKey = proj.groupKeys.length === 1 ? proj.groupKeys[0] : undefined;
  // NO grouping keys at all — a scalar aggregate — means every row belongs to one group, so
  // the key is a CONSTANT. It was still being recomputed per row as
  // `JSON.stringify([].map(...))`: an array allocation and a stringify to produce `'[]'`,
  // which is the very literal the empty-group line below already uses. On 800,000 rows that
  // was the whole cost of an ungrouped aggregate — removing the retained bindings (the fix
  // this item started as) left the 1-hop timing untouched at ~534ms, because the memory and
  // the time were two different problems (item 377).
  const constKey = proj.groupKeys.length === 0 ? '[]' : undefined;

  // COUNTED groups keep a size and a representative; kept groups keep every binding. One
  // loop either way, so the grouping key is derived once and the only difference is what the
  // bucket holds.
  const counts = proj.countedGroups ? new Map<string, CountedGroup>() : undefined;
  // FOLDED groups keep one accumulator per aggregate plus a representative. Same shape as
  // `counts`, one slot wider: the bindings are stepped into the accumulators and dropped.
  const { foldedAggs } = proj;
  const folds = foldedAggs ? new Map<string, FoldedBucket>() : undefined;

  for (const b of bindings) {
    assertGroupKeysBound(proj.groupKeyNames, b);

    const key =
      constKey ??
      (soleKey
        ? valueKey(soleKey({ binding: b, params, graph }))
        : JSON.stringify(proj.groupKeys.map((fn) => valueKey(fn({ binding: b, params, graph })))));

    if (folds && foldedAggs) {
      stepFolded(folds, key, b, foldedAggs, params, graph);
      continue;
    }

    if (counts) {
      const seen = counts.get(key);

      if (seen) {
        seen.n += 1;
      } else {
        // The FIRST binding is the representative — the same one `group[0]` would have been,
        // which is what group keys and non-aggregate items read.
        counts.set(key, { rep: b, n: 1 });
      }

      continue;
    }

    const existing = groups.get(key);

    if (existing) {
      existing.push(b);
    } else {
      groups.set(key, [b]);
    }
  }

  // Replay the folded buckets the same way the counted ones are replayed: a representative
  // and a view, with the finished values attached for the aggregate closures to read.
  if (folds && foldedAggs) {
    for (const [key, bucket] of folds) {
      groups.set(key, finishFolded(bucket, foldedAggs));
    }
  }

  // Replay the counted buckets as groups the rest of this function already understands: a
  // representative plus a LENGTH-ONLY view standing in for the bindings.
  if (counts) {
    for (const [key, { rep, n }] of counts) {
      groups.set(key, countedGroupView(rep, n));
    }
  }

  if (groups.size === 0 && proj.groupKeys.length === 0) {
    groups.set('[]', []);
  }

  return groups;
};

export const applyProjection = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Iterable<Binding> => {
  const { orderBy } = proj;
  // A `$param` bound resolves here (validated up-front); a literal passes through.
  const skipBound = resolveCount(proj.skip, params);
  const limitBound = resolveCount(proj.limit, params);

  // A zero LIMIT emits no rows, so the projection never runs. The rule the engine
  // already follows for a non-zero LIMIT is "project exactly the rows you emit" —
  // `RETURN 1/(n.n - 7) AS x LIMIT 1` returns the first row rather than faulting on
  // the second, in BOTH engines. LIMIT 0 emits nothing, so it projects nothing;
  // faulting here would make LIMIT 0 the one limit that evaluates discarded rows.
  // (Not a SQL rule: ISO GQL's `<order by and page statement>` is a statement in its
  // own right that may PRECEDE the RETURN, where paging trims the binding table
  // before any projection — this is what that form yields. We implement only the
  // trailing form. Postgres is not the reference and does not agree: it
  // constant-folds `1/0` at plan time and raises even under LIMIT 0.)
  if (limitBound === 0) {
    return [];
  }

  type Keyed = { b: Binding; keys: readonly unknown[] };

  const cmp = (a: Keyed, b: Keyed): number => {
    for (let i = 0; i < orderBy.length; i += 1) {
      const c = compareSort(a.keys[i], b.keys[i], orderBy[i].descending, orderBy[i].nullsFirst);

      if (c !== 0) {
        return c;
      }
    }

    return 0;
  };

  // Top-k: `ORDER BY … LIMIT n` whose sort keys don't read the output. The keys
  // come from the input binding alone, so only the top-k INPUT bindings are kept
  // and just those are projected — the rest are never projected at all. Same five
  // conditions as the Rust `ProjAccum::new` (`topk`), so both engines project
  // exactly the same rows: a projection that would fault on a row outside the
  // top-k does not fault in either. DISTINCT is excluded because dedup keys are
  // built from the projected row, and an aggregate has no per-input row to keep.
  if (
    !proj.aggregating &&
    orderBy.length > 0 &&
    limitBound !== undefined &&
    !proj.distinct &&
    !proj.orderNeedsOutput
  ) {
    const cap = (skipBound ?? 0) + limitBound;

    // ONE sort key is the overwhelmingly common spelling, and it gets its own bounded heap
    // rather than the generic `Keyed` one. What this removes is NOT the allocations (item 424
    // measured those at 2.4% and rejected removing them): it is the `map` generator between
    // `bindings` and the heap's `for…of`, the one-element `keys` array and its index reads, and
    // the `orderBy[i].descending`/`nullsFirst` property loads that the generic `cmp` repeats on
    // every comparison. Item 424 priced the per-row machinery at 182ns against the `max(a.u)`
    // fold's 35ns over the same rows and the same comparator, which is the gap this closes.
    if (orderBy.length === 1) {
      const [{ fn, descending, nullsFirst }] = orderBy;
      // Parallel arrays, at most `cap` long: bindings, their sort keys, and the arrival index
      // the stable-order tiebreak needs.
      const bs: Binding[] = [];
      const ks: unknown[] = [];
      const ix: number[] = [];
      const lessAt = (x: number, y: number): boolean => {
        const c = compareSort(ks[x], ks[y], descending, nullsFirst);

        return c !== 0 ? c < 0 : ix[x] < ix[y];
      };
      const swapAt = (x: number, y: number) => {
        const tb = bs[x];
        bs[x] = bs[y];
        bs[y] = tb;

        const tk = ks[x];
        ks[x] = ks[y];
        ks[y] = tk;

        const ti = ix[x];
        ix[x] = ix[y];
        ix[y] = ti;
      };
      const siftUp = (from: number) => {
        let i = from;

        while (i > 0) {
          const parent = (i - 1) >> 1;

          if (!lessAt(parent, i)) {
            break;
          }

          swapAt(i, parent);
          i = parent;
        }
      };
      const siftDown = (from: number) => {
        let i = from;

        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;

          if (l < bs.length && lessAt(m, l)) {
            m = l;
          }

          if (r < bs.length && lessAt(m, r)) {
            m = r;
          }

          if (m === i) {
            break;
          }

          swapAt(i, m);
          i = m;
        }
      };
      let n = 0;

      for (const b of bindings) {
        const k = fn({ binding: b, params, graph });
        const i = n;
        n += 1;

        if (bs.length < cap) {
          bs.push(b);
          ks.push(k);
          ix.push(i);
          siftUp(bs.length - 1);
        } else {
          // Beat the worst kept? The comparison is made against the ROOT without storing the
          // candidate anywhere, which is the one place the generic heap had to build an entry.
          //
          // The index tiebreak HERE is provably redundant and kept for symmetry with `lessAt`:
          // it is consulted only when the keys tie, and a candidate always arrives after
          // everything already in the heap, so `i < ix[0]` is false exactly where `c < 0` is.
          // Mutation says so rather than my reading it — dropping it leaves all 25 tests green,
          // while dropping it from `lessAt` (where the heap array has been permuted by
          // evictions and the final sort must still recover arrival order) fails four.
          const c = compareSort(k, ks[0], descending, nullsFirst);

          if (c !== 0 ? c < 0 : i < ix[0]) {
            bs[0] = b;
            ks[0] = k;
            ix[0] = i;
            siftDown(0);
          }
        }
      }

      // Sort a PERMUTATION of the survivors, so the (binding, key, index) triple survives the
      // sort without a wrapper. Same total order as the heap used, index tiebreak included.
      const order = bs.map((_, i) => i);

      order.sort((a, b) => {
        if (lessAt(a, b)) {
          return -1;
        }

        return lessAt(b, a) ? 1 : 0;
      });

      const kept = order.slice(skipBound ?? 0, (skipBound ?? 0) + limitBound);

      return kept.map((i) => projectBinding(proj, bs[i], params, graph));
    }

    const inputKeyed = map(
      (b: Binding) => ({ b, keys: orderBy.map((s) => s.fn({ binding: b, params, graph })) }),
      bindings,
    );
    const top = boundedTopK(inputKeyed, cap, cmp);
    const afterSkip = skipBound ? skip(skipBound, top) : top;

    return map((r: Keyed) => projectBinding(proj, r.b, params, graph), take(limitBound, afterSkip));
  }

  // No ORDER BY, no DISTINCT, no paging, no aggregation: every stage below this
  // is a pass-through, and the `Keyed` round trip is pure overhead — a wrapper
  // object and an empty `keys` array allocated per row, two generator layers to
  // put them on and take them off again. Returning the projection directly is
  // the same rows in the same order, projected just as lazily and faulting on
  // exactly the same ones.
  //
  // Item 98 priced removing ONE of the ~11 layers at 5-8% and retracted it as
  // under the noise floor. This removes two layers AND both allocations, which
  // is why it is worth doing where that was not; the measured number is in item
  // 113.
  if (
    !proj.aggregating &&
    orderBy.length === 0 &&
    !proj.distinct &&
    skipBound === undefined &&
    limitBound === undefined
  ) {
    return map((b: Binding) => projectBinding(proj, b, params, graph), bindings);
  }

  // See `pagedFaultFreeRows` — extracted because the complexity cap objected, exactly as it did
  // at item 377.
  const paged = pagedFaultFreeRows(proj, bindings, params, graph, skipBound, limitBound);

  if (paged !== null) {
    return paged;
  }

  let keyed: Iterable<Keyed>;

  if (proj.aggregating) {
    // Grouping is a barrier — it must see every binding before it can emit. We
    // still fold into per-group buckets with single `push`es (never a spread).
    const groups = buildGroups(proj, bindings, params, graph);
    // ISO HAVING: drop a group whose post-aggregation predicate is not exactly
    // TRUE (three-valued — NULL/false both drop). The aggregates fold over the
    // group array; group keys read the representative binding.
    const { having } = proj;
    const groupList = having
      ? [...groups.values()].filter((group) => {
          const rep = group[0] ?? new Map();

          return asTruth(having({ binding: rep, params, graph, group })) === true;
        })
      : groups.values();

    keyed = map((group: Binding[]) => {
      const rep: Binding = group[0] ?? new Map();
      const projected = projectBinding(proj, rep, params, graph, group);
      // ORDER BY sees the output columns overlaid on the input variables.
      const sortBinding = orderBy.length > 0 ? new Map([...rep, ...projected]) : rep;

      return {
        b: projected,
        keys: orderBy.map((s) => s.fn({ binding: sortBinding, params, graph, group })),
      };
    }, groupList);
  } else {
    // Non-aggregating: a lazy map — rows are projected on demand.
    keyed = map((b: Binding) => {
      const projected = projectBinding(proj, b, params, graph);
      const sortBinding = orderBy.length > 0 ? new Map([...b, ...projected]) : b;

      return {
        b: projected,
        keys: orderBy.map((s) => s.fn({ binding: sortBinding, params, graph })),
      };
    }, bindings);
  }

  if (proj.distinct) {
    const seen = new Set<string>();
    keyed = filter((r: Keyed) => {
      const k = rowKey(r.b);

      if (seen.has(k)) {
        return false;
      }

      seen.add(k);

      return true;
    }, keyed);
  }

  // ORDER BY is the other barrier. With a LIMIT we only need skip+limit rows, so a
  // bounded top-k (O(n log k), never materializing the rest) beats sorting all n;
  // without a LIMIT, sort the whole owned array.
  let ordered: Iterable<Keyed> = keyed;

  if (orderBy.length > 0 && limitBound !== undefined) {
    ordered = boundedTopK(keyed, (skipBound ?? 0) + limitBound, cmp);
  } else if (orderBy.length > 0) {
    const arr = toArray(keyed);
    arr.sort(cmp);
    ordered = arr;
  }

  // SKIP/LIMIT stay lazy — `take` short-circuits, so `LIMIT n` over a huge
  // unordered stream stops after n rows instead of computing them all.
  const start = skipBound ?? 0;
  let sliced: Iterable<Keyed> = start > 0 ? skip(start, ordered) : ordered;

  if (limitBound !== undefined) {
    sliced = take(limitBound, sliced);
  }

  return map((r: Keyed) => r.b, sliced);
};

// --- pattern compilation -----------------------------------------------------

/** A compiled property map + inline WHERE (the ISO element-pattern predicate). */
export type CProp = { key: string; value: CompiledExpr };
export type CPredicate = {
  props: readonly CProp[];
  where?: CompiledExpr;
  /**
   * The conjuncts of a `WHERE` that are `<ownVar>.<key> = <non-null literal>`, compiled to read the
   * ELEMENT directly instead of looking it up in the binding. See {@link directEqProps}.
   *
   * Deliberately NOT merged into `props`: `indexCandidates` reads `props` to decide seeding, so
   * moving a predicate there would change which vertices seed FIRST. That is an observable
   * row-order change, and the fuzzers canonicalise unordered row order, so its byte-identity
   * against native cannot be verified here (audit item 224).
   */
  eqProps?: readonly CProp[];
  /**
   * The same lift for an ORDERING comparison (`<`, `<=`, `>`, `>=`, `<>`), which `eqProps`
   * cannot carry because it hard-codes `=`.
   *
   * A separate list rather than an `op` field on `CProp`: `eqProps` is the already-tuned
   * equality path (items 210, 230, 260) and a per-entry operator dispatch would make it pay
   * for a generality only this list needs.
   */
  cmpProps?: readonly CCmpProp[];
};

/** A lifted ordering comparison: the property, the operator, and its closed right-hand side. */
export type CCmpProp = { key: string; op: CompareOp; value: CompiledExpr };

/** Range bounds whose endpoints are compiled value closures (resolved per seed). */
export type CRangeBound = {
  gt?: CompiledExpr;
  gte?: CompiledExpr;
  lt?: CompiledExpr;
  lte?: CompiledExpr;
};

/**
 * A seedable predicate lifted out of a WHERE / inline-pattern conjunction: a
 * necessary condition on a node's property that an index can seek. Sound only
 * because it comes from an AND-chain (every conjunct must hold), so the seed is
 * always a superset of the node's true matches — `matchNode` re-validates.
 */
type CSeedHint =
  | { kind: 'eq'; key: string; value: CompiledExpr }
  | { kind: 'within'; key: string; values: CompiledExpr }
  | { kind: 'range'; key: string; bound: CRangeBound };

export type CNode = {
  variable?: string;
  label?: LabelExpr;
  pred: CPredicate;
  seedHints?: readonly CSeedHint[];
};
export type CRel = {
  variable?: string;
  label?: LabelExpr;
  direction: RelPattern['direction'];
  pred: CPredicate;
  quantifier?: RelPattern['quantifier'];
};
/** One hop of a repetition unit: traverse `rel`, land on `targetVar` (a group var). */
type CHop = { rel: CRel; targetVar?: string };
/** A nested quantified sub-unit — the general `( … ){a,b}` nesting. `max` is `null`
 *  for an unbounded `*`/`+`/`{n,}`. `targetVar` is the sub-unit's LANDING group var
 *  (`y` in `-[]->{a,b}(y)`), bound once per enclosing rep. Mirrors native `CSub`. */
type CSub = { unit: CUnit; min: number; max: number | null; targetVar?: string };
/** One element of a unit: a single hop, or a nested quantified sub-unit. Mirrors
 *  native `CElem`. */
type CElem = { hop: CHop } | { sub: CSub };
/**
 * A quantified parenthesized subpath compiled to a repetition UNIT: a linear element
 * sequence repeated `[min, max]` times. `startVar` is the source `(x)` group var; a
 * hop's `targetVar` is an intermediate/target group var; `where` is the per-repetition
 * predicate. Elements may be nested quantified sub-units. Mirrors native `CUnit`.
 */
export type CUnit = { elems: readonly CElem[]; startVar?: string; where?: CompiledExpr };
export type CSegment = { rel: CRel; node: CNode; unit?: CUnit };

/** Whether a unit binds any GROUP variable (source, an edge, a target, a `Sub`'s
 *  landing, or anything a nested sub-unit binds). Mirrors native `CUnit::exposes`. */
export const unitExposes = (u: CUnit): boolean =>
  u.startVar !== undefined ||
  u.elems.some((e) =>
    'hop' in e
      ? e.hop.targetVar !== undefined || e.hop.rel.variable !== undefined
      : e.sub.targetVar !== undefined || unitExposes(e.sub.unit),
  );

/** Whether every element is a plain hop (no nested `Sub`) — a flat unit binds group
 *  variables by the cheap `k`-stride over the flat walk, never per-hop steps. Mirrors
 *  native `CUnit::is_flat`. */
export const unitIsFlat = (u: CUnit): boolean => u.elems.every((e) => 'hop' in e);
export type CPath = {
  start: CNode;
  segments: readonly CSegment[];
  /** Whole path bound to this variable (`p = …`), or unnamed. */
  pathVar?: string;
  /** Which matching paths to keep; defaults to `walk`. */
  selector: PathSelector;
  /** The repeated-element restrictor on a var-length walk; defaults to `trail`. */
  mode: PathMode;
  /**
   * Every variable this pattern BINDS, and every OUTER variable its expressions
   * READ. Both are computed at compile time because they have to be: by the time
   * a `CPath` reaches the matcher its predicates are compiled closures, with no
   * AST left to walk (see audit item 121).
   *
   * `reads` excludes the pattern's own bindings — `(n WHERE n.age > 30)` reads
   * nothing outer — so `reads` is exactly the set that makes this pattern
   * CORRELATED with something bound before it.
   */
  binds: ReadonlySet<string>;
  reads: ReadonlySet<string>;
  /**
   * A fault-swallowing SEED filter: skip a start vertex this predicate cleanly rejects,
   * so the walk never expands it. `var` is the start variable the predicate was lifted
   * for — `orient` can flip which end a walk seeds from, and the predicate is only
   * valid against the end it names.
   *
   * An optimization ONLY. The clause `WHERE` stays in place and remains the authority on
   * both rows and faults. See `seedPrefilter` for why that is load-bearing.
   */
  prefilter?: { readonly var: string; readonly pred: CompiledExpr };
};

const compileProps = (props: readonly PropertyConstraint[] | undefined): CProp[] =>
  (props ?? []).map(({ key, value }) => ({ key, value: compileExpr(value) }));

/**
 * An inline `WHERE` that is exactly one `<ownVar>.<key> = <non-null literal>`, as a property-style
 * constraint — or `null` when it is anything else.
 *
 * ### Why
 *
 * An inline PROPERTY compiles to `structuralEq(propOf(element, key), …)`, a direct read. An inline
 * `WHERE` compiles to the generic expression evaluator, which reads its element back out of the
 * binding — so it pays a `Map.set` by the caller plus a `Map.get` per property read to hand over an
 * element `satisfies` already holds. That is item 216's finding in a second place, and the spelling
 * probe had been flagging it for three shapes at once (audit item 224):
 *
 *     MATCH (n:P {k: 2}) RETURN count(*)              3.82ms
 *     MATCH (n:P) WHERE n.k = 2 RETURN count(*)       5.80
 *     MATCH (n:P WHERE n.k = 2) RETURN count(*)       8.51      ← 2.2x the first
 *
 * ### The three restrictions, each forced by semantics rather than caution
 *
 * **`=` only.** For `=`, a nullish property gives UNKNOWN through `compare` (and `asTruth(null)`
 * is not `true`, so the row is rejected) and `structuralEq(null, 2)` is `false` — the same outcome.
 * For `<>` they DIVERGE: `compare` still yields UNKNOWN, where a negated structural check would
 * yield `true`.
 *
 * **A non-null LITERAL.** The null case is the load-bearing half: `{k: null}` matches a stored null
 * AND an absent key, while `n.k = null` matches neither, so a null value makes the two forms
 * different questions. A `null` literal is therefore genuinely excluded here.
 *
 * The `param` half of that test is DEFENSIVE and currently UNREACHABLE, which mutation established
 * rather than my reading it off the code: accepting params survives the whole suite, because
 * `inlineOf` refuses an inline `WHERE` containing `$p` before this is ever called —
 * `freePredicateVars` reports the param as a free name that is not the node's variable. The clause
 * stays, because that upstream refusal is not a property to lean on, but the reason params do not
 * arrive is the refusal and not the semantics.
 *
 * **An AND-chain only when EVERY conjunct is such a comparison** (item 230 — item 224 took exactly
 * one). `AND` does not short-circuit here, by design and for byte-identity: `FALSE AND <data
 * exception>` must still raise, so hoisting one conjunct ahead of a sibling that RAISES would
 * swallow the raise. The admission rule answers that directly rather than avoiding it: every
 * conjunct must be `<ownVar>.<key> <op> <closed value>` with `op` of `=`, and a closed `=` cannot
 * raise — cross-type `=` is a NO-MATCH in this engine where `<=` throws, and `structuralEq` ends in
 * `===`. With nothing in the chain able to raise there is nothing for a reordering to swallow, so
 * EVERY admitted conjunct lifts into `eqProps` — literal and param alike since 2026-10-09, when
 * the `eqProps` loop gained the null-right-hand-side guard that makes a lifted entry mean `=`
 * rather than `{k: v}`. (It previously said params "stay behind in `where`"; they no longer do,
 * and that is item 210's route two.)
 *
 * One mixed conjunct of any other shape (an inequality, a function call, a second variable)
 * declines the WHOLE chain. That WAS forced: a residual that can raise is the case the paragraph
 * above forbids. It is now merely unimplemented — item 259 made conjunct order unobservable in a
 * FILTER, which is the only position this predicate is read in, so lifting the equalities and
 * leaving a raising residual behind is sound. Telling the two apart conjunct-by-conjunct is the
 * next step, not a property this avoids.
 */
const directEqProps = (
  where: Expr,
  ownVar: string | undefined,
): { eq: CProp[]; cmp: CCmpProp[]; residual: Expr | undefined } | null => {
  if (ownVar === undefined) {
    return null;
  }

  // A nested `and` under an `and` is not flattened here — it declines below as a non-`compare`
  // conjunct. The parser produces one flat `items` list for `a AND b AND c`, so the nested shape
  // arrives only from parenthesisation, and declining it is a missed optimisation, not a wrong
  // answer.
  const conjuncts = where.kind === 'and' ? where.items : [where];
  const eq: CProp[] = [];
  const cmp: CCmpProp[] = [];

  for (const conjunct of conjuncts) {
    if (conjunct.kind !== 'compare') {
      return null;
    }

    // `asPropCompare` is the seed-hint extractor's own reader: it handles both operand orders
    // (because `n.k = 2` and `2 = n.k` are one question and this engine's named bug class is the
    // two costing differently) and already requires a CLOSED value side.
    const pc = asPropCompare(conjunct);

    if (pc === null || pc.variable !== ownVar) {
      return null;
    }

    // AN ORDERING COMPARISON LIFTS TOO, which this used to decline — "merely unimplemented",
    // in the words above. The scan is the same either way; what changes is where the left
    // operand comes from, and reading it off the element skips the binding `Map` the generic
    // evaluator goes through. Measured at 200,000 vertices with no index, on a count whose
    // predicate admits ONE row either way so the answer size cannot explain it:
    //
    //   WHERE k = <lit>     30.5 ns a vertex
    //   WHERE k > <lit>     49.9 ns a vertex   (selective spelling)
    //
    // 1.64x (item 276, deferred there because the gates that ask "is this predicate empty?"
    // were spread across nine hand-written checks — item 277 replaced them with
    // `hasPredicate`, so this field is picked up by all of them at once).
    if (pc.op !== '=') {
      cmp.push({ key: pc.key, op: pc.op, value: compileExpr(pc.value) });
      continue;
    }

    // EVERY closed value lifts, params and `null` literals included — which this refused until
    // 2026-10-09. The refusal was right at the time and its reason is recorded above: `$p`
    // resolving to null would make `structuralEq` match a stored null where `=` yields UNKNOWN,
    // and "lifting params needs a per-execution safety check on the resolved value". That check
    // now exists, in `matchesPredicate`'s `eqProps` loop: a null right-hand side rejects the row,
    // which IS `=`'s answer. So the entry carries expression equality and the value may be
    // anything closed.
    //
    // This is what unblocks item 210's measured 1.16x WITHOUT the `{k: null}` semantics decision,
    // which is exactly what that item said route two would do — the bench row it was measured on
    // (`WHERE u.name = $n`) is param-valued, so lifting literals alone would not have moved it.
    eq.push({ key: pc.key, value: compileExpr(pc.value) });
  }

  if (eq.length === 0 && cmp.length === 0) {
    return null;
  }

  // `residual` is ALWAYS undefined now, and the plumbing for it is gone rather than left looking
  // live. Every admitted conjunct lifts (the param and null-literal exceptions were the only
  // things that ever stayed behind), and a conjunct this does NOT admit declines the whole chain
  // above — so there is no partial outcome left to express. `compilePredicate` keeps reading
  // `direct.residual` because the shape is what a future MIXED chain would need: item 259 made
  // reordering a FILTER's conjuncts unobservable, so lifting the equalities and leaving the rest
  // is now sound where it previously was not, and that is the next step rather than this one.
  return { eq, cmp, residual: undefined };
};

/**
 * Does this compiled predicate constrain anything at all?
 *
 * THE ONE DEFINITION, because spreading it by hand produced a WRONG ANSWER. `CPredicate`
 * carries a constraint in three places — inline properties (`props`), a general compiled
 * expression (`where`), and equalities lifted to be read straight off the element
 * (`eqProps`) — and six of the seven checks that asked "is this predicate empty?" listed
 * only the first two. An inline `WHERE a.k = 1` passes an `ownVar`, so it lifts ENTIRELY
 * into `eqProps` and such a check saw nothing:
 *
 * ```text
 * MATCH (a:P) WHERE EXISTS { MATCH (a WHERE a.k = 1)-[:E]->(x) } RETURN a.n
 *   want [a]   got [a, b, c]
 * ```
 *
 * while `(a {k: 1})` — the SAME question, landing in `props` — answered `[a]` correctly, and
 * so did `(a WHERE a.k > 2)`, which stays in `where`. One question, three spellings, one of
 * them silently unfiltered: the defect class this engine is named for (item 277).
 *
 * Every gate that decides "can I skip applying this predicate" or "is this node
 * constrained" must go through here, so a FOURTH place to carry a constraint cannot
 * reintroduce the bug by being forgotten at six call sites.
 */
export const hasPredicate = (pred: CPredicate): boolean =>
  pred.props.length > 0 ||
  pred.where !== undefined ||
  (pred.eqProps?.length ?? 0) > 0 ||
  (pred.cmpProps?.length ?? 0) > 0;

export const compilePredicate = (
  properties: readonly PropertyConstraint[] | undefined,
  where: Expr | undefined,
  // The element's OWN variable, supplied by a caller that has PROVED the `WHERE` reads nothing
  // else — `inlineOf` for an inline predicate, and `freePredicateVars` for the clause `WHERE` the
  // node-count tally carries (item 230). Omitted where no such proof exists, which is any clause
  // `WHERE` that may read another variable and so cannot be element-local.
  ownVar?: string,
): CPredicate => {
  const direct = where !== undefined ? directEqProps(where, ownVar) : null;
  // What the general evaluator still has to do: the whole `WHERE` when nothing lifted, or just the
  // conjuncts `directEqProps` left behind.
  const generic = direct === null ? where : direct.residual;

  return {
    props: compileProps(properties),
    // FILTER position: `matchesPredicate` reads this as `asTruth(...) === true`, below a `props`
    // and an `eqProps` loop that both `return false` outright. So a conjunct that is not cleanly
    // TRUE settles the element and its siblings need not be evaluated — see `filterPredicate`.
    // This is the site a clause `WHERE` on a single-node pattern actually lands on, because
    // `pushWhereIntoNode` moves it here before `compileClause` compiles anything.
    where: generic === undefined ? undefined : filterPredicate(generic),
    ...(direct === null || direct.eq.length === 0 ? {} : { eqProps: direct.eq }),
    ...(direct === null || direct.cmp.length === 0 ? {} : { cmpProps: direct.cmp }),
  };
};

// --- seed-hint extraction ----------------------------------------------------

/** A value usable as a seek key without binding the node's own variable. */
const isConstExpr = (e: Expr): boolean => e.kind === 'lit' || e.kind === 'param';

/**
 * Can this `IN` right-hand side seed an index — a list whose every item is closed, or a PARAM
 * that will hold the whole array?
 *
 * The param case was missing, and it is the spelling applications actually write: binding the
 * list keeps values out of the query text, so `IN $names` is the injection-safe form and
 * `IN […]` with inline literals is the rare one. `WHERE k IN [$a, $b]` already seeded (a `list`
 * node whose items are params); `WHERE k IN $names` did not, because the list node itself is a
 * `param`. Measured on 20,000 users with `name` indexed, 100 names (audit item 184):
 *
 *   MATCH (u:User) WHERE u.name IN $names RETURN count(*)       4751.3us, 0 index hits
 *   MATCH (u:User) WHERE u.name IN $names SET u.score = $v      5747.1us, 0 index hits
 *   CONTROL the same with ONE name, `u.name = $one`               40.1us, 1 index hit
 *
 * Identical with and without the index (5745.3us unindexed against 5747.1 indexed), which is
 * item 149's signature for an index doing nothing. This is also one of the four examples
 * CLAUDE.md names for this engine's bug class: `k = $a OR k = $b` against `k IN [$a, $b]`.
 *
 * Nothing else had to change: `indexCandidates`'s `within` branch already resolves the values
 * per execution and declines unless the result is an array of scalars, so a param bound to a
 * non-array simply yields no candidate and the scan stands.
 */
const closedList = (e: Expr): boolean =>
  e.kind === 'param' || (e.kind === 'list' && e.items.every(isConstExpr));

/** Mirror a comparison operator when its operands are swapped (`30 < a.age`). */
const FLIP: Record<CompareOp, CompareOp> = {
  '=': '=',
  '<>': '<>',
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
};

type HintMap = Map<string, CSeedHint[]>;

const pushHint = (into: HintMap, variable: string, hint: CSeedHint): void => {
  const list = into.get(variable);

  if (list) {
    list.push(hint);
  } else {
    into.set(variable, [hint]);
  }
};

/** A `prop <op> const` comparison, normalized so the property is on the left. */
const asPropCompare = (
  expr: Extract<Expr, { kind: 'compare' }>,
): { variable: string; key: string; op: CompareOp; value: Expr } | null => {
  if (expr.left.kind === 'prop' && isConstExpr(expr.right)) {
    return { variable: expr.left.variable, key: expr.left.key, op: expr.op, value: expr.right };
  }

  if (expr.right.kind === 'prop' && isConstExpr(expr.left)) {
    return {
      variable: expr.right.variable,
      key: expr.right.key,
      op: FLIP[expr.op],
      value: expr.left,
    };
  }

  return null;
};

const BOUND_OF: Partial<Record<CompareOp, keyof CRangeBound>> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

/**
 * Walk a predicate's AND-chain, collecting per-variable seed hints from the
 * conjuncts an index can seek: `prop = const`, range comparisons, and `prop IN
 * [consts]`. Only `and` is descended — an `or`/`not` branch could admit rows a
 * single-conjunct seed would miss, so those (and every non-seekable shape) are
 * left entirely to the residual WHERE.
 */
/**
 * The one variable, key and values of a disjunction every branch of which is `<var>.<key> = v`
 * for the SAME var and key — or `undefined` for any other `or`.
 *
 * Nested disjunctions are flattened: a same-operator run folds into one n-ary `or` in this AST,
 * but a parenthesized group does not, so `(k = a OR k = b) OR k = c` arrives as two items. The
 * engine's `multi_eq_target` flattens its binary `Or` tree for the same reason.
 *
 * ONE non-conforming branch gives up the whole chain, and that is required rather than cautious:
 * `k = a OR j = b` selects vertices a `k`-only seek would miss, so a partial seed would be a
 * SUBSET of the matches — the one thing a seed may not be.
 */
export const uniformEqChain = (
  e: Expr,
): { variable: string; key: string; values: Expr[] } | undefined => {
  const branches: Expr[] = [];
  const flatten = (x: Expr): void => {
    if (x.kind === 'or') {
      for (const item of x.items) {
        flatten(item);
      }

      return;
    }

    branches.push(x);
  };

  flatten(e);

  if (branches.length < 2) {
    return undefined;
  }

  let variable: string | undefined;
  let key: string | undefined;
  const values: Expr[] = [];

  for (const branch of branches) {
    if (branch.kind !== 'compare') {
      return undefined;
    }

    const pc = asPropCompare(branch);

    if (pc?.op !== '=') {
      return undefined;
    }

    if (variable === undefined) {
      ({ variable, key } = pc);
    } else if (pc.variable !== variable || pc.key !== key) {
      return undefined;
    }

    values.push(pc.value);
  }

  return variable !== undefined && key !== undefined ? { variable, key, values } : undefined;
};

const collectHints = (where: Expr, into: HintMap): void => {
  switch (where.kind) {
    case 'and':
      for (const conjunct of where.items) {
        collectHints(conjunct, into);
      }

      return;
    case 'compare': {
      const pc = asPropCompare(where);

      if (!pc) {
        return;
      }

      if (pc.op === '=') {
        pushHint(into, pc.variable, { kind: 'eq', key: pc.key, value: compileExpr(pc.value) });

        return;
      }

      const boundKey = BOUND_OF[pc.op];

      if (boundKey) {
        pushHint(into, pc.variable, {
          kind: 'range',
          key: pc.key,
          bound: { [boundKey]: compileExpr(pc.value) },
        });
      }

      return;
    }
    case 'in':
      if (!where.negated && where.expr.kind === 'prop' && closedList(where.list)) {
        pushHint(into, where.expr.variable, {
          kind: 'within',
          key: where.expr.key,
          values: compileExpr(where.list),
        });
      }

      return;
    case 'or': {
      // A UNIFORM same-key `=`-chain is ONE multi-value seek, not a disjunction the seed layer
      // has to give up on. `k = a OR k = b` and `k IN [a, b]` are one question — `CLAUDE.md`
      // lists that exact pair among the spellings whose seeding gap cost 100-300x — and until
      // now only the `IN` spelling seeded, because this switch descended `and` and nothing else.
      //
      // Sound because the union of `equals(k, v_i)` IS the predicate's row set, and because a
      // hint only narrows the SEED: `seedVertices` picks the cheapest candidate and the
      // predicate still runs during matching, so a seed may be a superset but never a subset.
      // That is also why nothing here drops a null or checks closedness — the `within` consumer
      // already skips the hint unless every resolved value `isScalar`, and a skipped hint falls
      // back to the label bucket. (The engine's twin rewrite has to be exact instead, because
      // there the seeks REPLACE the predicate — see `multi_seek` in `opt.rs`.)
      const chain = uniformEqChain(where);

      if (chain) {
        pushHint(into, chain.variable, {
          kind: 'within',
          key: chain.key,
          values: compileExpr({ kind: 'list', items: chain.values }),
        });
      }

      return;
    }
    default:
  }
};

/** Hints a predicate contributes to one variable (used for inline node WHERE). */
const hintsForVariable = (where: Expr | undefined, variable: string | undefined): CSeedHint[] => {
  if (!where || !variable) {
    return [];
  }

  const into: HintMap = new Map();
  collectHints(where, into);

  return coalesceRangeHints(into.get(variable) ?? []);
};

/**
 * Fold a variable's range hints on the same key into one bound, so
 * `n.age >= 29 AND n.age < 35` seeks the tight `[29, 35)` slice rather than
 * just the more selective single side. First-wins on a repeated side (e.g. two
 * lower bounds) — dropping a redundant tightening only widens the seed, which
 * stays a sound superset for `matchNode` to re-validate.
 */
const coalesceRangeHints = (hints: readonly CSeedHint[]): CSeedHint[] => {
  const bounds = new Map<string, CRangeBound>();
  const out: CSeedHint[] = [];

  for (const hint of hints) {
    if (hint.kind !== 'range') {
      out.push(hint);
      continue;
    }

    const existing = bounds.get(hint.key);

    if (!existing) {
      const bound: CRangeBound = { ...hint.bound };
      bounds.set(hint.key, bound);
      out.push({ kind: 'range', key: hint.key, bound });
      continue;
    }

    for (const side of ['gt', 'gte', 'lt', 'lte'] as const) {
      if (existing[side] === undefined && hint.bound[side] !== undefined) {
        existing[side] = hint.bound[side];
      }
    }
  }

  return out;
};

const compileNode = (node: NodePattern): CNode => {
  const seedHints = hintsForVariable(node.where, node.variable);

  return {
    variable: node.variable,
    label: node.label,
    // `node.variable` as the own-var, which this did NOT pass until 2026-10-09 — so
    // `directEqProps` returned `null` on its first line and the general scan path never lifted an
    // equality at all, while every SHORTCUT path (which does pass one) did. That asymmetry IS item
    // 210's measured 1.16x: 83ns a vertex for a compiled expression against 71 for a direct
    // property check, on every node scan the shortcuts decline — which is every filtered WRITE,
    // because `detectNodeProjection` requires a `RETURN`.
    //
    // Safe without a separate proof that the predicate is element-local, because `directEqProps`
    // checks `pc.variable !== ownVar` per conjunct and declines the WHOLE chain on the first
    // conjunct that reads anything else. `pushWhereIntoNode` deliberately does not restrict free
    // variables, so that per-conjunct check is the thing standing between this and a
    // mis-attributed property read.
    pred: compilePredicate(node.properties, node.where, node.variable),
    seedHints: seedHints.length > 0 ? seedHints : undefined,
  };
};

// A quantified segment may carry a per-hop predicate (inline props / WHERE),
// applied to every edge of the walk; the optional edge variable names each hop's
// edge in turn for that predicate (it is not yet a group/list variable exposed to
// the outer query). `trailEnds` binds and filters each hop.
export const compileRel = (rel: RelPattern): CRel => ({
  variable: rel.variable,
  label: rel.label,
  direction: rel.direction,
  pred: compilePredicate(rel.properties, rel.where),
  quantifier: rel.quantifier,
});

export const relHasPredicate = (rel: RelPattern): boolean =>
  (rel.properties?.length ?? 0) > 0 || rel.where !== undefined;

/** Build one repetition unit from a quantified-subpath segment. A NESTED parenthesized
 *  subpath (`( ((x)-[e]->(y)){a,b} ){n,m}`) recurses: the outer unit's sole element is a
 *  `Sub` wrapping the inner subpath's unit, so its variables nest one list level deeper.
 *  Otherwise it's the inner hop chain. Mirrors native `plan::Lowerer::subpath_unit`. */
/**
 * Is this inline hop `WHERE` provably about its OWN EDGE and nothing else?
 *
 * A plain hop's inline `WHERE` is normally LIFTED to the repetition's unit predicate, because
 * it may reference the repetition's other variables — `-[e:R WHERE e.w > x.n]->` needs `x`,
 * which is only bound once the rep completes. But the matcher evaluates only the OUTERMOST
 * unit's `where`, so a lifted predicate inside a NESTED sub-unit was carried by the compiler
 * and then never evaluated: `(((x)-[e:E WHERE e.w > 2]->(y)){1,1}){1,2}` returned the
 * UNFILTERED answer, while the equivalent flat `((x)-[e:E WHERE e.w > 2]->(y)){1,2}` filtered
 * correctly (audit item 249).
 *
 * An edge-only predicate needs no lifting at all: left on the hop, `expandFilteredArr` applies
 * it during expansion — correct at any nesting depth, and EARLIER than rep completion.
 *
 * An ALLOWLIST, not a free-variable check. `freePredicateVars` does not descend into a
 * subquery (see `order-by-subquery-alias-collision`), so it reports the empty set for
 * `EXISTS { … }` and would call a predicate edge-only that reads half the row. Every node kind
 * admitted here is one whose operands are fully walked below; anything else — a subquery, a
 * `let`, a function call, a reference to another variable — lifts as before.
 */
const edgeOnlyWhere = (expr: Expr | undefined, edgeVar: string | undefined): boolean => {
  if (expr === undefined || edgeVar === undefined) {
    return false; // no predicate, or an anonymous hop whose WHERE cannot be about its own edge
  }

  const ok = (e: Expr): boolean => {
    switch (e.kind) {
      case 'prop':
      case 'property_exists':
        return e.variable === edgeVar;
      case 'lit':
      case 'param':
        return true;
      case 'not':
      case 'neg':
        return ok(e.expr);
      case 'compare':
        return ok(e.left) && ok(e.right);
      case 'arith':
        return ok(e.head) && e.tail.every(([, operand]) => ok(operand));
      case 'and':
      case 'or':
      case 'xor':
      case 'list':
        return e.items.every(ok);
      default:
        return false;
    }
  };

  return ok(expr);
};

const compileSubpathUnit = (seg: Segment): CUnit => {
  if (seg.nested !== undefined) {
    const inner = seg.nested;
    const q = inner.rel.quantifier!; // a nested subpath is always quantified

    // The nested subpath's LANDING is the outer segment's endpoint node, matched
    // separately — not a group variable of this unit (so no `targetVar` on the `Sub`). The
    // outer subpath-level WHERE (per outer rep, inner vars bound as lists) is the unit WHERE.
    return {
      elems: [{ sub: { unit: compileSubpathUnit(inner), min: q.min, max: q.max ?? null } }],
      ...(seg.subpathWhere !== undefined ? { where: compileExpr(seg.subpathWhere) } : {}),
    };
  }

  const { rel, hopFrom, hopTo, unitRest, innerQ } = seg;
  // Each inner hop is a plain hop, OR a nested single-edge `Sub` when it carries its own
  // quantifier (`-[e]->{a,b}`). The first hop's nested quantifier is `innerQ`; later hops
  // carry theirs on `rel.quantifier`.
  const astElems: { rel: RelPattern; targetVar?: string; q?: Quantifier }[] = [
    {
      rel,
      ...(hopTo?.variable !== undefined ? { targetVar: hopTo.variable } : {}),
      ...(innerQ !== undefined ? { q: innerQ } : {}),
    },
    ...(unitRest ?? []).map((extra) => ({
      rel: extra.rel,
      ...(extra.node.variable !== undefined ? { targetVar: extra.node.variable } : {}),
      ...(extra.rel.quantifier !== undefined ? { q: extra.rel.quantifier } : {}),
    })),
  ];

  // The subpath-level WHERE is the per-repetition predicate; a PLAIN hop's inline WHERE is
  // also lifted to the unit level; a NESTED hop's WHERE (`-[e WHERE …]->{a,b}`) is a
  // per-inner-edge predicate that STAYS on the `Sub`'s inner hop (not lifted).
  // ...EXCEPT when it is provably about its own edge, which needs no lifting and must not be
  // lifted inside a nested sub-unit, where the matcher never evaluates it (item 249).
  const whereExprs = [
    seg.subpathWhere,
    ...astElems
      .filter((h) => h.q === undefined && !edgeOnlyWhere(h.rel.where, h.rel.variable))
      .map((h) => h.rel.where),
  ].filter((w): w is Expr => w !== undefined);
  let unitWhere: Expr | undefined;

  if (whereExprs.length === 1) {
    [unitWhere] = whereExprs;
  } else if (whereExprs.length > 1) {
    unitWhere = { kind: 'and', items: whereExprs };
  }

  const hopOrSub = (h: { rel: RelPattern; targetVar?: string; q?: Quantifier }): CElem => {
    if (h.q === undefined) {
      // Plain hop: its WHERE was lifted, so strip it from the hop predicate — unless it is
      // edge-only, in which case it was NOT lifted and stays here to filter at expansion.
      const keep = edgeOnlyWhere(h.rel.where, h.rel.variable);
      const chop: CHop = {
        rel: compileRel({
          ...h.rel,
          ...(keep ? {} : { where: undefined }),
          quantifier: undefined,
        }),
        ...(h.targetVar !== undefined ? { targetVar: h.targetVar } : {}),
      };

      return { hop: chop };
    }

    // Nested `-[]->{a,b}(y)` hop: the landing `y` is the WHOLE sub-unit's target (bound
    // once per enclosing rep — `CSub.targetVar`); the inner hop's own target is anonymous.
    // The inner hop keeps its WHERE (per-inner-edge predicate).
    const innerHop: CHop = { rel: compileRel({ ...h.rel, quantifier: undefined }) };

    return {
      sub: {
        unit: { elems: [{ hop: innerHop }] },
        min: h.q.min,
        max: h.q.max ?? null,
        ...(h.targetVar !== undefined ? { targetVar: h.targetVar } : {}),
      },
    };
  };

  return {
    elems: astElems.map(hopOrSub),
    ...(hopFrom?.variable !== undefined ? { startVar: hopFrom.variable } : {}),
    ...(unitWhere !== undefined ? { where: compileExpr(unitWhere) } : {}),
  };
};

/**
 * The variables a pattern binds, and the OUTER ones its expressions read.
 *
 * `reads` is delegated to `freePredicateVars` over a synthetic `EXISTS { pattern }`
 * rather than re-walking the pattern here: that walker already visits exactly the
 * inline property values and inline `WHERE`s at every depth (nodes, rels,
 * repetition units), already adds the pattern's own bindings to its bound set
 * before descending, and already carries an exhaustiveness guard so a new `Expr`
 * kind cannot slip past it. A second traversal would be a second thing to keep
 * in step with the grammar.
 */
const patternVarSets = (pattern: PathPattern): { binds: Set<string>; reads: Set<string> } => {
  const binds = new Set<string>();

  patternBoundVars(pattern, binds);

  return { binds, reads: freePredicateVars({ kind: 'exists', patterns: [pattern] }) };
};

/** The clause-level union of its patterns' sets, plus its own `WHERE`'s free variables. */
const matchVarSets = (
  patterns: readonly PathPattern[],
  where: Expr | undefined,
): { binds: Set<string>; reads: Set<string> } => {
  const binds = new Set<string>();
  const reads = new Set<string>();

  for (const p of patterns) {
    const sets = patternVarSets(p);

    for (const n of sets.binds) {
      binds.add(n);
    }

    for (const n of sets.reads) {
      reads.add(n);
    }
  }

  if (where !== undefined) {
    for (const n of freePredicateVars(where)) {
      reads.add(n);
    }
  }

  // A name the clause binds itself is not an OUTER read.
  for (const n of binds) {
    reads.delete(n);
  }

  return { binds, reads };
};

const compilePath = (pattern: PathPattern): CPath => {
  const selector = pattern.selector ?? 'walk';
  const { binds, reads } = patternVarSets(pattern);

  return {
    binds,
    reads,
    start: compileNode(pattern.start),
    segments: pattern.segments.map((seg) => {
      const crel = compileRel(seg.rel);

      // A plain / abbreviated hop — no repetition unit.
      if (seg.hopFrom === undefined && seg.nested === undefined) {
        // EXCEPT a FLAT quantified rel that binds a variable (`-[r:R]->{n,m}`): the
        // variable binds the LIST of the walk's edges (the edge trail), exactly like the
        // equivalent subpath spelling `((x)-[r:R]->(m)){n,m}`. Compile it to a single-hop
        // unit (anonymous endpoints) so the edge var is exposed as a group (list) variable.
        // Equivalent spellings must produce the same result — this mirrors native's
        // RepeatGroup{k:1, EdgeAt(0)} routing in `gql::extend_chain`.
        if (seg.rel.quantifier !== undefined && seg.rel.variable !== undefined) {
          const unit: CUnit = {
            elems: [{ hop: { rel: compileRel({ ...seg.rel, quantifier: undefined }) } }],
          };

          return { rel: crel, node: compileNode(seg.node), unit };
        }

        return { rel: crel, node: compileNode(seg.node) };
      }

      // A quantified parenthesized subpath compiles to a UNIT; `node` is the separate
      // outer endpoint. Mirrors native `plan::segment`.
      return { rel: crel, node: compileNode(seg.node), unit: compileSubpathUnit(seg) };
    }),
    ...(pattern.pathVar !== undefined ? { pathVar: pattern.pathVar } : {}),
    selector,
    mode: pattern.mode ?? 'trail',
  };
};

/**
 * The ISO element-pattern predicate: every property-map entry must equal the
 * element's stored value, and any inline `WHERE` must hold. Both are evaluated
 * against `binding`, which already includes this element's own variable, so
 * `(n WHERE n.age > 30)` can reference `n`.
 */
/**
 * REJECTED LEVER — hoisting this `EvalEnv` out of the per-element call (audit item 454).
 *
 * The `{ binding, params, graph }` below is allocated on EVERY call, which in a walk that
 * filters per element is one object per element: `buildNodeCount`'s constrained tally allocates
 * 200,000 of them to count a filtered label bucket. It carries no state — the three fields are
 * the same references throughout a walk, nothing assigns to them, and nothing retains it past
 * the call — so a `satisfiesIn(element, pred, env)` taking a caller-owned env is trivially
 * sound, and was written and measured.
 *
 * It bought NOTHING. A filtered node count over 200,000 vertices, three rounds each side, one
 * case per process: one bound 4.4 / 6.4 / 4.4 ms before against 4.8 / 5.0 / 5.3 after, two bounds
 * 5.9 / 6.4 / 6.2 against 6.2 / 6.2 / 6.7, three bounds 8.9 / 7.3 / 7.1 against 7.2 / 7.5 / 7.5.
 * The spread WITHIN each configuration is larger than any difference between them. V8 escape-
 * analyses a short-lived object that never leaves the call, so there is no allocation to remove.
 *
 * Do not re-derive it: the reasoning is correct and the measurement is not. The per-element cost
 * here is the predicate evaluation, not the wrapper around it.
 */
export const satisfies = (
  element: Bound,
  pred: CPredicate,
  binding: Binding,
  params: Params,
  graph: Graph,
): boolean => {
  const env: EvalEnv = { binding, params, graph };

  for (const { key, value } of pred.props) {
    // Structural equality — the SAME notion `=` uses (`structuralEq`), so an
    // inline `{tags: [1, 2]}` constraint matches a stored list exactly as
    // `WHERE n.tags = [1, 2]` does. JS reference `!==` here made a list-valued
    // inline constraint never match (a fresh array is never `===` the stored one).
    if (!structuralEq(propOf(element, key), value(env))) {
      return false;
    }
  }

  // The same check for an inline `WHERE` that reduced to one equality (`directEqProps`). A separate
  // list rather than extra `props` entries, because `props` is what `indexCandidates` seeds from —
  // and because these carry EXPRESSION equality, not inline-property equality. That is the whole
  // difference between the two loops and it is item 210's "route two":
  //
  //   `{k: null}`        matches a stored null AND an absent key
  //   `WHERE n.k = null` matches NEITHER (`=` yields UNKNOWN, and a filter keeps only TRUE)
  //
  // `propOf` returns `null` for both an absent key and a stored null, so `structuralEq` alone
  // cannot tell them apart and gives the INLINE reading. Rejecting a null right-hand side here
  // gives the EXPRESSION reading instead, which is what lets a `$param` be lifted at all: its
  // value is unknown at compile time, and the only unsafe resolution is null.
  //
  // For every non-null right-hand side the two notions already agree, which is why only this one
  // guard is needed: a missing or stored-null property reads as `null`, `structuralEq(null, 2)` is
  // false, and `=` yields UNKNOWN — both reject the row.
  if (pred.eqProps !== undefined) {
    for (const { key, value } of pred.eqProps) {
      const rhs = value(env);

      if (rhs === null || rhs === undefined) {
        return false;
      }

      if (!structuralEq(propOf(element, key), rhs)) {
        return false;
      }
    }
  }

  // The ORDERING comparisons `eqProps` cannot carry, applied the same way: read the property
  // off the element and settle the row on anything that is not a clean TRUE. `compareTruth` is
  // the `compare` arm's own function, so UNKNOWN (a null operand, a cross-type ordering) drops
  // the row here exactly as it does there — a FILTER keeps only TRUE (item 259).
  if (pred.cmpProps !== undefined) {
    for (const { key, op, value } of pred.cmpProps) {
      if (compareTruth(op, COMPARE[op], propOf(element, key), value(env)) !== true) {
        return false;
      }
    }
  }

  return pred.where === undefined || asTruth(pred.where(env)) === true;
};

// Pattern matching (see executor/matching.ts).
import { matchNode } from './executor/matching.js';

// --- clause compilation ------------------------------------------------------

/** Every variable a pattern introduces (for OPTIONAL MATCH null-binding). */
const patternVars = (patterns: readonly PathPattern[]): string[] => {
  const vars: string[] = [];

  for (const p of patterns) {
    if (p.pathVar) {
      vars.push(p.pathVar);
    }

    if (p.start.variable) {
      vars.push(p.start.variable);
    }

    for (const seg of p.segments) {
      collectSegmentVars(seg, vars);
    }
  }

  return vars;
};

/** Collect every variable a pattern SEGMENT binds — including a quantified subpath's
 *  GROUP variables. The endpoint `rel`/`node` are direct bindings; a quantified subpath
 *  ALSO exposes its inner source/target and each inner hop as group (list) variables
 *  (`((x)-[e]->(y)){n}` → x, e, y), and a nested subpath recurses one list level deeper.
 *  Without this, `size(x)` / `x[i].prop` over a group variable failed the scope check
 *  ("variable not defined") even though the executor binds them (`bindGroupVars`). */
const collectSegmentVars = (seg: Segment, vars: string[]): void => {
  if (seg.rel.variable) {
    vars.push(seg.rel.variable);
  }

  if (seg.node.variable) {
    vars.push(seg.node.variable);
  }

  // A quantified subpath's inner source `(x)` and first target `(y`/`m)` are group vars.
  if (seg.hopFrom?.variable) {
    vars.push(seg.hopFrom.variable);
  }

  if (seg.hopTo?.variable) {
    vars.push(seg.hopTo.variable);
  }

  // Multi-element units: every further inner hop (its edge + landing node) is a group var.
  for (const rest of seg.unitRest ?? []) {
    collectSegmentVars(rest, vars);
  }

  // A nested parenthesized subpath exposes its inner variables as lists-of-lists.
  if (seg.nested) {
    collectSegmentVars(seg.nested, vars);
  }
};

// --- compile-time scope validation ------------------------------------------
// A reference to a variable that no clause has bound (in the scope at that point) is an
// ERROR, matching the native engine (which rejects it while parsing) and ISO GQL / Cypher
// ("variable not defined") — NOT a silent null (which would hide a typo'd name). Runs over
// the AST at compile time, so `compile(parse(q))` / `query(...)` faults identically
// regardless of row count.

const scopeError = (name: string): never => {
  throw new LenkeError(`variable \`${name}\` is not defined`, { code: ErrorCode.Syntax });
};

// The name a projection item publishes: its explicit alias, or — for a bare variable /
// property access — that variable / key; a complex unaliased item names nothing here.
const itemOutputName = (item: ReturnItem): string | undefined => {
  if (item.alias !== undefined) {
    return item.alias;
  }

  if (item.expr.kind === 'var') {
    return item.expr.name;
  }

  if (item.expr.kind === 'prop') {
    return item.expr.key;
  }

  return undefined;
};

// The output column names a projection publishes (the scope AFTER a `WITH`): `*` carries
// the incoming scope forward, plus each item's published name.
const projectionNames = (proj: Projection, incoming: ReadonlySet<string>): Set<string> => {
  const out = new Set<string>(proj.star ? incoming : []);

  for (const item of proj.items) {
    const name = itemOutputName(item);

    if (name !== undefined) {
      out.add(name);
    }
  }

  return out;
};

// A copy of `scope` with `extra` added.
const extendedScope = (scope: ReadonlySet<string>, extra: Iterable<string>): Set<string> => {
  const out = new Set(scope);

  for (const v of extra) {
    out.add(v);
  }

  return out;
};

// The direct sub-expressions of `expr` — the generic recursion for kinds that only
// CONTAIN expressions. The reference kinds (`var`/`prop`/…) and the scope-introducing
// kinds (subqueries, `letIn`) are handled explicitly in `checkExprScope`.
const childExprs = (expr: Expr): readonly Expr[] => {
  switch (expr.kind) {
    case 'list':
    case 'concat':
    case 'and':
    case 'or':
    case 'xor':
      return expr.items;
    case 'record':
      return expr.fields.map((f) => f.value);
    case 'func':
    case 'graphPred':
      return expr.args;
    case 'index':
      return [expr.base, expr.index];
    case 'field':
      return [expr.base];
    case 'neg':
    case 'not':
    case 'isNull':
    case 'isTruth':
    case 'isLabeled':
    case 'isTyped':
      return [expr.expr];
    case 'compare':
      return [expr.left, expr.right];
    case 'arith':
      return [expr.head, ...expr.tail.map(([, e]) => e)];
    case 'in':
      return [expr.expr, expr.list];
    case 'case':
      return [
        ...(expr.subject ? [expr.subject] : []),
        ...expr.whens.flatMap((w) => [w.when, w.then]),
        ...(expr.elseExpr ? [expr.elseExpr] : []),
      ];
    default:
      return [];
  }
};

// Throw on any variable / property reference in `expr` whose base name is not in `scope`.
// Sub-queries (`EXISTS`/`COUNT`/`VALUE {…}`) are correlated — the outer scope stays visible
// and their own pattern variables are added; `letIn` binds its locals for the body.
/**
 * Mark a subquery that reads any name bound AROUND it.
 *
 * Every name the body mentions is needed, not just its free ones: `freePredicateVars` counts a
 * body's own pattern variables as bound, so the correlated `COUNT { (u)-[:T]->(x) }` has no free
 * variables by that reckoning — `u` is a pattern variable there exactly as `x` is. Using the
 * free set alone treated correlated subqueries as constant and broke 90 tests at once.
 */
const markIfCorrelated = (
  expr: Extract<Expr, { kind: 'exists' | 'countSubquery' | 'valueSubquery' }>,
  scope: ReadonlySet<string>,
): void => {
  const mentioned = freePredicateVars(expr);

  for (const p of expr.patterns) {
    patternBoundVars(p, mentioned);
  }

  for (const name of mentioned) {
    if (scope.has(name)) {
      correlatedSubqueries.add(expr);

      return;
    }
  }
};

const checkExprScope = (expr: Expr, scope: ReadonlySet<string>): void => {
  switch (expr.kind) {
    case 'var':
      if (!scope.has(expr.name)) {
        scopeError(expr.name);
      }

      return;
    case 'prop':
    case 'property_exists':
      if (!scope.has(expr.variable)) {
        scopeError(expr.variable);
      }

      return;
    case 'exists':
    case 'countSubquery': {
      markIfCorrelated(expr, scope);

      const inner = extendedScope(scope, patternVars(expr.patterns));

      if (expr.where) {
        checkExprScope(expr.where, inner);
      }

      return;
    }
    case 'valueSubquery': {
      markIfCorrelated(expr, scope);

      const inner = extendedScope(scope, patternVars(expr.patterns));

      if (expr.where) {
        checkExprScope(expr.where, inner);
      }

      checkExprScope(expr.ret, inner);

      return;
    }
    case 'letIn': {
      const inner = new Set(scope);

      for (const b of expr.bindings) {
        checkExprScope(b.expr, inner);
        inner.add(b.var);
      }

      checkExprScope(expr.body, inner);

      return;
    }
    default:
      for (const child of childExprs(expr)) {
        checkExprScope(child, scope);
      }
  }
};

// Validate a projection's expressions; its HAVING / ORDER BY may also reference the
// projection's OUTPUT aliases (`RETURN a + b AS c ORDER BY c`), so those see `scope` plus
// the published names.
const checkProjection = (proj: Projection, scope: ReadonlySet<string>): void => {
  for (const item of proj.items) {
    checkExprScope(item.expr, scope);
  }

  if (proj.groupBy) {
    for (const g of proj.groupBy) {
      checkExprScope(g, scope);
    }
  }

  const withOut = new Set(scope);

  for (const n of projectionNames(proj, scope)) {
    withOut.add(n);
  }

  if (proj.having) {
    checkExprScope(proj.having, withOut);
  }

  if (proj.orderBy) {
    for (const s of proj.orderBy) {
      checkExprScope(s.expr, withOut);
    }
  }
};

// A write / call clause: validates its expressions and updates `scope` in place. Returns
// 'stop' when the rest of the linear part must NOT be scope-enforced — a subquery / bare
// CALL introduces output columns this pass cannot enumerate, so a later reference to one
// must not be a false positive.
const checkWriteClauseScope = (clause: Clause, scope: Set<string>): 'stop' | 'continue' => {
  switch (clause.kind) {
    case 'callInline':
      for (const part of clause.body.parts) {
        checkLinearScope(part.clauses, new Set(clause.scope));
      }

      return 'stop';
    case 'callNamed':
      for (const c of clause.config) {
        checkExprScope(c.value, scope);
      }

      if (!clause.yields) {
        return 'stop';
      }

      for (const y of clause.yields) {
        scope.add(y.alias ?? y.name);
      }

      return 'continue';
    case 'insert':
    case 'merge': {
      const pats = clause.kind === 'insert' ? clause.patterns : [clause.pattern];

      for (const v of patternVars(pats)) {
        scope.add(v);
      }

      return 'continue';
    }
    case 'set':
      for (const item of clause.items) {
        if (!scope.has(item.variable)) {
          scopeError(item.variable);
        }

        if ('value' in item) {
          checkExprScope(item.value, scope);
        }
      }

      return 'continue';
    case 'remove':
      for (const item of clause.items) {
        if (!scope.has(item.variable)) {
          scopeError(item.variable);
        }
      }

      return 'continue';
    case 'delete':
      for (const t of clause.targets) {
        checkExprScope(t, scope);
      }

      return 'continue';
    default:
      return 'continue';
  }
};

// Walk one linear query, evolving the bound-variable scope clause by clause, validating
// each clause's expressions against the scope visible to it.
const checkLinearScope = (clauses: readonly Clause[], initial: ReadonlySet<string>): void => {
  const scope = new Set(initial);

  for (const clause of clauses) {
    switch (clause.kind) {
      case 'match': {
        const withPat = new Set(scope);

        for (const v of patternVars(clause.patterns)) {
          withPat.add(v);
        }

        if (clause.where) {
          checkExprScope(clause.where, withPat);
        }

        for (const v of withPat) {
          scope.add(v);
        }

        break;
      }
      case 'for':
        checkExprScope(clause.list, scope);
        scope.add(clause.alias);

        if (clause.ordinality) {
          scope.add(clause.ordinality.var);
        }

        break;
      case 'let':
        for (const item of clause.items) {
          checkExprScope(item.expr, scope);
          scope.add(item.var);
        }

        break;
      case 'filter':
        checkExprScope(clause.where, scope);
        break;
      case 'with': {
        checkProjection(clause.projection, scope);
        const next = projectionNames(clause.projection, scope);

        if (clause.where) {
          checkExprScope(clause.where, next);
        }

        scope.clear();

        for (const v of next) {
          scope.add(v);
        }

        break;
      }
      case 'return':
        checkProjection(clause.projection, scope);
        break;
      case 'page':
        if (clause.orderBy) {
          for (const s of clause.orderBy) {
            checkExprScope(s.expr, scope);
          }
        }

        break;
      default:
        // Write / call clauses (and a subquery whose columns this pass can't enumerate).
        if (checkWriteClauseScope(clause, scope) === 'stop') {
          return;
        }
    }
  }
};

/** A compiled SET assignment: a label add, or a property set with a value closure. */
export type CSetItem =
  | { variable: string; label: string }
  | { variable: string; key: string; value: CompiledExpr };

/** A compiled INSERT node/rel: labels are fixed, property values are closures. */
export type CInsertNode = { variable?: string; labels: readonly string[]; props: readonly CProp[] };
type CInsertRel = {
  variable?: string;
  labels: readonly string[];
  direction: RelPattern['direction'];
  props: readonly CProp[];
};
type CInsertPath = {
  start: CInsertNode;
  segments: readonly { rel: CInsertRel; node: CInsertNode }[];
};

export type CMatch = {
  kind: 'match';
  optional: boolean;
  patterns: readonly CPath[];
  where?: CompiledExpr;
  nullVars: readonly string[];
  /**
   * What the whole clause BINDS, and which OUTER variables it READS — the
   * clause-level twin of `CPath`'s pair, and compile-time for the same reason
   * (`where` is a closure by the time the executor sees it).
   *
   * `reads` is the clause's patterns' reads plus its own `WHERE`'s free variables,
   * minus what the clause binds itself, so `MATCH (a:P) WHERE a.k = 1` reads
   * nothing outer. An EMPTY `reads` means the clause's matches cannot depend on
   * the incoming row's VALUES; see `runMatch` for why that is not sufficient on
   * its own.
   */
  binds: ReadonlySet<string>;
  reads: ReadonlySet<string>;
};
type CWith = { kind: 'with'; projection: CProjection; where?: CompiledExpr };
type CFilter = { kind: 'filter'; where: CompiledExpr };

/**
 * `ORDER BY … [OFFSET n] [LIMIT n]` as a STATEMENT — sort and/or slice the working
 * binding table in place. Distinct from a projection's trailing paging: there is
 * no projection here, so the sort keys read the binding scope directly and a later
 * RETURN only ever projects the surviving rows.
 */
type CPage = {
  kind: 'page';
  orderBy: readonly CSortItem[];
  skip?: CountValue;
  limit?: CountValue;
};
type CLet = { kind: 'let'; items: readonly { var: string; expr: CompiledExpr }[] };
export type CFor = {
  kind: 'for';
  list: CompiledExpr;
  alias: string;
  ordinality?: { kind: 'ordinality' | 'offset'; var: string };
};
type CReturn = { kind: 'return'; projection: CProjection };
export type CInsert = { kind: 'insert'; patterns: readonly CInsertPath[] };
type CMergeUpdate =
  | { kind: 'set'; items: readonly CSetItem[]; where?: CompiledExpr }
  | { kind: 'nothing' };
export type CMerge = {
  kind: 'merge';
  pattern: CInsertPath;
  onCreate?: readonly CSetItem[];
  onUpdate?: CMergeUpdate;
};
export type CSet = { kind: 'set'; items: readonly CSetItem[] };
export type CRemove = { kind: 'remove'; items: readonly RemoveItem[] };
export type CDelete = { kind: 'delete'; detach: boolean; targets: readonly CompiledExpr[] };
type CFinish = { kind: 'finish' };
export type CCallNamed = {
  kind: 'callNamed';
  optional: boolean;
  procName: string;
  /** Resolved algorithm dispatch name; `null` = unknown procedure (faults). */
  algo: AlgorithmName | null;
  config: readonly { key: string; value: CompiledExpr }[];
  /** Procedure output column → the variable it yields into. */
  binds: readonly { column: string; var: string }[];
};
export type CCallInline = {
  kind: 'callInline';
  optional: boolean;
  scope: readonly string[];
  body: CLinear;
  /**
   * Additional set-op parts (`… UNION/EXCEPT/INTERSECT …`) after the first. Empty
   * for a plain single-part body; each part shares the same imported scope and
   * yields the same columns, folded with `combineRows`.
   */
  bodyMore: readonly { op: SetOp; part: CLinear }[];
  /** Output columns of the nested RETURN (for OPTIONAL null-fill). */
  returnColumns: readonly string[];
};
export type CClause =
  | CMatch
  | CWith
  | CFilter
  | CPage
  | CLet
  | CFor
  | CReturn
  | CInsert
  | CMerge
  | CSet
  | CRemove
  | CCallNamed
  | CCallInline
  | CDelete
  | CFinish;

// Labels to CREATE for an INSERT element. A non-conjunction label expression
// (`A|B`, `!A`, `%`) is ambiguous — reject it rather than silently create an
// unlabelled node (an unlabelled node — no expression — stays legitimate).
// Mirrors the Rust `creatable_labels`. (A typeless edge's empty `[]` is caught
// downstream by `Graph.addEdge`, which requires ≥1 label.)
const creatableLabels = (expr: LabelExpr | undefined): string[] => {
  if (!expr) {
    return [];
  }

  if (expr.kind === 'label') {
    return [expr.name];
  }

  if (expr.kind === 'and') {
    return [...creatableLabels(expr.left), ...creatableLabels(expr.right)];
  }

  throw new LenkeError(
    "INSERT: a node's label expression must be a plain conjunction (`A` or `A&B`) and an edge must carry exactly one type — a disjunction/negation/wildcard is not creatable",
    { code: ErrorCode.InvalidGraphOp },
  );
};

const compileInsertNode = (node: NodePattern): CInsertNode => ({
  variable: node.variable,
  labels: creatableLabels(node.label),
  props: compileProps(node.properties),
});

const compileInsertPath = (pattern: PathPattern): CInsertPath => ({
  start: compileInsertNode(pattern.start),
  segments: pattern.segments.map(({ rel, node }) => ({
    rel: {
      variable: rel.variable,
      labels: creatableLabels(rel.label),
      direction: rel.direction,
      props: compileProps(rel.properties),
    },
    node: compileInsertNode(node),
  })),
});

const compileSetItem = (item: SetItem): CSetItem =>
  'label' in item
    ? { variable: item.variable, label: item.label }
    : { variable: item.variable, key: item.key, value: compileExpr(item.value) };

/**
 * Move a single-node MATCH's clause `WHERE` into the node pattern itself.
 *
 * `matchClauseBindings` applies a clause `WHERE` as a POST-FILTER over the binding
 * stream, so it builds a binding for every vertex and then throws most of them
 * away; an inline predicate is applied by `matchNode` DURING the scan and rejects
 * before a binding exists. Measured on 20,000 vertices (audit item 126, found by
 * the TS spelling probe): `MATCH (n:P) WHERE n.k = 2 RETURN count(*)` 11.85ms
 * against the identical `MATCH (n:P WHERE n.k = 2)` at 4.08ms — 2.9x for one
 * question spelled two ways.
 *
 * ONLY a pattern with NO segments, and that restriction is measured, not
 * conservatism for its own sake. The same probe shows the relationship REVERSED on
 * a hop's start node: `(a:P)-[:E]->(b) WHERE a.k = 2` is 3.11ms and the inline
 * spellings are 5.20-5.26, so pushing there would make a hop 1.7x SLOWER. Which
 * form wins is a plan-choice question per shape (the same distinction item 125
 * drew between a seedable start and a non-seedable far endpoint), not a general
 * rule.
 *
 * Byte-identical by construction: the result is literally the inline spelling, and
 * for a single-node pattern the bindings are 1:1 with the scanned vertices, so the
 * predicate is evaluated exactly once per vertex either way — same rows, and the
 * same row raises. OPTIONAL is excluded because its clause `WHERE` must see the
 * null-filled row.
 *
 * That 1:1 argument is why a SUBQUERY conjunct is held back (see the split below):
 * it is still evaluated once per vertex, but "once per vertex" is the whole cost
 * rather than a rounding error. Holding it back is also the one place this function
 * changes which row raises, and it changes it TOWARD native — measured directly,
 * with a faulting `EXISTS` body and a start predicate nothing matches:
 *
 *   MATCH (u:User) WHERE u.name = $n AND EXISTS { … (1.0 / 0.0) … }   TS raised / native []
 *   MATCH (u:User {name: $n}) WHERE EXISTS { … (1.0 / 0.0) … }        TS []     / native []
 *
 * so TS's own inline spelling already agreed with native and the conjunction form
 * was the outlier. The sibling case with a NON-subquery faulting conjunct still
 * raises in TS and not in native; that one is untouched here and stays recorded as
 * `and-chain-seeding-divergence` (audit item 115), because it needs a decision about
 * seeding, not a filter-placement fix.
 */
/** The three `Expr` variants that run a correlated sub-pattern per outer row. */
const SUBQUERY_KINDS: ReadonlySet<string> = new Set(['exists', 'countSubquery', 'valueSubquery']);

/**
 * Does this expression run a correlated subquery anywhere inside it?
 *
 * A GENERIC structural walk rather than a per-variant match, and deliberately so:
 * `Expr` is a wide union, and a walk that enumerated its arms would silently answer
 * "no subquery" for any arm added later — the failure direction that costs
 * `pushWhereIntoNode` below its whole reason to be careful. Object traversal cannot
 * miss one. It runs once per query compile over a predicate-sized AST.
 */
const hasSubquery = (node: unknown): boolean => {
  if (node === null || typeof node !== 'object') {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some(hasSubquery);
  }

  const rec = node as Record<string, unknown>;

  if (typeof rec.kind === 'string' && SUBQUERY_KINDS.has(rec.kind)) {
    return true;
  }

  return Object.values(rec).some(hasSubquery);
};

/** `a AND b AND …` for two or more, the expression itself for one, nothing for none. */
const conjoin = (items: readonly Expr[]): Expr | undefined => {
  if (items.length === 0) {
    return undefined;
  }

  if (items.length === 1) {
    return items[0];
  }

  return { kind: 'and', items };
};

/**
 * Attribute a MULTI-PATTERN clause's `WHERE` conjuncts to the patterns they constrain, so the
 * comma spelling of a question plans like its `MATCH … MATCH …` twin.
 *
 * ### Only a conjunct reading ONE of the clause's own pattern variables moves
 *
 * That restriction is what makes this independent of MATCH ORDER, and the order is genuinely
 * not knowable here: `matchClauseBindings` hands a multi-pattern clause to `visitRemaining`,
 * which picks which pattern to visit next (item 122's uncorrelated-rescan fix). So a conjunct
 * reading TWO of the clause's patterns — `WHERE b.k = a.k` — cannot be pushed onto either: if
 * the other pattern is visited second its variable is unbound, the comparison is UNKNOWN, and
 * the row silently disappears. A conjunct reading ONE pattern plus OUTER variables is safe for
 * the reason the single-pattern case already relies on: outer variables are in the incoming
 * binding before the clause starts, whatever order the patterns are then visited in.
 *
 * So `WHERE b.k = a.k` over two patterns of one clause stays a clause filter and keeps its
 * 3.4x against the two-clause spelling — recorded rather than fixed, because fixing it means
 * pinning the visit order (item 285).
 *
 * A pattern only receives a conjunct if it is a bare single node with a variable, the same
 * precondition the single-pattern path checks: a predicate on a HOP is NOT equivalent in the
 * node position (see `liftHopWhereToSeedFilter`, which exists because moving it changes which
 * queries raise).
 */
const pushWhereAcrossPatterns = (
  clause: Extract<Clause, { kind: 'match' }>,
  where: Expr,
): typeof clause => {
  const conjuncts: readonly Expr[] = where.kind === 'and' ? where.items : [where];
  const own = new Set(patternVars(clause.patterns));
  // Which pattern each conjunct lands on, by index; `undefined` keeps it as the clause filter.
  const landed: (number | undefined)[] = conjuncts.map((c) => {
    if (hasSubquery(c)) {
      return undefined;
    }

    const touched = [...freePredicateVars(c)].filter((n) => own.has(n));

    if (touched.length !== 1) {
      return undefined; // zero (a constant, or only outer reads) or a correlation
    }

    const [name] = touched;
    const i = clause.patterns.findIndex((p) => p.start.variable === name);
    const p = i < 0 ? undefined : clause.patterns[i];

    // Both guards MIRROR the single-pattern path's below (`segments.length > 0 || pathVar !==
    // undefined` declines there). The `segments` one is load-bearing and tested — a predicate
    // on a hop's start is not equivalent to one in the clause, because it changes which
    // queries raise. The `pathVar` one is INHERITED: mutation removed it here (M3) and removed
    // the single-pattern path's copy (M9), and both SURVIVED the whole suite, so no test
    // anywhere observes it. Kept anyway — a guard whose necessity is unproven is not a guard
    // shown to be unnecessary, and the path-value semantics it would open were never the
    // target (item 285).
    return p?.segments.length === 0 && p.pathVar === undefined ? i : undefined;
  });

  if (landed.every((i) => i === undefined)) {
    return clause;
  }

  const patterns = clause.patterns.map((p, i) => {
    const mine = conjuncts.filter((_, ci) => landed[ci] === i);

    if (mine.length === 0) {
      return p;
    }

    const all = p.start.where === undefined ? mine : [p.start.where, ...mine];
    const merged: Expr = all.length === 1 ? all[0] : { kind: 'and', items: all };

    return { ...p, start: { ...p.start, where: merged } };
  });

  const residual = conjoin(conjuncts.filter((_, ci) => landed[ci] === undefined));
  const { where: _dropped, ...rest } = clause;

  return {
    ...rest,
    ...(residual === undefined ? {} : { where: residual }),
    patterns,
  };
};

const pushWhereIntoNode = (clause: Extract<Clause, { kind: 'match' }>): typeof clause => {
  const { where } = clause;

  if (where === undefined || clause.optional) {
    return clause;
  }

  // A MULTI-PATTERN clause attributes its conjuncts instead, which is where the 15.8x was.
  // This used to decline on `patterns.length !== 1`, so the comma spelling of a question kept
  // its predicate as a clause filter while the `MATCH … MATCH …` spelling pushed it into the
  // node. Measured at 4 x 100,000 on the SAME question and the same 4 rows:
  //
  //   MATCH (a:A) MATCH (b:B) WHERE b.k = 7 RETURN a.k     9.193 ms
  //   MATCH (a:A), (b:B)      WHERE b.k = 7 RETURN a.k   145.039 ms
  //
  // The comment below already explains why: a node predicate is evaluated once per SCANNED
  // vertex, a clause filter once per SURVIVING BINDING — and for a product that is a binding
  // `Map` materialized per product row before anything filters it (item 285).
  if (clause.patterns.length > 1) {
    return pushWhereAcrossPatterns(clause, where);
  }

  const [path] = clause.patterns;
  const name = path.start.variable;

  if (path.segments.length > 0 || name === undefined || path.pathVar !== undefined) {
    return clause;
  }

  // The predicate's free variables are NOT restricted, and that is deliberate.
  // Item 127 required it to be closed; mutation showed that guard was not
  // load-bearing, because `matchNode` evaluates a node predicate against the
  // INCOMING binding, which already holds every earlier clause's variables — so an
  // outer reference resolves in the pattern exactly as it did in the clause
  // filter. Measured on the shape it unlocks (item 128):
  //
  //   MATCH (z:P {k: 3}) MATCH (n:P) WHERE n.j = z.j   2217.1ms -> 1537.7ms
  //
  // both answering 1142857. The evaluation COUNT is unchanged either way: a
  // single-node pattern's bindings are 1:1 with the vertices it scans, so the
  // predicate runs once per vertex per incoming row in both spellings.
  // AND with any predicate the node already carries, so the inline spelling of a
  // query that had both is unchanged.
  //
  // Only the subquery-FREE conjuncts move, and the rest stay as the clause filter.
  // A node predicate is evaluated once per SCANNED vertex; a clause filter once per
  // SURVIVING binding. For an ordinary comparison those are the same count and the
  // merge is free, but a conjunct carrying `EXISTS {…}` / `COUNT {…}` / `VALUE {…}`
  // runs a correlated sub-pattern each time, so pushing it costs one subquery per
  // vertex in the label. A cheap conjunct beside it DOES now gate it: the merged predicate
  // compiles through `filterPredicate`, which exits at the first conjunct that is not cleanly
  // TRUE — so the subquery is reached only for an element the cheap conjunct accepted. (This
  // comment said the opposite until 2026-10-09, and was right when written: the evaluator
  // short-circuited nothing, and `operator-chains.test.ts` pinned that as a byte-identity
  // contract.) What the split still buys is the SEEK, which ordering cannot substitute for.
  // Measured on 20,000 users with a FOLLOWS ring (audit item 174):
  //
  //   MATCH (u:User) WHERE u.name = $n AND EXISTS { (u)-[:FOLLOWS]->{2,4}(u) }   265.48ms
  //   MATCH (u:User {name: $n}) WHERE EXISTS { (u)-[:FOLLOWS]->{2,4}(u) }           2.38ms
  //
  // 111x for one question spelled two ways, which is the bug class this engine is
  // named after. Splitting makes the first spelling plan as the second.
  const conjuncts: readonly Expr[] = where.kind === 'and' ? where.items : [where];
  const pushable = conjuncts.filter((c) => !hasSubquery(c));

  if (pushable.length === 0) {
    return clause;
  }

  const kept = conjuncts.filter(hasSubquery);
  const all = path.start.where === undefined ? pushable : [path.start.where, ...pushable];
  const merged: Expr = all.length === 1 ? all[0] : { kind: 'and', items: all };
  const residual = conjoin(kept);
  const { where: _dropped, ...rest } = clause;

  return {
    ...rest,
    ...(residual === undefined ? {} : { where: residual }),
    patterns: [{ ...path, start: { ...path.start, where: merged } }],
  };
};

/**
 * Lift a hop's clause `WHERE` into a fault-swallowing SEED FILTER, so a start vertex the
 * predicate rejects is never expanded.
 *
 * `pushWhereIntoNode` above does the same job for a pattern with NO segments by moving the
 * predicate into the node, which is exact there. **That is not available for a hop**, and the
 * reason is not conservatism: the two spellings genuinely differ. A clause `WHERE` is evaluated
 * once per ROW and so NOT AT ALL for a start vertex with no edges; an inline predicate is
 * evaluated once per VERTEX. Both engines agree on that today —
 *
 *   MATCH (u:U)-[:E]->(v) WHERE CAST(u.st AS INTEGER) >= 1      rows, no fault
 *   MATCH (u:U WHERE CAST(u.st AS INTEGER) >= 1)-[:E]->(v)      RAISES
 *
 * — with `u`'s faulting vertex edgeless. So moving the predicate would change which queries
 * raise, in both engines' view. Hence a filter that SWALLOWS a fault and keeps the seed:
 *
 *   cleanly TRUE   seed kept; the clause `WHERE` re-decides per row, identically.
 *   cleanly FALSE  seed skipped. Every row it would have produced is a row the clause
 *                  `WHERE` would have dropped, so the result is unchanged — and no OTHER
 *                  conjunct can fault on those rows, because of the `freePredicateVars`
 *                  restriction below.
 *   FAULTED        seed kept, and the clause `WHERE` faults per row exactly as before. If the
 *                  vertex has no edges there are no rows and no fault — which is today's
 *                  behaviour, and the whole reason the fault is swallowed here.
 *
 * **The whole `WHERE` must read nothing but the start variable.** That is what makes the
 * cleanly-FALSE case safe: were another conjunct present, skipping the seed could suppress a
 * fault that conjunct raises on a row TS currently evaluates (`FALSE AND <data exception>`
 * raises in this engine — an open divergence, not something to quietly change here).
 *
 * Measured, 20,000 vertices, `(a:P)-[:E]->(b) WHERE a.k = <v>` against the inline spelling,
 * which is the bound this reaches for:
 *
 *   deg  selectivity   clause   inline   inline/clause
 *     1  1 of N        17.761    2.782      0.16x
 *     1  1%            17.557    2.289      0.13x
 *     1  50%           22.158   11.401      0.51x
 *     1  100%          21.401   19.576      0.91x
 *     5  1 of N        43.730    2.838      0.06x
 *     5  1%            42.321    3.050      0.07x
 *     5  50%           55.753   33.171      0.59x
 *     5  100%          71.040   63.452      0.89x
 *
 * Faster at every degree and every selectivity, and never slower — at worst equal, when the
 * predicate rejects nothing. `pushWhereIntoNode`'s comment claims the opposite ("pushing there
 * would make a hop 1.7x SLOWER", from 3.11ms against 5.20-5.26). That measurement does not
 * reproduce, and the reason it once held is gone: it was taken on a COUNT shape, where the
 * inline spelling made `plainNode` DECLINE the count shortcut (audit item 124) — a defect fixed
 * in item 125. The same comparison now reads 3.207 clause against 2.248 inline. See item 154.
 */
/**
 * Compile a seed gate that evaluates the SUBQUERY-FREE conjuncts first and stops at the first
 * one that is not cleanly TRUE.
 *
 * The gate's only output is keep/skip, and it keeps only on a clean TRUE (`seedGate` in
 * `executor/matching.ts`), so "stop at the first non-TRUE" is the gate's own semantics rather
 * than a reordering of `AND`: a three-valued conjunction is TRUE only when every conjunct is.
 * What the order buys is that a `EXISTS {…}` / `COUNT {…}` / `VALUE {…}` conjunct — which runs a
 * correlated sub-pattern per START VERTEX here, and runs AGAIN per surviving row in the clause
 * `WHERE`, since this is a prefilter and does not replace it — is not reached for a vertex a
 * cheap conjunct already rejected. Measured on 20,000 users at degree 2:
 *
 *   MATCH (u:User)-[:FOLLOWS]->(w) WHERE u.name = $n AND EXISTS { (u)-[:FOLLOWS]->{2,4}(u) }
 *
 * ran 302.01ms against 2.83ms for the inline-anchor spelling — 107x, the hop twin of item 174.
 *
 * It is NOT free, and the cost is which row raises. Today a cleanly-FALSE cheap conjunct beside
 * a FAULTING subquery propagates that fault, `seedGate` swallows it and KEEPS the seed, and the
 * clause `WHERE` then raises per row. Skipping the seed instead stops that raise — and both
 * cases it changes were already TS-vs-native divergences, measured on this shape:
 *
 *   selected vertex              TS before   TS after   native
 *   none matches the cheap one   raises      []         []
 *   a NON-faulting vertex        raises      1 row      1 row
 *   the FAULTING vertex itself   raises      raises     raises
 *
 * The middle row is the one worth naming: TS raised while native returned a NON-EMPTY result,
 * because an unrelated vertex's subquery faulted and the swallow pushed it into the clause
 * `WHERE`. The divergence registry's single entry deliberately does not cover an error against a
 * non-empty result, so that case was uncovered. Both now match native.
 *
 * The alternative — holding the subquery conjunct out of the prefilter altogether — was priced
 * and rejected: a vertex the cheap conjunct accepts but the subquery rejects would pay `degree`
 * clause evaluations in place of one prefilter evaluation, a regression by a factor of the degree
 * on a non-selective cheap conjunct. Ordering costs that shape nothing, because a conjunct that
 * is always TRUE never short-circuits anything.
 */
export const gatePredicate = (where: Expr): CompiledExpr => {
  const conjuncts: readonly Expr[] = where.kind === 'and' ? where.items : [where];
  const cheap = conjuncts.filter((c) => !hasSubquery(c));
  const costly = conjuncts.filter(hasSubquery);

  // Nothing to order: no subquery to defer, or nothing cheap to defer it behind.
  if (cheap.length === 0 || costly.length === 0) {
    return compileExpr(where);
  }

  const parts = [...cheap, ...costly].map(compileExpr);

  return (env) => {
    for (const part of parts) {
      // A fault propagates, exactly as it does today — `seedGate` catches it and keeps the seed.
      if (asTruth(part(env)) !== true) {
        return false;
      }
    }

    return true;
  };
};

/**
 * Every conjunct of an `AND`, flattened RECURSIVELY.
 *
 * The engine's `filter_conjuncts_reordered` flattens its binary `And` tree all the way down, and
 * the two have to agree on what the conjuncts ARE before they can agree on their order. A
 * same-operator run folds into one n-ary `and` in this AST, but a parenthesized group does not —
 * `(A AND B) AND (C AND D)` arrives as two items where the engine sees four. Taking only the top
 * level left the differential fuzzer finding shapes like
 * `FILTER ((n.n > 4 AND VALUE {…}) AND ((n.m.k < 3) AND (n.n = n.x)))`, where the engine could
 * hoist a safe conjunct out of the second group and this engine could not.
 *
 * Module scope, not a closure inside `filterPredicate`: it captures nothing, and a function
 * defined inside a returned closure's builder is a shape this engine has been bitten by
 * (`ts-closure-size-is-load-bearing`). The linter asks for the same thing.
 */
const flattenConjuncts = (e: Expr): readonly Expr[] =>
  e.kind === 'and' ? e.items.flatMap(flattenConjuncts) : [e];

/**
 * Whether an `AND` holds BOTH a conjunct that cannot raise and one that can — the only case
 * {@link filterPredicate} reorders — decided WITHOUT ALLOCATING. Returns a bitmask: 1 = saw one
 * that cannot raise, 2 = saw one that can, so `3` is mixed.
 *
 * Allocation-free is the whole point, and it was measured. Deciding this with
 * `flattenConjuncts` plus two `.filter` passes cost a real **1.7x** on two spellings in
 * `bun run spelling` — `MATCH (n:P WHERE n.k = 2 AND n.s = 's1')` and
 * `MATCH (n:P) WHERE 2 = n.k AND 's1' = n.s` went from ~4.3ms to ~7.2ms at SPELL_N=200000, where
 * a door-shut build measured 4.24/4.37 exactly as HEAD did. They are the two spellings of that
 * group whose predicate reaches here as a MULTI-CONJUNCT `AND` — the others have their
 * equalities lifted into `props`/`eqProps` first, or arrive with a single conjunct — which is
 * also what makes them the ones that pay: **this runs per EXECUTION for those shapes, not once
 * per plan**, so anything allocated on the decline path is on the hot path. The engine's
 * `filter_conjuncts_reordered` is allocation-free on its decline path for the same reason; this
 * was not, which is the inconsistency the probe caught.
 */
const conjunctMix = (e: Expr): number => {
  if (e.kind !== 'and') {
    return truthCannotRaise(e) ? 1 : 2;
  }

  let acc = 0;

  for (const it of e.items) {
    acc |= conjunctMix(it);
  }

  return acc;
};

/**
 * Whether evaluating `e` to a VALUE cannot raise. A deliberately tiny whitelist: a lookup or a
 * literal reads something that is already there, and a missing property is null rather than a
 * fault. Everything else — arithmetic (`1.0 / 0.0`), a `CAST`, any function, a subquery, a list
 * or record constructor — is assumed to raise, because a false negative here only forgoes a
 * reorder while a false positive would move a raise.
 */
const valueCannotRaise = (e: Expr): boolean =>
  e.kind === 'lit' ||
  e.kind === 'param' ||
  e.kind === 'var' ||
  e.kind === 'prop' ||
  e.kind === 'property_exists' ||
  e.kind === 'isLabeled' ||
  // A NEGATED NUMERIC LITERAL, because `-1` is one of these here and a folded `Lit(Num(-1.0))`
  // in the engine, where `Lit` is operand-safe. Without this arm the two engines partition
  // `n.x > -1` differently and the one that calls it unsafe reaches a raising sibling the other
  // skips — four of the five divergences left in a 20,000-query differential run after the
  // comparison arm was widened, all of them this. Only a numeric LITERAL: `-n.s` negates a
  // string and faults, which is why this is not `neg` of anything value-safe.
  (e.kind === 'neg' && e.expr.kind === 'lit' && typeof e.expr.value === 'number');

/**
 * Whether evaluating `e` as a TRUTH VALUE cannot raise — the question a conjunct of a filter
 * poses, which is stricter than {@link valueCannotRaise} because the coercion itself can fault:
 * a bare `n.s` holding a string is the whole shape this exists to recognize as UNSAFE.
 *
 * EVERY comparison operator is included — see the `compare` arm for why the cautious reading was
 * wrong and cost 41 divergences.
 *
 * `isTruth` was ALSO left out, on the same cautious ground, with the comment claiming "a
 * conservative omission costs only a missed reorder". **That claim is false and item 322 is the
 * bill**: the engine's `can_raise` admits the node, so a narrower key here is not caution, it is
 * disagreement — `WHERE <raising> AND (t.s IS UNKNOWN)` raised in this engine and answered no
 * rows in the engine, which the differential fuzzer hit on roughly one random seed in three. The
 * tell was that `IS NULL`, the arm below, already AGREED on the identical shape.
 *
 * `isTyped` and `isLabeled` stay out, and that is now MEASURED rather than assumed: with a
 * raising sibling written first, `IS TYPED INTEGER` raises in BOTH engines (it lowers to a cast,
 * which the engine's `can_raise` calls raising) and `IS LABELED` raises in both for a different
 * reason — it is TRUE here, so it settles nothing and the sibling is essential either way.
 * Admitting them would be the mirror-image mistake.
 */
const truthCannotRaise = (e: Expr): boolean => {
  switch (e.kind) {
    case 'lit':
      // A non-boolean literal in a truth position is a fault — and a statically detectable
      // one, so `validateBoolContexts` has already rejected it before this runs. Tested
      // anyway: this helper must be sound on its own, not because of a caller.
      return typeof e.value === 'boolean' || e.value === null;
    case 'property_exists':
      return true;
    case 'isLabeled':
      return true;
    case 'isNull':
      return valueCannotRaise(e.expr);
    case 'isTruth':
      // ONLY the `IS [NOT] UNKNOWN` form (`truth === null`), because that is the only one the
      // engine's key admits — and the ordering key has to be the SAME key, in BOTH directions.
      // A first version of this arm returned `valueCannotRaise(e.expr)` for all three truth
      // values and introduced TWO NEW divergences the other way round: `WHERE <raising> AND
      // (n.n IS TRUE)` then answered no rows HERE while the engine still raised. Being wider in
      // one engine is the same mistake as being narrower, which is why the expectations in
      // `and-short-circuit-conformance.test.ts` were measured rather than reasoned out.
      //
      // `IS UNKNOWN` INSPECTS its operand instead of coercing it, so the question is
      // VALUE-safety, not truth-safety — the same recursion `isNull` uses, which is exactly why
      // `IS NULL` agreed on the shape `IS UNKNOWN` diverged on. Measured on both engines:
      // `t.s IS UNKNOWN` with a STRING `t.s` is `false` rather than a fault, while the OPERAND
      // can still raise (`split('a,b', -1) IS UNKNOWN` raises in both), which is what
      // `valueCannotRaise` tests. `negated` is irrelevant: `NOT` of a non-raising test is
      // non-raising.
      return e.truth === null && valueCannotRaise(e.expr);
    case 'compare':
      // EVERY operator, not just `=` and `<>`. A first version restricted it to the two that
      // cannot fault on a cross-type pair (`cross-type-comparison-no-error`: `=` is a no-match
      // where `<=` throws), which is the more cautious reading and was WRONG — the engine's
      // `narrowing_is_transparent` admits any operator, so the two engines partitioned
      // differently and the differential fuzzer found 41 divergences in one 20,000-query run,
      // all of them TS raising where the engine answered no rows. The ordering key has to be
      // the SAME key on both sides or the reorder is not shared; being conservative in one
      // engine is not safety, it is disagreement. (And it costs nothing in raises: hoisting a
      // comparison that CAN fault makes it run earlier, never makes a skipped fault appear.)
      return valueCannotRaise(e.left) && valueCannotRaise(e.right);
    case 'not':
      return truthCannotRaise(e.expr);
    case 'and':
    case 'or':
    case 'xor':
      return e.items.every(truthCannotRaise);
    default:
      return false;
  }
};

/**
 * Compile a predicate in FILTER position — a clause `WHERE`, a `FILTER`, a `HAVING` — where the
 * only question asked of the predicate is keep/skip and a row is kept only on a clean TRUE
 * (ISO §14.6; every call site reads `asTruth(pred(env)) === true`).
 *
 * That contract buys two things, and NEITHER is a reordering of what `AND` evaluates to:
 *
 *  1. **Any conjunct that is not cleanly TRUE settles the row, UNKNOWN included.** This is
 *     strictly stronger than `compileExpr`'s `and` arm, which must produce the conjunction's
 *     VALUE and so can only settle on FALSE — `and(null, false)` is `false`, so an UNKNOWN
 *     conjunct cannot settle a Kleene `AND`. Here it can, because an UNKNOWN row is dropped
 *     whatever its siblings say. The test is `!== true`, not `=== false`.
 *  2. **Conjunct ORDER is therefore unobservable**, which is what lets the conjuncts that
 *     cannot raise go first. In a value position that reordering is a real choice with a real
 *     cost (it answered `false` for `RETURN (0 AND (1 IS NULL))` where the engine raised, one
 *     of 5 divergences the differential fuzzer found); here it cannot change the row set at
 *     all, only whether a row the filter has already lost pays for a fault.
 *
 * So `WHERE <raising> AND <seekable>` keeps its rows instead of raising, and no exception is
 * constructed on the way — which is the cheapest possible answer rather than a cheaper throw
 * (user, 2026-10-09). The engine reaches the same outcome by a different mechanism: its filter
 * narrows a mask batch-wise in `filter_keep`, where this exits early per row. Same algorithm,
 * different mechanics, same answer.
 *
 * NOT TAKEN when every conjunct is safe. The semantics then cannot differ — nothing can raise,
 * so there is nothing to skip — and leaving `compileExpr` to it keeps the ordinary filter on
 * exactly the closure it has today, which on this engine is load-bearing
 * (`ts-closure-size-is-load-bearing`).
 */
const filterPredicate = (where: Expr): CompiledExpr => {
  // DECLINE WITHOUT ALLOCATING — see `conjunctMix`, and the 1.7x that measured why. Nothing can
  // raise, or nothing cannot: in the first case this path is unobservable, in the second there is
  // no safe conjunct to put in front and the early exit is all that is left, which
  // `compileExpr`'s `and` arm already does for the FALSE half.
  if (where.kind !== 'and' || conjunctMix(where) !== 3) {
    return compileExpr(where);
  }

  const conjuncts = flattenConjuncts(where);
  const safe = conjuncts.filter(truthCannotRaise);
  const parts = [...safe, ...conjuncts.filter((c) => !truthCannotRaise(c))].map(compileExpr);

  return (env) => {
    for (const part of parts) {
      // `!== true` — see (1). A row that is FALSE or UNKNOWN on any conjunct is already lost,
      // so the remaining conjuncts are an inessential part of the search condition and are
      // not evaluated.
      if (asTruth(part(env)) !== true) {
        return false;
      }
    }

    return true;
  };
};

const seedPrefilter = (
  clause: Extract<Clause, { kind: 'match' }>,
): { readonly var: string; readonly pred: CompiledExpr } | undefined => {
  const { where } = clause;

  // OPTIONAL is excluded for the same reason it is above: its clause `WHERE` must see the
  // null-filled row, so a seed it rejects is not a row that disappears.
  if (where === undefined || clause.optional || clause.patterns.length !== 1) {
    return undefined;
  }

  const [path] = clause.patterns;
  const name = path.start.variable;

  // No segments is `pushWhereIntoNode`'s case, which is exact and strictly better there.
  if (path.segments.length === 0 || name === undefined) {
    return undefined;
  }

  for (const free of freePredicateVars(where)) {
    if (free !== name) {
      return undefined;
    }
  }

  return { var: name, pred: gatePredicate(where) };
};

const compileClause = (rawClause: Clause): CClause => {
  const clause = rawClause.kind === 'match' ? pushWhereIntoNode(rawClause) : rawClause;

  switch (clause.kind) {
    case 'match': {
      const patterns = clause.patterns.map(compilePath);
      // A hop whose clause WHERE constrains only the start: skip the seeds it rejects
      // instead of expanding every one of them and filtering the rows (see `seedPrefilter`).
      const prefilter = seedPrefilter(clause);

      if (prefilter !== undefined) {
        patterns[0] = { ...patterns[0], prefilter };
      }

      // Lift seekable conjuncts of the clause WHERE onto every pattern node by
      // variable — not just the start — so either end of a pattern can be the
      // seed side. `MATCH (a:Person) WHERE a.name = 'marko'` then seeds like the
      // inline `(a:Person {name: 'marko'})` form, and a constraint on the far
      // end lets `orient` start the walk from there.
      if (clause.where) {
        const hints: HintMap = new Map();
        collectHints(clause.where, hints);
        const attach = (node: CNode): CNode => {
          const extra = node.variable ? hints.get(node.variable) : undefined;

          return extra
            ? { ...node, seedHints: coalesceRangeHints([...(node.seedHints ?? []), ...extra]) }
            : node;
        };

        for (let i = 0; i < patterns.length; i++) {
          patterns[i] = {
            ...patterns[i],
            start: attach(patterns[i].start),
            // SPREAD, not a rebuild. `CSegment` also carries `unit` — the compiled
            // repetition unit a quantified subpath walks — and listing the fields here
            // dropped it, so `walkSegments` never called `bindGroupVars` and every group
            // binding read as NULL. Only when the clause had a WHERE, which is what made it
            // look like a scoping rule rather than a lost field (item 571).
            segments: patterns[i].segments.map((s) => ({ ...s, node: attach(s.node) })),
          };
        }
      }

      return {
        kind: 'match',
        optional: clause.optional,
        patterns,
        where: clause.where ? filterPredicate(clause.where) : undefined,
        nullVars: clause.optional ? patternVars(clause.patterns) : [],
        ...matchVarSets(clause.patterns, clause.where),
      };
    }
    case 'with':
      return {
        kind: 'with',
        projection: compileProjection(clause.projection),
        where: clause.where ? filterPredicate(clause.where) : undefined,
      };
    case 'filter':
      return { kind: 'filter', where: filterPredicate(clause.where) };
    case 'page':
      // Sort keys are ordinary expressions over the CURRENT scope (the working
      // table), so they compile exactly like a FILTER predicate — no projection,
      // no new variables.
      noteCountParam(clause.skip);
      noteCountParam(clause.limit);

      return {
        kind: 'page',
        orderBy: (clause.orderBy ?? []).map((sortItem) => ({
          fn: compileExpr(sortItem.expr),
          descending: sortItem.descending,
          nullsFirst: sortItem.nullsFirst,
        })),
        skip: clause.skip,
        limit: clause.limit,
      };
    case 'let':
      return {
        kind: 'let',
        items: clause.items.map((it) => ({ var: it.var, expr: compileExpr(it.expr) })),
      };
    case 'for':
      return {
        kind: 'for',
        list: compileExpr(clause.list),
        alias: clause.alias,
        ordinality: clause.ordinality,
      };
    case 'return':
      return { kind: 'return', projection: compileProjection(clause.projection) };
    case 'callNamed': {
      const spec = procedureSpec(clause.name);
      const columns = spec ? ['node', spec.resultColumn] : [];
      const binds = clause.yields
        ? clause.yields.map((y) => ({ column: y.name, var: y.alias ?? y.name }))
        : columns.map((c) => ({ column: c, var: c }));

      return {
        kind: 'callNamed',
        optional: clause.optional,
        procName: clause.name,
        algo: spec?.algo ?? null,
        config: clause.config.map((p) => ({ key: p.key, value: compileExpr(p.value) })),
        binds,
      };
    }
    case 'callInline': {
      // All set-op parts share the same output columns, so the first is
      // authoritative for the OPTIONAL null-fill column names.
      const ret = clause.body.parts[0].clauses.find((c) => c.kind === 'return');
      const returnColumns =
        ret && !ret.projection.star
          ? ret.projection.items.map((i) => i.alias ?? columnName(i.expr))
          : [];

      return {
        kind: 'callInline',
        optional: clause.optional,
        scope: clause.scope,
        body: compileLinear(clause.body.parts[0]),
        bodyMore: clause.body.ops.map((op, i) => ({
          op,
          part: compileLinear(clause.body.parts[i + 1]),
        })),
        returnColumns,
      };
    }
    case 'insert':
      return { kind: 'insert', patterns: clause.patterns.map(compileInsertPath) };
    case 'merge': {
      const { onUpdate } = clause;
      const compileUpdate = (): CMergeUpdate | undefined => {
        if (onUpdate === undefined || onUpdate.kind === 'nothing') {
          return onUpdate;
        }

        return {
          kind: 'set',
          items: onUpdate.items.map(compileSetItem),
          where: onUpdate.where ? compileExpr(onUpdate.where) : undefined,
        };
      };

      return {
        kind: 'merge',
        pattern: compileInsertPath(clause.pattern),
        onCreate: clause.onCreate?.map(compileSetItem),
        onUpdate: compileUpdate(),
      };
    }
    case 'set':
      return { kind: 'set', items: clause.items.map(compileSetItem) };
    case 'remove':
      return { kind: 'remove', items: clause.items };
    case 'delete':
      return { kind: 'delete', detach: clause.detach, targets: clause.targets.map(compileExpr) };
    case 'finish':
      return { kind: 'finish' };
  }
};

// --- shared bucket/adjacency primitives --------------------------------------
// Type-bucket sizing + neighbour expansion used by the general matcher and by the
// count/reachability fast-paths in ./executor/shortcuts.ts. Exported so the
// shortcut detectors can't drift from the trunk's expansion of the same edges.

/** Edge types a rel label admits: `null` = bail (and/not/wildcard); `undefined`
 * = "any type" (no `:T`); `string[]` = exactly those types. */
export const relTypeNames = (label: LabelExpr | undefined): string[] | null | undefined => {
  if (!label) {
    return undefined;
  }

  if (label.kind === 'label') {
    return [label.name];
  }

  if (label.kind === 'or') {
    const l = relTypeNames(label.left);
    const r = relTypeNames(label.right);

    return l && r ? [...l, ...r] : null;
  }

  return null;
};

/**
 * Every edge of `types` (undefined = every type) from a `Map<type, Set<Edge>>`
 * index, each yielded ONCE.
 *
 * An edge carries a SET of types and the index buckets it under every one, so
 * concatenating buckets sees a two-type edge twice — as a doubled count, a
 * doubled neighbour, a doubled row. Native walks a single adjacency list and
 * asks "does this edge carry any of these types", which is what this mirrors.
 * Only one bucket can be in play → no dedupe, no allocation, which is the hot
 * single-type case.
 */
/** Shared empty iterable, so the fast paths below allocate nothing to say "no edges". */
const NO_EDGES: readonly Edge[] = [];

/**
 * Edges of `types` out of one vertex's by-type bucket map.
 *
 * NOT a generator for the two single-bucket cases, and that is the point. A `Set<Edge>` is already
 * an `Iterable<Edge>`, so `yield* byType.get(t)` delegated to an iterator the function could
 * simply have RETURNED — paying a generator frame per edge for nothing. Audit item 324 priced the
 * frame at **8.4 ns an edge** in the way-count sweep's shape (200,000 frontier slots x ~5 edges x
 * 3 passes: 68.7ms against 43.4, **1.58x** on that loop), and the returning version measured at or
 * below the floor of iterating the Set with no call at all, so the call itself is free. Item 300
 * had priced "the `edgesOfTypes` generator frame" at 1.19x on the sweep without isolating it.
 *
 * The multi-bucket case keeps the generator: it has to dedupe across buckets, so it has real work
 * to interleave and nothing to return.
 *
 * Semantics are unchanged. `yield* set` delegates to the SAME live Set iterator this now returns,
 * so a caller that mutates mid-iteration sees exactly what it saw before; and the only laziness
 * lost is a `Map.get` that every caller was about to force anyway.
 */
export const edgesOfTypes = (
  byType: Map<string, Set<Edge>> | undefined,
  types: string[] | undefined,
): Iterable<Edge> => {
  if (!byType) {
    return NO_EDGES;
  }

  if (types !== undefined) {
    if (types.length === 1) {
      return byType.get(types[0]) ?? NO_EDGES;
    }
  } else if (byType.size === 1) {
    for (const set of byType.values()) {
      return set;
    }
  }

  return edgesOfManyTypes(byType, types);
};

/** The deduping multi-bucket tail of {@link edgesOfTypes}, which genuinely wants to be lazy. */
const edgesOfManyTypes = function* (
  byType: Map<string, Set<Edge>>,
  types: string[] | undefined,
): Iterable<Edge> {
  const seen = new Set<Edge>();

  for (const set of types ? types.map((t) => byType.get(t)) : byType.values()) {
    for (const e of set ?? []) {
      if (seen.has(e)) {
        continue;
      }

      seen.add(e);

      yield e;
    }
  }
};

/** One-hop neighbours of `v` along `out` (or in) edges of the given `types` (all
 * types when undefined). Shared by the EXISTS-reachable and RETURN-reachable
 * traversals so their neighbour expansion can't drift from each other or native. */
export const outNeighbors = (
  graph: Graph,
  v: Vertex,
  out: boolean,
  types: string[] | undefined,
): Vertex[] => {
  const byType = out ? v.adjFrom : v.adjTo;
  const acc: Vertex[] = [];

  for (const e of edgesOfTypes(byType, types)) {
    acc.push(out ? e.to : e.from);
  }

  return acc;
};

/** Count the `edges` that pass `keep`. */
export const countEdges = (edges: Iterable<Edge>, keep: (e: Edge) => boolean): number => {
  let n = 0;

  for (const e of edges) {
    if (keep(e)) {
      n += 1;
    }
  }

  return n;
};

export type CLinear = {
  clauses: readonly CClause[];
  /** Precomputed direct-count closure for `MATCH … RETURN count(*)`; else null. */
  forCount: ((graph: Graph, params: Params) => Row[]) | null;
  /** The `FOR` PROJECTION off the label bucket (item 528); else null. */
  forProjection: ((graph: Graph, params: Params) => Row[]) | null;
  optionalHopCount: ((graph: Graph, params: Params) => Row[]) | null;
  optionalHopProjection: RowsFn | null;
  countShortcut: ((graph: Graph, params: Params) => Row[]) | null;
  /** The DEGREE-ALGEBRA count over a bounded var-length OUT hop (item 573); else null. */
  varLengthCount: ((graph: Graph, params: Params) => Row[]) | null;
  /** Precomputed grouped-count closure for `MATCH (n) RETURN n.k, count(*)`; else null. */
  groupCountShortcut: ReachFn | null;
  /** The same over a HOP — `MATCH (a)-[:T]->(b) RETURN b.k, count(*)`; else null. */
  groupHopShortcut: ReachFn | null;
  /** BFS closure for unbounded var-length + DISTINCT; else null. */
  reachShortcut: ReachFn | null;
  /** Fused `MATCH (a)-[:T]->(x) RETURN <exprs over x>` row builder; else null. */
  hopProjection: RowsFn | null;
  /** The same walk under ONE foldable aggregate — `RETURN max(x.k)`; else null. */
  hopAggregate: RowsFn | null;
  /** The same walk under TWO OR MORE foldable aggregates — `RETURN count(*), max(x.k)`. */
  multiHopAggregate: RowsFn | null;
  /** `RETURN DISTINCT <one expr>` deduped while walking; else null. */
  distinctProjection: AlwaysRowsFn | null;
  /** `RETURN count(DISTINCT <one expr>)` — the same walk, counted and never materialized. */
  distinctCount: AlwaysRowsFn | null;
  /** `MATCH (n:L) WHERE <row-local> RETURN <row-local>` — a scan with one reused binding. */
  nodeProjection: ((graph: Graph, params: Params) => Row[]) | null;
  /** The same scan under ONE foldable aggregate — `RETURN max(n.k)`; else null. */
  nodeAggregate: ((graph: Graph, params: Params) => Row[]) | null;
  /** The same scan under TWO OR MORE aggregates — `RETURN sum(n.k), count(*)`; else null. */
  multiNodeAggregate: ((graph: Graph, params: Params) => Row[]) | null;
  /** A GROUPED scan aggregate that is not all `count(*)` — `RETURN n.k, max(n.j)`; else null. */
  groupedNodeAggregate: ((graph: Graph, params: Params) => Row[]) | null;
  /** The same over a HOP — `MATCH (a)-[:T]->(b) RETURN b.k, max(b.j)`; else null. */
  groupedHopAggregate: ((graph: Graph, params: Params) => Row[]) | null;
};
/**
 * `MATCH (a:L) MATCH (a)-[:T]->(x)` IS `MATCH (a:L)-[:T]->(x)` — the anchor-then-traverse
 * spelling, fused into one clause before anything looks at the clause list.
 *
 * Two MATCH clauses sharing a variable join on it, so the two spellings are the same question
 * and the native engine costs the same for both. TypeScript did not: EVERY fast-path detector
 * reads one `match` clause, so the split spelling fell to the general row pipeline. Measured at
 * 200,000 vertices / 1,000,000 edges, one case per process (audit item 505):
 *
 * ```text
 *   RETURN count(*)    one clause 0.0ms    two clauses 747.9ms     native 0.5 / 0.5
 *   RETURN x.age       one clause  157ns/row   two clauses 805ns/row   native 77 / 76
 * ```
 *
 * Fusing is a REWRITE, not a new fast path: the fused clause is an ordinary pattern, so every
 * rung of the ladder applies to it with no rung knowing this happened.
 *
 * Deliberately narrow, and each refusal is a case where the fused pattern would not mean the
 * same thing:
 *
 *   - the ANCHOR must be a single bare node (`MATCH (a:L)`), because fusing onto the end of a
 *     longer pattern would have to pick which end, and a pattern binding more than one variable
 *     can be joined on any of them;
 *   - the second clause's START must be the anchor's variable, written plain (`(a)`), with no
 *     label, properties or inline `WHERE` of its own — a re-constrained start is an extra
 *     filter, not the same node;
 *   - neither clause may be OPTIONAL (a left-outer join is not a join), and neither may bind a
 *     path variable;
 *   - at most ONE of the two may carry a `WHERE`. An anchor filter would be evaluated after the
 *     hop rather than before it, which is the same multiset either way; combining TWO would
 *     need an `AND` whose operand order carries the short-circuit contract of items 258/259,
 *     and that is worth its own measurement rather than a guess here.
 */
/**
 * An expression cheap and total enough to be SUBSTITUTED for its name, or DROPPED when nothing
 * reads it: a property read, a variable, a literal or a parameter.
 *
 * Cheap because substituting duplicates it once per use; TOTAL because dropping it must not
 * lose a fault — a missing property reads as NULL and none of these four raises, where a
 * function call or a cast can. Anything else keeps its `LET`.
 */
const cheapPureExpr = (e: Expr): boolean =>
  e.kind === 'prop' || e.kind === 'var' || e.kind === 'lit' || e.kind === 'param';

/**
 * The correlated-subquery expression kinds. `boundExprs` admits one as a `LET` binding, and
 * {@link inlineTrailingLet} then requires the projection to read the name EXACTLY ONCE before
 * substituting it (item 565).
 */
const SUBQUERY_EXPRS: ReadonlySet<string> = new Set(['exists', 'countSubquery', 'valueSubquery']);

/**
 * The names a trailing binder introduces and the CHEAP, TOTAL expressions behind them, or `null`
 * when the clause is not one this can inline.
 *
 * Two clauses bind that way and both dropped the query off every rung, because each node rung
 * reads a TWO-clause shape (audit items 512, 516). Measured at 200,000 vertices:
 *
 * ```text
 *   LET a = n.age  RETURN a         126.4ms      RETURN n.age AS a     13.7ms
 *   LET a = n.age  RETURN count(*)  108.3ms      RETURN count(*)        0.0
 *   WITH n.age AS a RETURN a        124.0ms      (the same)            13.7
 *   WITH n.age AS a RETURN count(*) 112.0ms      (the same)             0.0
 *   WITH n AS m     RETURN count(*)  90.7ms      (the same)             0.0
 * ```
 *
 * Native pays 0.6 for the `WITH` count and 17.7 for its projection, so both are the TS ladder's
 * shape check. The ISO `SELECT count(*) FROM MATCH …` spelling was priced in the same pass and
 * is ALREADY 0.0 — it lowers to the same clause list, so there was nothing to fix there.
 *
 * `LET` ADDS a binding and `WITH` REPLACES the row, which is why a `WITH` may carry several
 * items while the `LET` arm takes one: after a `WITH`, the only names in scope are the ones it
 * binds, so substituting all of them and dropping the clause leaves exactly the references the
 * compiler already validated. A `WITH` that FILTERS (`WITH … WHERE`), aggregates, dedupes,
 * groups, orders or pages is a row boundary rather than a renaming, and declines.
 */
const boundExprs = (c: Clause): Map<string, Expr> | null => {
  if (c.kind === 'let') {
    // ONE item only. A later `LET` item may READ an earlier one (`LET a = n.k, b = a`), so
    // collecting them into one substitution map rewrites `b` to `a` with `a` no longer bound —
    // the column came back `undefined`. Caught by `a later LET item may read an earlier one`,
    // which exists for exactly that sequencing. A `WITH`'s items cannot do this: a projection
    // evaluates every item against the INPUT row, so none of them can see another's alias.
    if (c.items.length !== 1) {
      return null;
    }

    const [{ var: name, expr }] = c.items;

    // A SUBQUERY is neither cheap nor total, and is admitted anyway — but only because
    // `inlineTrailingLet` then proves the projection reads the name EXACTLY ONCE, which is what
    // keeps the evaluation count unchanged. See the once-read guard there.
    return cheapPureExpr(expr) || SUBQUERY_EXPRS.has(expr.kind) ? new Map([[name, expr]]) : null;
  }

  if (c.kind !== 'with' || c.where !== undefined) {
    return null;
  }

  const proj = c.projection;

  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  const out = new Map<string, Expr>();

  for (const item of proj.items) {
    // An un-aliased item takes its name from the expression, which is a name this rewrite would
    // then have to reproduce exactly; a bare variable is its own name, and anything else
    // declines.
    const name = item.alias ?? (item.expr.kind === 'var' ? item.expr.name : undefined);

    if (name === undefined || !cheapPureExpr(item.expr) || hasAggregate(item.expr)) {
      return null;
    }

    out.set(name, item.expr);
  }

  return out.size > 0 ? out : null;
};

/**
 * `MATCH … LET a = <expr> RETURN … a …` IS `MATCH … RETURN … <expr> …` — the `LET` inlined into
 * the projection that follows it, so the clause list is two long again and the ladder applies.
 *
 * `LET` is how this engine names an expression, and a `LET` between the `MATCH` and the `RETURN`
 * dropped the query off every node rung — each reads a two-clause shape. Measured at 200,000
 * vertices (audit item 512):
 *
 * ```text
 *   LET a = n.age RETURN a AS k        126.4ms   RETURN n.age AS k      13.7ms   9.2x
 *   LET a = n.age RETURN count(*)      108.3ms   RETURN count(*)         0.0ms
 * ```
 *
 * Native pays 16.2 against 13.1 for the same pair, so this is the TS ladder's shape check and
 * nothing deeper. Two spellings of one question, which is the defect class this repo is named
 * after.
 *
 * The substitution is deliberately SHALLOW — an item either IS the variable or does not mention
 * it — so no expression tree is rewritten and no nested binder (a `CASE`, a `LET … IN`, a
 * subquery) can be entered by mistake. An item that reads the name inside a larger expression
 * declines the whole rewrite rather than being rebuilt.
 *
 * `GROUP BY` and `HAVING` decline outright: `GROUP BY` takes a BOUND NAME, so inlining its key
 * would remove the thing it names (and that spelling is already fast — 4.0ms against the
 * equivalent 5.0). `RETURN *` declines because the `LET` variable is one of the columns.
 */
const inlineTrailingLet = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length < 3) {
    return clauses;
  }

  const ret = clauses[clauses.length - 1];
  const binder = clauses[clauses.length - 2];
  const bound = boundExprs(binder);

  if (ret.kind !== 'return' || bound === null) {
    return clauses;
  }

  const proj = ret.projection;

  if (proj.star || proj.groupBy !== undefined || proj.having !== undefined) {
    return clauses;
  }

  // A SUBQUERY binding may be inlined only where the projection reads its name EXACTLY ONCE.
  // Inlining a cheap, total expression any number of times costs nothing and can raise nothing; a
  // subquery is neither, so the evaluation COUNT has to come out the same:
  //
  //   - read TWICE and inlined twice, the work doubles;
  //   - read ZERO times, the binding's evaluation disappears and with it any fault it raises.
  //
  // One reference is the only case where substituting changes nothing observable.
  const subqueryBound = [...bound].filter(([, e]) => SUBQUERY_EXPRS.has(e.kind)).map(([n]) => n);

  if (subqueryBound.length > 0) {
    const reads = (e: Expr): number => {
      const free = freePredicateVars(e);

      return subqueryBound.filter((name) => free.has(name)).length;
    };
    const total =
      proj.items.reduce((acc, it) => acc + reads(it.expr), 0) +
      (proj.orderBy ?? []).reduce((acc, o) => acc + reads(o.expr), 0);

    if (total !== 1) {
      return clauses;
    }
  }

  // Exactly a bound name → its expression; a FUNCTION ARGUMENT that is one → substitute it there;
  // mentions one anywhere else → refuse; otherwise unchanged.
  //
  // The function-argument case is item 565, and it is where the common shape lives. `subst` used
  // to be all-or-nothing, so `LET c = COUNT { … } RETURN sum(c)` — a name read inside an
  // aggregate — never inlined and kept the per-row clause. Measured at 200,000 vertices /
  // 300,000 edges, one case per process:
  //
  // ```text
  //   LET c = COUNT { MATCH (n)-[:KNOWS]->(x) } RETURN sum(c)   114.06 / 170.48 / 173.33 ms
  //   RETURN sum(COUNT { MATCH (n)-[:KNOWS]->(x) })              50.14 /  52.78 /  52.18
  // ```
  //
  // ONE LEVEL ONLY, and deliberately: the arguments are replaced where they are BARE NAMES, and
  // the result is then re-checked for any surviving mention. A deeper reference (`sum(c + 1)`)
  // leaves one and refuses, rather than needing an exhaustive walk over a 40-arm `Expr` union
  // where a missed arm would drop the binder with the name still unbound.
  const subst = (e: Expr): Expr | null => {
    if (e.kind === 'var') {
      const sub = bound.get(e.name);

      if (sub !== undefined) {
        return sub;
      }
    }

    const mentions = (x: Expr): boolean => {
      const free = freePredicateVars(x);

      return [...bound.keys()].some((n) => free.has(n));
    };

    if (!mentions(e)) {
      return e;
    }

    if (e.kind !== 'func') {
      return null;
    }

    const args = e.args.map((a) => (a.kind === 'var' ? (bound.get(a.name) ?? a) : a));
    const swapped: Expr = { ...e, args };

    return args.some((a, i) => a !== e.args[i]) && !args.some(mentions) ? swapped : null;
  };
  const items: ReturnItem[] = [];

  for (const it of proj.items) {
    const e = subst(it.expr);

    if (e === null) {
      return clauses;
    }

    // A `LET` names a BINDING, and an un-aliased `RETURN a` takes its COLUMN name from the
    // expression — so substituting without pinning the alias renamed the column from `a` to
    // `n.k`. Caught by `DISTINCT over a LET-bound name`, which exists for exactly that
    // distinction; the rewrite now carries the name it removed.
    items.push(
      e === it.expr
        ? it
        : {
            ...it,
            expr: e,
            alias: it.alias ?? (it.expr.kind === 'var' ? it.expr.name : undefined),
          },
    );
  }

  const sorts: SortItem[] = [];

  for (const o of proj.orderBy ?? []) {
    const e = subst(o.expr);

    if (e === null) {
      return clauses;
    }

    sorts.push({ ...o, expr: e });
  }

  return [
    ...clauses.slice(0, -2),
    {
      ...ret,
      projection: {
        ...proj,
        items,
        orderBy: proj.orderBy === undefined ? undefined : sorts,
      },
    },
  ];
};

/** Every variable a pattern BINDS: its nodes, its rels, and the path itself. */
const patternNames = (p: PathPattern): Set<string> => {
  const out = new Set<string>();
  const add = (v: string | undefined): void => {
    if (v !== undefined) {
      out.add(v);
    }
  };

  add(p.pathVar);
  add(p.start.variable);

  for (const seg of p.segments) {
    add(seg.rel.variable);
    add(seg.node.variable);
    add(seg.hopFrom?.variable);
    add(seg.hopTo?.variable);
  }

  return out;
};

/**
 * `CALL (n) { MATCH (n)-[:T]->(x) RETURN x }` IS `MATCH (n)-[:T]->(x)` — a correlated inline
 * call whose body is one pattern and a `RETURN` of the names that pattern introduces, rewritten
 * to the plain `MATCH` it is equivalent to.
 *
 * The call runs its body once per incoming row through the general matcher, so
 * `MATCH (n:Person) CALL (n) { MATCH (n)-[:KNOWS]->(x) RETURN x } RETURN count(*)` cost
 * **996.2 ms** at 200,000 vertices / 1,000,000 edges against the native engine's 6.2, and
 * against **0.0** for the same question written as one pattern (audit item 513).
 *
 * Rewriting rather than adding a rung is what makes it cheap: the result is an ordinary `MATCH`
 * clause, which item 507's fusion then merges into the preceding one, after which every rung of
 * the ladder applies. Three rewrites composing (512's `LET`, this, 507's fusion) and no new
 * execution path.
 *
 * What it refuses, and why each would change the answer:
 *
 *   - `OPTIONAL CALL` — a left-outer join keeps the row when the body yields nothing, which a
 *     plain `MATCH` does not;
 *   - an UNCORRELATED call (an empty scope). Its mutant SURVIVES, and the reason is that the
 *     join result coincides: a body with no correlation yields the same rows for every outer
 *     row, so joining them is the cross product a second `MATCH` would produce. The guard stays
 *     because the execution contract does not coincide — the call runs its body ONCE and reuses
 *     it, which may well be the better plan, and turning that into a cross product is a change
 *     with its own number rather than a free one;
 *   - a body with set operators, more than one `MATCH`, or anything but `MATCH … RETURN`;
 *   - a `RETURN` that is not exactly bare variables (an alias, an expression, `*`, `DISTINCT`,
 *     a grouping, an `ORDER BY` or a page) — the call yields COLUMNS, and anything computed is
 *     not the pattern's own binding;
 *   - a body that binds a name it does NOT return. The call hides it; a plain `MATCH` would
 *     leave it bound, which `RETURN *` and any later clause can see. The set equality below is
 *     what enforces that, and it is the one condition whose violation is invisible in the
 *     common shapes.
 */
/**
 * `CALL (n) { MATCH … RETURN <agg> AS c }` → `LET c = VALUE { MATCH … RETURN <agg> }`.
 *
 * An UN-GROUPED aggregate body yields exactly ONE row per outer row — null or 0 over an empty
 * match, never nothing — so the lateral join neither drops nor multiplies rows and the call is a
 * per-row SCALAR. That is precisely a `VALUE {}` subquery, which has rungs (items 499, 557) where
 * the CALL route has none. Measured at 200,000 vertices / 200,000 edges, one case per process:
 *
 * ```text
 *   CALL (n) { MATCH (n)-[:KNOWS]->(x) RETURN count(*) AS c } RETURN sum(c)   760.86 ms
 *   RETURN sum(COUNT { MATCH (n)-[:KNOWS]->(x) })                             30.56
 * ```
 *
 * 24.9x between two spellings of one question.
 *
 * THE MANUFACTURED NODE MUST BE MARKED CORRELATED, and item 562 retracted this whole rewrite for
 * one tick because it was not. `markIfCorrelated` populates a WeakSet during SCOPE CHECKING, which
 * runs over the PARSED AST — so a subquery node a rewrite MANUFACTURES is never in it, and
 * `memoizeIfUncorrelated` then computes the per-row scalar ONCE and reuses it:
 *
 * ```text
 *   CALL (n) { … RETURN count(*) AS c } RETURN sum(c) AS t, count(*) AS r
 *     unmarked  {t: 6, r: 3}      one node's degree of 2, counted three times
 *     marked    {t: 2, r: 3}      native's answer
 * ```
 *
 * The node IS correlated by construction — this rewrite fires only when `c.scope` is non-empty,
 * i.e. the call imports outer names — so the marking is a statement of that fact rather than an
 * analysis. Any future rewrite that manufactures an `exists`/`countSubquery`/`valueSubquery` node
 * has the same obligation.
 *
 * `inlineCorrelatedCall` below handles the OTHER body shape, a pass-through that yields pattern
 * variables, by turning the call into a plain MATCH. That rewrite is wrong here (an aggregate body
 * yields a VALUE, not a binding) and this one is wrong there (a pass-through yields many rows), so
 * they are separate and each refuses the other's shape.
 *
 * ONE aggregate item only. Two of them is a shape the engines DISAGREE about — native rejects
 * `RETURN count(*) AS c, max(x.n) AS m` inside a CALL body ("an aggregating RETURN inside …")
 * while TS answers it — so it stays on the general path rather than becoming a faster divergence
 * (item 557's policy, and the fifth such subquery-body refusal found).
 */
const inlineAggregateCall = (clauses: readonly Clause[]): readonly Clause[] => {
  const asLet = (c: Clause): Clause | null => {
    if (c.kind !== 'callInline' || c.optional || c.scope.length === 0) {
      return null;
    }

    const { parts, ops } = c.body;

    if (parts.length !== 1 || ops.length > 0) {
      return null;
    }

    const inner = parts[0].clauses;

    if (inner.length !== 2) {
      return null;
    }

    const [bm, bret] = inner;

    if (bm.kind !== 'match' || bm.optional || bm.patterns.length !== 1 || bret.kind !== 'return') {
      return null;
    }

    const proj = bret.projection;

    // Paging, ordering, DISTINCT and grouping inside the body all change what the one row is — or
    // whether it is one row at all — so they stay with the general path.
    if (
      proj.star ||
      proj.distinct ||
      proj.groupBy !== undefined ||
      proj.having !== undefined ||
      (proj.orderBy?.length ?? 0) > 0 ||
      proj.skip !== undefined ||
      proj.limit !== undefined ||
      proj.items.length !== 1
    ) {
      return null;
    }

    const [item] = proj.items;
    const { alias } = item;

    // The alias is what the outer query reads the scalar as, so the body must name it — an
    // un-aliased aggregate has no name to bind.
    if (alias === undefined || !hasAggregate(item.expr)) {
      return null;
    }

    // After the rewrite the body's pattern variables are GONE (a `VALUE {}` subquery scopes its
    // own pattern), so none of them may be the name the outer query now reads. An IMPORTED name
    // is fine: that one was the outer's already.
    const imported = new Set(c.scope);

    for (const name of patternNames(bm.patterns[0])) {
      if (!imported.has(name) && name === alias) {
        return null;
      }
    }

    const agg = item.expr;
    // THE PARSER'S OWN NORMALIZATION, mirrored (item 564). `parseValueSubquery` turns
    // `VALUE { … RETURN count(*) }` into a `countSubquery` node — item 499's lowering onto the
    // degree path — and a rewrite that manufactures the `valueSubquery` form instead misses it
    // entirely. Measured at 200,000 vertices / 300,000 edges:
    //
    //   CALL (n) { … RETURN count(*) AS c } RETURN sum(c)   504.16 ms as a valueSubquery
    //   LET c = VALUE { … RETURN count(*) } RETURN sum(c)   151.30     the parsed spelling
    //
    // 3.3x for the same question, because one node kind reaches the degree rung and the other
    // does not. The conditions below are `parseValueSubquery`'s, copied rather than approximated.
    const sub: Extract<Expr, { kind: 'valueSubquery' | 'countSubquery' }> =
      agg.kind === 'func' && agg.name === 'count' && agg.star && !agg.distinct
        ? {
            kind: 'countSubquery',
            patterns: bm.patterns,
            ...(bm.where === undefined ? {} : { where: bm.where }),
          }
        : {
            kind: 'valueSubquery',
            patterns: bm.patterns,
            ...(bm.where === undefined ? {} : { where: bm.where }),
            ret: agg,
          };

    // See the header: scope checking has already run, so this node would otherwise be memoized
    // as uncorrelated.
    correlatedSubqueries.add(sub);

    return { kind: 'let', items: [{ var: alias, expr: sub }] };
  };

  let changed = false;
  const out = clauses.map((c) => {
    const rewritten = asLet(c);

    if (rewritten === null) {
      return c;
    }

    changed = true;

    return rewritten;
  });

  return changed ? out : clauses;
};

const inlineCorrelatedCall = (clauses: readonly Clause[]): readonly Clause[] => {
  const asMatch = (c: Clause): Clause | null => {
    if (c.kind !== 'callInline' || c.optional || c.scope.length === 0) {
      return null;
    }

    const { parts, ops } = c.body;

    if (parts.length !== 1 || ops.length > 0) {
      return null;
    }

    const inner = parts[0].clauses;

    if (inner.length !== 2) {
      return null;
    }

    const [bm, bret] = inner;

    if (bm.kind !== 'match' || bm.optional || bm.patterns.length !== 1 || bret.kind !== 'return') {
      return null;
    }

    const proj = bret.projection;

    if (
      proj.star ||
      proj.distinct ||
      proj.groupBy !== undefined ||
      proj.having !== undefined ||
      (proj.orderBy?.length ?? 0) > 0 ||
      proj.skip !== undefined ||
      proj.limit !== undefined
    ) {
      return null;
    }

    const yielded = new Set<string>();

    for (const item of proj.items) {
      if (item.expr.kind !== 'var' || (item.alias !== undefined && item.alias !== item.expr.name)) {
        return null;
      }

      yielded.add(item.expr.name);
    }

    // The body may introduce ONLY the names it yields; anything else would stay bound after the
    // rewrite where the call hides it.
    const imported = new Set(c.scope);
    const introduced = [...patternNames(bm.patterns[0])].filter((n) => !imported.has(n));

    if (introduced.length !== yielded.size || introduced.some((n) => !yielded.has(n))) {
      return null;
    }

    return { kind: 'match', optional: false, patterns: bm.patterns, where: bm.where };
  };

  let changed = false;
  const out = clauses.map((c) => {
    const m = asMatch(c);

    if (m === null) {
      return c;
    }

    changed = true;

    return m;
  });

  return changed ? out : clauses;
};

/** The ANCHOR half of `fuseAnchorThenHop`: a lone `MATCH (v …)` binding exactly one node. */
/**
 * Is this pattern's path shape the plain default — every match, no repetition restrictor?
 *
 * A SELECTOR or a non-default MODE describes the WHOLE path, so concatenating two patterns
 * under one of them is a different question: `ANY SHORTEST` over the join is not two
 * independent matches, and `SIMPLE` would forbid repeating a node ACROSS the join where the
 * two-clause form allows it.
 *
 * Compared against the DEFAULTS rather than `undefined`, which is the bug this comment exists
 * for: `parsePathPattern` writes `selector: 'walk'` and `mode: 'trail'` onto every pattern it
 * builds, so an `=== undefined` test refuses everything — fusion silently stopped firing
 * altogether (11 fusions in its own test file to 0) while every test still passed, because a
 * rewrite that declines is only slower. The instrumented count is what caught it.
 *
 * `trail` is the written default and is NOT enforced on a fixed-length pattern in either
 * engine: `MATCH (a:P)-[:T]->(x)-[:T]->(y)` over a self-loop counts the path that reuses that
 * one edge, and so does the two-clause spelling — checked in both engines before relying on it.
 */
const defaultPathShape = (p: PathPattern): boolean =>
  (p.selector === undefined || p.selector === 'walk') &&
  (p.mode === undefined || p.mode === 'trail');

const anchorOf = (c: Clause): (Extract<Clause, { kind: 'match' }> & { v: string }) | undefined => {
  if (c.kind !== 'match' || c.optional || c.patterns.length !== 1) {
    return undefined;
  }

  const [p] = c.patterns;
  // The variable the NEXT clause can attach to is the one at the pattern's far END — its start
  // when the pattern is a lone node, otherwise its last segment's node. Item 505 took only the
  // lone-node case, so a THIRD clause never chained: `MATCH (a:P)-[:T]->(x) MATCH (x)-[:T]->(y)`
  // cost 2286.3ms against 103.4 for the one-clause spelling, and native charges 2.7 for both
  // (item 506).
  const last = p.segments.at(-1);
  const v = last === undefined ? p.start.variable : last.node.variable;

  return p.pathVar === undefined && v !== undefined && defaultPathShape(p)
    ? { ...c, v }
    : undefined;
};

/** The pair half of `fuseAnchorThenHop`: `a` then `b` as one clause, or `undefined`. */
const fuse = (a: Clause, b: Clause): Clause | undefined => {
  const anchor = anchorOf(a);

  if (
    anchor === undefined ||
    b.kind !== 'match' ||
    b.optional ||
    b.patterns.length !== 1 ||
    (anchor.where !== undefined && b.where !== undefined)
  ) {
    return undefined;
  }

  const [hop] = b.patterns;
  const { start } = hop;

  const [anchorPattern] = anchor.patterns;

  if (
    hop.pathVar !== undefined ||
    hop.segments.length === 0 ||
    start.variable !== anchor.v ||
    start.label !== undefined ||
    start.where !== undefined ||
    (start.properties !== undefined && start.properties.length > 0) ||
    // The hop's own selector/mode would come to describe the CONCATENATED path once the
    // anchor contributes segments of its own, so it is only safe to carry over a bare anchor.
    (anchorPattern.segments.length > 0 && !defaultPathShape(hop))
  ) {
    return undefined;
  }

  return {
    kind: 'match',
    optional: false,
    patterns: [
      {
        ...hop,
        start: anchorPattern.start,
        segments: [...anchorPattern.segments, ...hop.segments],
      },
    ],
    where: anchor.where ?? b.where,
  };
};

const fuseAnchorThenHop = (clauses: readonly Clause[]): readonly Clause[] => {
  const out: Clause[] = [];

  for (const clause of clauses) {
    const prev = out.at(-1);
    const fused = prev === undefined ? undefined : fuse(prev, clause);

    if (fused === undefined) {
      out.push(clause);
    } else {
      out[out.length - 1] = fused;
    }
  }

  return out;
};

/**
 * Does any pattern in these clauses bind the SAME node variable twice?
 *
 * `MATCH (a:P)-[:T]->(a)` means one node at both ends — the self-loops — and the general
 * matcher answers it correctly. **Every hop fast path answered it WRONG**, because each binds
 * the far node over the start without checking that the name is the same one: on a fixture with
 * two self-loops among four edges, `count(*)` read 4 against native's 2, the projection four
 * rows against two, a grouped count 3 for a vertex with one self-loop, `max(a.k)` 3 against 2,
 * and the reversed and undirected spellings likewise. Eight of ten shapes probed diverged from
 * native, and the two that agreed were the two that already declined (a `DISTINCT` projection
 * and a filtered count).
 *
 * Found by accident: item 506's clause fusion routed `MATCH (a:P) MATCH (a)-[:T]->(a)` into the
 * one-clause spelling and the two answers stopped agreeing, which is the only reason anyone
 * looked. The differential fuzzer does not generate a one-hop pattern that repeats its
 * endpoint, so nothing else was watching this.
 *
 * The gate is deliberately whole-query and conservative: a pattern that repeats a node variable
 * takes the general matcher, and no rung has to be audited for a hazard it was never written
 * for. Item 487 fixed the same class one rung at a time for a repeated REL variable; the
 * one-at-a-time fix is what left this.
 */
const repeatsNodeVariable = (clauses: readonly Clause[]): boolean => {
  for (const clause of clauses) {
    if (clause.kind !== 'match') {
      continue;
    }

    for (const p of clause.patterns) {
      const seen = new Set<string>();
      const names = [p.start.variable, ...p.segments.map((seg) => seg.node.variable)];

      for (const name of names) {
        if (name === undefined) {
          continue;
        }

        if (seen.has(name)) {
          return true;
        }

        seen.add(name);
      }
    }
  }

  return false;
};

/**
 * Make an `OPTIONAL MATCH` non-optional when the projection cannot see the difference.
 *
 * An optional match contributes ONE null-filled row per start with no match. Every aggregate in
 * this engine drops nullish values before folding (the general path's `nonNull`, which
 * `aggregateOverValues` is handed), so those rows change nothing — **except** for `count(*)`,
 * which counts ROWS and therefore counts them. So for an un-grouped projection whose aggregates
 * are all argument-taking, `OPTIONAL MATCH … RETURN <agg>(x.k)` is the same question as
 * `MATCH … RETURN <agg>(x.k)` — and the second has had a rung since item 418.
 *
 * The enum that found this, 200,000 vertices / 200,000 edges, one case per process:
 *
 * ```text
 *                                                              TS        native
 *   MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*)     8.12 ms   0.66 ms
 *   ...RETURN count(x)                                         410.12      1.30
 *   ...RETURN max(x.age)                                       475.90      1.52
 * ```
 *
 * `count(*)` has had the rung since item 546; the other two were 315x and 313x off native because
 * an OPTIONAL match declines every aggregate rung there is.
 *
 * REFUSED, each because the null-filled row IS observable:
 *
 *   - `count(*)` or `RETURN *` — a row counter sees them.
 *   - a GROUPED projection, explicit or implicit. `RETURN n.k, max(x.v)` keeps a group for an
 *     unmatched start (with a null aggregate) where the non-optional form drops it — four groups
 *     against two on the test fixture — and a `GROUP BY` over `x.k` would keep a null KEY.
 *   - a projection with no aggregate at all, which is just the rows (five against three).
 *
 * TWO of those conditions are REDUNDANT today and kept deliberately, which the mutation run made
 * explicit. `!proj.star` is implied by `items.length > 0`, since a bare `RETURN *` projects no
 * items; `groupBy`/`having` are implied by `items.every(hasAggregate)`, since an explicit GROUP BY
 * key has to appear as a non-aggregate item and `RETURN` never sets `having` (only `SELECT` does).
 * Both stay because the implication runs through another part of the projection rather than
 * through anything local — the same reason `detectHopAggregate` keeps its `groupKeys` check.
 */
const unoptionalizeForAggregate = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length < 2) {
    return clauses;
  }

  const ret = clauses[clauses.length - 1];
  const prev = clauses[clauses.length - 2];

  if (ret?.kind !== 'return' || prev?.kind !== 'match' || !prev.optional) {
    return clauses;
  }

  const proj = ret.projection;
  const nullBlind =
    !proj.star &&
    proj.groupBy === undefined &&
    proj.having === undefined &&
    proj.items.length > 0 &&
    proj.items.every(
      (it) =>
        hasAggregate(it.expr) &&
        // A STAR count is the one aggregate that sees a null-filled row, so one anywhere in the
        // projection — even beside an argument-taking one — refuses the whole rewrite.
        collectAggregates(it.expr).every((a) => !a.star && a.args.length === 1),
    );

  if (!nullBlind) {
    return clauses;
  }

  return [...clauses.slice(0, -2), { ...prev, optional: false }, ret];
};

/**
 * Aggregates whose value cannot depend on the ORDER of the rows they fold.
 *
 * Item 419's rule, reused: `count`, `min` and `max` are order-free, and the two percentiles sort
 * internally. `sum` and `avg` are order-free in arithmetic but NOT in floating point, and
 * byte-identity with the native engine pins the summation order (see the summation-order rule in
 * the algorithms work), so they are refused here along with `collect`/`stddev`, whose dependence
 * is plain: `ORDER BY n.n RETURN collect(n.n)` reads `[1, 2]` and `DESC` reads `[2, 1]`.
 */
const ORDER_FREE_AGGREGATES: ReadonlySet<string> = new Set([
  'count',
  'min',
  'max',
  'percentile_cont',
  'percentile_disc',
]);

/**
 * A sort key that cannot FAULT: a bare variable, or one property access on a variable.
 *
 * `n.missing` is null rather than an error, and a property read of a VALUE variable is null too
 * (`LET z = 1 … ORDER BY z.n` answers in both engines rather than raising), so neither shape can
 * carry a fault that dropping the sort would swallow. Anything computed — `ORDER BY 1 / 0`, which
 * RAISES in both engines — is not one of these.
 */
const faultFreeSortKey = (expr: Expr): boolean => expr.kind === 'var' || expr.kind === 'prop';

/**
 * `RETURN` delivers exactly ONE row and that row cannot depend on the incoming order.
 *
 * Every item must CARRY an aggregate, because an item without one is an implicit GROUP BY key —
 * which both makes the result many rows and makes a sort position observable. An explicit
 * `GROUP BY` is refused for the same reason. This is the same one-row argument items 544-546
 * made about `DISTINCT` and `ORDER BY` on the projection, asked here of the clause in FRONT of it.
 */
const oneOrderFreeRow = (ret: Extract<Clause, { kind: 'return' }>): boolean => {
  const proj = ret.projection;

  return (
    !proj.star &&
    proj.groupBy === undefined &&
    proj.having === undefined &&
    proj.items.length > 0 &&
    proj.items.every(
      (it) =>
        hasAggregate(it.expr) &&
        collectAggregates(it.expr).every((a) => ORDER_FREE_AGGREGATES.has(a.name)),
    )
  );
};

/**
 * Drop an `ORDER BY` / `OFFSET` / `LIMIT` STATEMENT that cannot change the answer.
 *
 * ISO puts `<order by and page statement>` in the `primitiveQueryStatement` position (§14.10), so
 * it is a pipeline step in its own right rather than paging carried on the RETURN — and as a step
 * in front of the projection it put one extra clause ahead of every detector, which is item 540's
 * structural rule again (item 548 was its `FILTER` instance). Two of its spellings are identities:
 *
 * ```text
 *                                                        TS        native
 *   MATCH (n:Person) RETURN count(*)                     0.00 ms   0.01 ms
 *   MATCH (n:Person) OFFSET 0 RETURN count(*)           83.00      0.57
 *   MATCH (n:Person) ORDER BY n.age RETURN count(*)    126.60     10.07
 *   MATCH (n:Person) ORDER BY n.age RETURN max(n.age)  194.35     10.30
 * ```
 *
 * `OFFSET 0` with no `LIMIT` keeps every row whatever follows, so it goes unconditionally. An
 * `ORDER BY` goes only in front of a projection that is ONE order-free row ({@link oneOrderFreeRow}),
 * and only when every key is fault-free ({@link faultFreeSortKey}) — `ORDER BY 1 / 0` RAISES in both
 * engines, and a drop that skipped the sort would skip the fault with it.
 *
 * A `LIMIT`, or an `OFFSET` that is not literally 0, changes which rows reach the projection
 * (`OFFSET 1 RETURN count(*)` reads 1 against 2) and is never dropped.
 */
const dropVacuousPage = (clauses: readonly Clause[]): readonly Clause[] => {
  const out: Clause[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];

    if (clause === undefined) {
      continue;
    }

    if (clause.kind !== 'page') {
      out.push(clause);
      continue;
    }

    const skipsNothing = clause.skip === undefined || clause.skip === 0;

    if (!skipsNothing || clause.limit !== undefined) {
      out.push(clause);
      continue;
    }

    const sorts = clause.orderBy ?? [];

    if (sorts.length === 0) {
      continue;
    }

    const next = clauses[i + 1];

    if (
      next?.kind !== 'return' ||
      !oneOrderFreeRow(next) ||
      !sorts.every((sort) => faultFreeSortKey(sort.expr))
    ) {
      out.push(clause);
    }
  }

  return out.length === clauses.length ? clauses : out;
};

/**
 * Fold a `FILTER p` back into the `MATCH` before it, as that match's clause `WHERE`.
 *
 * `FILTER <pred>` and a clause `WHERE <pred>` on the preceding MATCH are the same question —
 * both evaluate the predicate once per binding of that match — but only the `WHERE` spelling
 * reaches the ladder, because every detector matches a clause LIST and a `FILTER` is one clause
 * too many. Measured at 200,000 vertices / 200,000 edges, one case per process (item 548):
 *
 * ```text
 *   MATCH (n:Person) WHERE n.age > 44 RETURN count(*)                  4.49 ms
 *   MATCH (n:Person) FILTER n.age > 44 RETURN count(*)                34.59      7.7x
 *   MATCH (:Person)-[:KNOWS]->(b) WHERE b.age > 44 RETURN count(*)    30.57
 *   MATCH (:Person)-[:KNOWS]->(b) FILTER b.age > 44 RETURN count(*)  333.86     10.9x
 *   MATCH (n:Person) WHERE n.age > 44 RETURN max(n.age)                8.43
 *   MATCH (n:Person) FILTER n.age > 44 RETURN max(n.age)              37.61      4.5x
 * ```
 *
 * Same answers throughout. This is the bug class the repo is named after, on a spelling ISO puts
 * in the grammar as a first-class statement.
 *
 * NOT ACROSS AN `OPTIONAL MATCH`, and that is the one condition that is about semantics rather
 * than reach: a clause `WHERE` on an OPTIONAL is evaluated INSIDE it, so a start with no match
 * still yields its null-filled row, while a `FILTER` after it DROPS that row. The two spellings
 * genuinely differ there and the fold would change the answer.
 *
 * The predicate's free variables are deliberately unrestricted, for item 128's reason: a node
 * predicate is evaluated against the INCOMING binding, which already holds every earlier clause's
 * variables, so an outer reference resolves in the pattern exactly as it did in the filter.
 *
 * Written ORDER is preserved — `WHERE w AND f` when the match already had a `WHERE w` — because
 * `AND` short-circuits in written order in both engines (items 258, 259) and the conjunct that
 * was written first must still be the one evaluated first.
 */
const inlineTrailingFilter = (clauses: readonly Clause[]): readonly Clause[] => {
  const out: Clause[] = [];

  for (const clause of clauses) {
    const prev = out[out.length - 1];

    if (
      clause.kind !== 'filter' ||
      prev?.kind !== 'match' ||
      prev.optional ||
      hasAggregate(clause.where)
    ) {
      out.push(clause);
      continue;
    }

    out[out.length - 1] = {
      ...prev,
      where: prev.where === undefined ? clause.where : conjoin([prev.where, clause.where]),
    };
  }

  return out.length === clauses.length ? clauses : out;
};

/**
 * `((x)-[e:T]->(y)){n,m}` → `-[:T]->{n,m}(y)` when nothing can observe the unit's variables.
 *
 * The two are one question, and the GROUP spelling costs nearly twice the abbreviated one because
 * it compiles to a repetition UNIT (which carries a per-rep list for every inner variable) where
 * the abbreviated form routes through the plain quantified hop. Measured at 60,000 vertices /
 * 180,000 edges, one case per process:
 *
 * ```text
 *   MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*)          421.35 ms    native 1.07
 *   MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*)    786.15       native 1.06    1.87x
 * ```
 *
 * The native optimizer already does this — `drop_unread_group_binds`, whose own note measures a
 * group `count(*)` going 64,655µs → 606 — and the two engines agreeing that the spellings are one
 * question (1.06 against 1.07) is what says the rewrite is sound rather than merely faster.
 *
 * NARROW ON PURPOSE. The clause list must be exactly MATCH + RETURN, and neither the projection
 * nor the match's `WHERE` may MENTION an inner name or contain a SUBQUERY of any kind. That last
 * condition is item 444's trap, and it is the reason this does not use a free-variable analysis:
 * `freePredicateVars` adds a subquery's own pattern names to its bound set, so an inner
 * `-[r:T]->` that CORRELATES on an already-bound `r` is indistinguishable from one binding it
 * freshly — and a guard removed on that basis produced a wrong answer (2 where the answer is 1).
 * With no subquery anywhere, "mentioned" is exactly what a free-variable walk reports.
 *
 * The unit must also be ONE plain hop: a multi-element unit, a nested subpath, an inner
 * quantifier, a per-rep `WHERE`, or any label / property / inline `WHERE` on an inner node or the
 * edge all change what is matched, not just what is bound.
 */
/**
 * Whether a quantified-subpath inner node carries nothing that FILTERS. Module scope, not a
 * closure in {@link dropUnreadGroupBinds}: it captures nothing, and a helper defined inside a
 * hot builder is a shape this engine has been bitten by (`ts-closure-size-is-load-bearing`).
 *
 * All three conditions are depth rather than reachable protection — the parser rejects a label,
 * an inline property and a `WHERE` on such a node outright ("a label or property on a
 * quantified-subpath node isn't supported yet"). `group-bind-elision.test.ts` pins that
 * rejection, so if the parser ever admits them this guard is re-examined BEFORE the rewrite can
 * start dropping a binding that filters.
 */
const plainGroupNode = (n: NodePattern | undefined): boolean =>
  n === undefined ||
  (n.label === undefined && (n.properties?.length ?? 0) === 0 && n.where === undefined);

const dropUnreadGroupBinds = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length !== 2) {
    return clauses;
  }

  const [m, ret] = clauses;

  if (m?.kind !== 'match' || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return clauses;
  }

  const [pattern] = m.patterns;

  if (pattern.pathVar !== undefined) {
    return clauses;
  }

  // Every expression anything downstream could read. A subquery ANYWHERE refuses the rewrite.
  const exprs: Expr[] = [
    ...ret.projection.items.map((it) => it.expr),
    ...(ret.projection.orderBy ?? []).map((o) => o.expr),
    ...(ret.projection.groupBy ?? []),
    ...(ret.projection.having === undefined ? [] : [ret.projection.having]),
    ...(m.where === undefined ? [] : [m.where]),
  ];

  if (exprs.some(hasSubquery)) {
    return clauses;
  }

  const mentioned = new Set<string>();

  for (const e of exprs) {
    for (const name of freePredicateVars(e)) {
      mentioned.add(name);
    }
  }

  let changed = false;
  const segments = pattern.segments.map((seg) => {
    const { rel, hopFrom, hopTo, unitRest, innerQ, nested, subpathWhere } = seg;

    if (
      hopFrom === undefined ||
      nested !== undefined ||
      subpathWhere !== undefined ||
      innerQ !== undefined ||
      (unitRest?.length ?? 0) > 0 ||
      !plainGroupNode(hopFrom) ||
      !plainGroupNode(hopTo) ||
      (rel.properties?.length ?? 0) > 0 ||
      rel.where !== undefined
    ) {
      return seg;
    }

    const inner = [hopFrom.variable, hopTo?.variable, rel.variable].filter(
      (n): n is string => n !== undefined,
    );

    if (inner.some((n) => mentioned.has(n))) {
      return seg;
    }

    changed = true;

    const { hopFrom: _f, hopTo: _t, ...rest } = seg;

    return { ...rest, rel: { ...rel, variable: undefined } };
  });

  return changed ? [{ ...m, patterns: [{ ...pattern, segments }] }, ret] : clauses;
};

const compileLinear = (linear: LinearQuery): CLinear => {
  const source = fuseAnchorThenHop(
    inlineCorrelatedCall(
      // `inlineAggregateCall` runs INSIDE `inlineTrailingLet` so the `LET` it produces is itself
      // inlined when it is the last binding before the RETURN — the two compose into "a CALL with
      // an aggregate body is a projection subquery", which is where the rungs are.
      inlineTrailingLet(
        inlineAggregateCall(
          inlineTrailingFilter(
            unoptionalizeForAggregate(dropUnreadGroupBinds(dropVacuousPage(linear.clauses))),
          ),
        ),
      ),
    ),
  );
  const clauses = source.map(compileClause);
  // A pattern repeating a node variable is a SELF-JOIN that the fast paths answer wrongly, so
  // they are not offered the clause list at all — every detector begins by checking its shape
  // and an empty list matches none of them.
  const fast = repeatsNodeVariable(source) ? [] : source;

  return {
    clauses,
    // The OPTIONAL-hop count sits above the plain one: every other rung refuses `optional`,
    // so without it this shape has no rung at all (item 510).
    // A constant `FOR` multiplies the count, so it sits beside the other count rungs and
    // delegates to `detectCountShortcut` for the base (item 515).
    forCount: detectForCount(fast, clauses),
    forProjection: detectForProjection(fast, clauses),
    optionalHopCount: detectOptionalHopCount(fast),
    optionalHopProjection: detectOptionalHopProjection(fast, clauses),
    countShortcut: detectCountShortcut(fast, clauses),
    varLengthCount: detectVarLengthCount(fast),
    groupCountShortcut: detectGroupedNodeCount(fast),
    groupHopShortcut: detectGroupedHopCount(fast),
    reachShortcut: detectReachableShortcut(fast, clauses),
    hopProjection: detectHopProjection(fast, clauses),
    hopAggregate: detectHopAggregate(fast, clauses),
    multiHopAggregate: detectMultiHopAggregate(fast, clauses),
    distinctProjection: detectDistinctProjection(fast, clauses),
    distinctCount: detectDistinctCount(fast, clauses),
    nodeProjection: detectNodeProjection(fast, clauses),
    nodeAggregate: detectNodeAggregate(fast, clauses),
    multiNodeAggregate: detectMultiNodeAggregate(fast, clauses),
    groupedNodeAggregate: detectGroupedNodeAggregate(fast, clauses),
    groupedHopAggregate: detectGroupedHopAggregate(fast, clauses),
  };
};

// --- write clauses -----------------------------------------------------------

export const isEdge = (v: unknown): v is Edge => isEdgeShaped(v);
export const isElement = (v: unknown): v is Vertex | Edge =>
  typeof v === 'object' && v !== null && 'id' in v;
// The structural guards live in `@lenke/core`: both engines ask this question of
// the values in their streams, and it has to have ONE answer. This used to read
// "an element that is not an edge", which called `{id, from}` with no `to` a
// vertex where the Gremlin engine did not.
export const isVertex = (v: unknown): v is Vertex => isVertexShaped(v);

// Statement execution: writes, clause processing, set ops (see executor/clauses.ts).
import {
  combineRows,
  mapToRow,
  matchClauseBindings,
  procedureSpec,
  queryHasWrite,
  runLinear,
  runTxControl,
} from './executor/clauses.js';
// Imported at FUNCTION level like the other detectors — this module and `executor` import
// each other, which the existing comment on the shortcuts import explains is safe.
import {
  detectDistinctCount,
  detectDistinctProjection,
  detectHopAggregate,
  detectHopProjection,
  detectOptionalHopProjection,
  detectMultiHopAggregate,
} from './executor/hop-projection.js';
import type { AlwaysRowsFn, RowsFn } from './executor/hop-projection.js';
// Count / reachability fast-paths (see executor/shortcuts.ts) — this back-edge and
// the shortcuts' import of the trunk's bucket primitives form a safe function-level
// cycle, matching the other executor submodules.
import {
  detectCountShortcut,
  detectVarLengthCount,
  detectGroupedHopCount,
  detectMultiNodeAggregate,
  detectNodeAggregate,
  detectNodeProjection,
  detectForCount,
  detectForProjection,
  detectOptionalHopCount,
  detectGroupedHopAggregate,
  detectGroupedNodeAggregate,
  detectGroupedNodeCount,
  detectReachableShortcut,
  plainNode,
  plainRel,
  side,
  sideOfVertex,
  sideOfVertexGated,
  threeHopSide,
  twoHopSide,
} from './executor/shortcuts.js';
import type { ReachFn, ThreeHopSide, TwoHopSide } from './executor/shortcuts.js';

// --- compile & execute -------------------------------------------------------

/** A whole compiled query: its linear parts and the set operators joining them. */
type CQuery = { parts: readonly CLinear[]; ops: readonly SetOp[] };

/**
 * Revive a single param value: a single-key tagged-temporal object
 * (`{'@date':'…'}`) becomes its `Temporal`, a list has its elements revived
 * (mirroring the Rust param parser, which revives tagged temporals inside a list
 * too), anything else passes through unchanged.
 */
const reviveParamValue = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(reviveParamValue);
  }

  return fromTaggedJson(v) ?? v;
};

/**
 * A param value of `undefined`, a function, or a symbol is dropped by the native
 * FFI's `JSON.stringify` param marshalling, so its binding reads as MISSING there
 * (→ `E_MISSING_PARAMETER`). The TS engine must agree instead of silently
 * evaluating `$name` to `undefined` (which returns `[]` for `WHERE n.x = $name`
 * with no error). (D2)
 */
const isEffectivelyMissing = (v: unknown): boolean =>
  v === undefined || typeof v === 'function' || typeof v === 'symbol';

/**
 * Validate one already-revived param value against the LPG param model, matching
 * the native FFI param decoder (`gql/params.rs`) so both engines accept and reject
 * exactly the same inputs (D3). Accepts a scalar (`string | number | boolean |
 * null`), a revived tagged-temporal instance, or a FLAT list of those. Rejects:
 *   - a `bigint` → `E_INVALID_VALUE` (float64 model; native rejects it JS-side in
 *     `stringifyParams` before the FFI crossing)
 *   - a nested list, or a plain (non-temporal) object → `E_INVALID_VALUE` (native:
 *     "nested arrays are not valid param values" / "the only valid object param
 *     value is a tagged temporal"). These parse as JSON perfectly well and then
 *     break a rule about what a binding may HOLD, so they are value errors, not
 *     JSON ones — and on this engine a param is a JS object with no JSON in
 *     sight. `E_INVALID_JSON` stays for a genuinely malformed document.
 * A tagged-temporal object is already a `Temporal` instance by this point
 * (`reviveParams` ran first), so it passes as a scalar — never mistaken for a
 * rejected plain object.
 */
/**
 * Does `s` contain a lone (unpaired) UTF-16 surrogate? Mirrors
 * `@lenke/serialization`'s `hasLoneSurrogate` (duplicated to avoid a package
 * dependency): the native store is UTF-8 and rejects a lone surrogate as it
 * JSON-decodes a param crossing the FFI boundary, so the TS param path must
 * reject it too for byte-identity (a JS string can carry one; native cannot).
 */
const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff) {
      // `charCodeAt` past the end is NaN; the positive-form test treats an
      // end-of-string high surrogate (no following low) as lone.
      const next = s.charCodeAt(i + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }

      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }

  return false;
};

const validateParamScalar = (name: string, v: unknown): void => {
  if (typeof v === 'string') {
    if (hasLoneSurrogate(v)) {
      throw new LenkeError(
        `parameter $${name} is a string containing a lone (unpaired) UTF-16 surrogate, ` +
          `which is not a valid Unicode scalar in the LPG string model`,
        { code: ErrorCode.InvalidJson, details: { param: name } },
      );
    }

    return;
  }

  if (v === null || typeof v === 'boolean' || typeof v === 'number' || isTemporal(v)) {
    return;
  }

  if (typeof v === 'bigint') {
    throw new LenkeError(
      `a bigint parameter ($${name}) is not supported: the numeric model is float64 — ` +
        `pass Number(x) or a string`,
      { code: ErrorCode.InvalidValue, details: { param: name } },
    );
  }

  throw new LenkeError(
    `parameter $${name} is outside the LPG param model: only a scalar, a flat list ` +
      `of scalars, or a tagged-temporal object is a valid param value`,
    { code: ErrorCode.InvalidValue, details: { param: name } },
  );
};

const validateParamValue = (name: string, v: unknown): void => {
  if (Array.isArray(v)) {
    for (const el of v) {
      if (Array.isArray(el)) {
        throw new LenkeError(`parameter $${name}: nested arrays are not valid param values`, {
          code: ErrorCode.InvalidValue,
          details: { param: name },
        });
      }

      validateParamScalar(name, el);
    }

    return;
  }

  validateParamScalar(name, v);
};

/** Revive every param value, sharing the input object when nothing changed. */
const reviveParams = (params: Params): Params => {
  let out: Params | null = null;

  for (const key of Object.keys(params)) {
    const revived = reviveParamValue(params[key]);

    if (revived !== params[key]) {
      out ??= { ...params };
      out[key] = revived;
    }
  }

  return out ?? params;
};

/**
 * Compile a parsed query into a reusable `Plan`. All graph/param-independent
 * work — operator dispatch, aggregate detection, alias resolution, label-seed
 * selection — happens here, once. Run the returned plan against any graph and
 * params; it never re-parses or re-analyzes.
 */
export const compile = <R extends Row = Row>(query: Query): Plan<R> => {
  // Eager scope validation: a reference to an unbound variable faults NOW (at compile),
  // matching the native engine and ISO GQL / Cypher — not a silent null at run time. Each
  // set-op part is its own scope (starts empty).
  for (const part of query.parts) {
    checkLinearScope(part.clauses, new Set());
  }

  const referenced = new Set<string>();
  const unknownFns = new Set<string>();
  const countParams = new Set<string>();
  const prevParam = paramCollector;
  const prevUnknown = unknownFnCollector;
  const prevCount = countParamCollector;
  const prevMemo = memoUncorrelated;
  paramCollector = referenced;
  unknownFnCollector = unknownFns;
  countParamCollector = countParams;
  // A WRITE anywhere in the query can change an uncorrelated subquery's answer between rows,
  // so the whole query opts out rather than trying to reason about clause order.
  memoUncorrelated = !queryHasWrite(query);

  let compiled: CQuery;

  try {
    compiled = { parts: query.parts.map(compileLinear), ops: query.ops };
  } finally {
    paramCollector = prevParam;
    unknownFnCollector = prevUnknown;
    countParamCollector = prevCount;
    memoUncorrelated = prevMemo;
  }

  // Eager unknown-function rejection: a name the query references that resolves
  // to no scalar (or aggregate) function is never valid — throw NOW, at compile
  // time, before the plan runs, so `compile(parse(q))` / `query(...)` faults
  // identically over zero rows, one row, or a never-taken branch. Matches the
  // Rust engine, which raises the same coded error from `run_cquery_body` off the
  // plan's `unknown_fns`. The message names the offending function(s) verbatim.
  if (unknownFns.size > 0) {
    const named = [...unknownFns].map((n) => `${n}()`).join(', ');

    throw new LenkeError(`call to an unknown or unimplemented function: ${named}`, {
      code: ErrorCode.UnknownFunction,
    });
  }

  const names = [...referenced];
  const countNames = [...countParams];

  // Rows are `Row` at runtime; `R` is the caller's asserted shape (see `Plan`).
  const plan: Plan = (graph, rawParams = {}) => {
    // Revive any single-key tagged-temporal object param (`{'@date':'…'}`,
    // `@datetime`, `@localtime`, `@zoned_time`, `@zoned_datetime`, `@duration`)
    // into its temporal value, so the engine's OWN tagged output round-trips as
    // an input param. The Rust engine already does this while parsing its param
    // string (`temporal_object`); this closes the byte-identity gap.
    const params = reviveParams(rawParams);

    // A new run: invalidate anything this plan's closures cached for the LAST run
    // (see `execEpoch` — currently the `in` arm's hashed closed haystack). Bumped
    // before any row is produced, so the haystack is rebuilt from THIS call's params.
    //
    // Only plan execution needs this. `compileValidator` passes `params: {}`, so a
    // validator's closed haystack is either all-literal (hashed at compile time and
    // never re-read) or an unbound param, whose value is the same on every call.
    execEpoch++;

    // Eager param validation: a `$name` the query references but the caller
    // didn't bind is a programming error — throw before running, not a silent
    // empty result. (The Rust engine does the same in `positional`.)
    for (const name of names) {
      const present = Object.hasOwn(params, name);
      const value = present ? params[name] : undefined;

      // The reserved `$__now` (from a bare `current_*` function) is optional: an
      // unsupplied `now` reads as NULL (so `current_date` → null), not an error.
      // A bound value of `undefined`/function/symbol counts as MISSING too (D2),
      // because native's `JSON.stringify` param marshalling drops such keys.
      if (name !== '__now' && (!present || isEffectivelyMissing(value))) {
        throw new LenkeError(`missing parameter: $${name}`, {
          code: ErrorCode.MissingParameter,
          details: { param: name },
        });
      }

      // Validate the value against the LPG param model — the same rules the native
      // FFI decoder enforces (D3): a bigint is rejected (float64 model), and a
      // nested list / plain (non-temporal) object is rejected rather than reaching
      // the engine as a silent no-op. Skips `$__now` when it wasn't supplied.
      if (present && !isEffectivelyMissing(value)) {
        validateParamValue(name, value);
      }
    }

    // Eager LIMIT/OFFSET bound-value validation: a `$param` used as a bound must
    // resolve to a non-negative integer. Checked here, before any row is produced,
    // so a bad bound faults identically over zero rows or many — mirroring the Rust
    // engine's `check_count_params`. (Missing/bigint binds are already caught above.)
    for (const name of countNames) {
      const v = params[name];

      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new LenkeError('a LIMIT/OFFSET parameter must resolve to a non-negative integer', {
          code: ErrorCode.InvalidValue,
          details: { param: name },
        });
      }
    }

    let rows = runLinear(compiled.parts[0], graph, params);
    compiled.ops.forEach((op, i) => {
      rows = combineRows(op, rows, runLinear(compiled.parts[i + 1], graph, params));
    });

    return rows;
  };

  return plan as Plan<R>;
};

/**
 * Compile and run a parsed statement in one call (no plan reuse). A
 * transaction-control command (`START TRANSACTION`/`COMMIT`/`ROLLBACK`) drives the
 * session's transaction frame and returns no rows; a linear query compiles and
 * runs as usual. READ ONLY enforcement lives here, at the statement level: a write
 * statement (any INSERT/MERGE/SET/REMOVE/DELETE) run while the active transaction
 * is READ ONLY is rejected *before* it applies — no mutator is touched.
 */
/**
 * Compiled plans by their AST, so a repeated statement is compiled once.
 *
 * Item 228 cached PARSE; `compile` is the other ~3.5us of a cheap query's fixed cost. Together they
 * take an indexed point lookup from ~8.8us to ~0.8us.
 *
 * ### Why reuse is sound
 *
 * `compile(query: Query): Plan` takes NO GRAPH — the type says a plan cannot depend on one — and a
 * plan's validation stays per-execution: reusing one with a missing parameter still raises
 * `E_MISSING_PARAMETER`, exactly as a fresh compile does. Verified alongside reuse with different
 * parameters and across two different graphs before this was written.
 *
 * ### Why a WeakMap, and why item 228's admission filter is NOT needed here
 *
 * Item 228 needed one because a `Map` RETAINS: it kept ~2KB statements alive across 64 further
 * allocations, which tenured them and cost 16% on a miss-heavy workload. A `WeakMap` key is weak,
 * so a plan lives exactly as long as the AST it was compiled from — a single-use statement's plan
 * dies with it, at the end of the call. No cap, no eviction, no admission: the plans retained are
 * bounded by whatever retains ASTs, which is item 228's 64-entry parse cache.
 *
 * That reasoning was NOT taken on trust. An all-miss workload (a value interpolated into the text,
 * so every call is a fresh AST) measures **0.99x with ranges overlapping** — flat. An earlier
 * reading of 0.76x on a growing-graph INSERT drove a whole redesign before the workload itself was
 * checked and found to span 7.13-31.25us, which cannot resolve a 20% effect. The redesign was
 * reverted; see the audit entry, because the lesson is worth more than the code was.
 *
 * The guards below stay per-call on purpose: transaction control and the read-only check are
 * properties of the graph and the moment, not of the statement, and must never be cached.
 */
const planCache = new WeakMap<Query, Plan<Row>>();

export const execute = <R extends Row = Row>(
  stmt: Statement,
  graph: Graph,
  params: Params = {},
): R[] => {
  if (isTxControl(stmt)) {
    runTxControl(stmt, graph);

    return [];
  }

  if (graph.isReadOnlyTransaction() && queryHasWrite(stmt)) {
    throw new LenkeError('write statement rejected: the active transaction is READ ONLY', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const hit = planCache.get(stmt);

  if (hit !== undefined) {
    return hit(graph, params) as R[];
  }

  // `R` is phantom — `compile` casts rather than reading it — so one stored plan serves every
  // caller's row type.
  const plan = compile<Row>(stmt);

  planCache.set(stmt, plan);

  return plan(graph, params) as R[];
};
