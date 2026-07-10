import type { Edge, Graph, IndexableValue, RangeBound, Vertex } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';
import { filter, flatMap, map, skip, take, toArray } from '@lenke/fp';

import type {
  ArithOp,
  Clause,
  CompareOp,
  Expr,
  LabelExpr,
  LinearQuery,
  NodePattern,
  PathPattern,
  Projection,
  PropertyConstraint,
  Query,
  RelPattern,
  RemoveItem,
  SetItem,
  SetOp,
} from './ast.js';
import {
  candidateCount,
  candidateVertices,
  expand,
  hasIncidentEdges,
  labelsMatch,
  matchesLabel,
} from './graph-queries.js';

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
type Binding = ReadonlyMap<string, unknown>;

/** A projected result row: alias/derived-name -> value. */
export type Row = Record<string, unknown>;

/** Query parameters (`$name`), supplied at run time and threaded through plans. */
type Params = Record<string, unknown>;

/**
 * The environment a compiled expression evaluates against: the current binding,
 * the query params, the graph (only EXISTS/COUNT subqueries read it), and — for
 * aggregates — the `group` of bindings being folded. Passing this explicitly
 * keeps expression evaluation a pure function of its inputs (no run-state global).
 */
type EvalEnv = {
  binding: Binding;
  params: Params;
  graph: Graph;
  group?: readonly Binding[];
};

/**
 * A compiled expression. The structural `switch (expr.kind)` happens once, at
 * compile time; what's left is this closure, evaluated against an `EvalEnv`.
 */
type CompiledExpr = (env: EvalEnv) => unknown;

/**
 * A reusable execution plan: bind a graph and params, get rows. This is the
 * artifact `compile` produces — analyze once, run many.
 */
export type Plan = (graph: Graph, params?: Params) => Row[];

// --- binding helpers ---------------------------------------------------------

const withBinding = (binding: Binding, name: string | undefined, value: Bound): Binding => {
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
const consistent = (binding: Binding, name: string | undefined, value: Bound): boolean => {
  if (!name) {
    return true;
  }

  const existing = binding.get(name);

  return existing === undefined || existing === value;
};

// ISO GQL: accessing a property that is absent — or a property of a NULL element
// (e.g. an unmatched OPTIONAL variable) — yields NULL, not `undefined`. Coalesce
// here so the whole pipeline (output rows, IS NULL, arithmetic) sees ISO's NULL.
const propOf = (bound: unknown, key: string): unknown =>
  (bound as { properties?: Record<string, unknown> } | undefined)?.properties?.[key] ?? null;

// --- three-valued logic & scalar helpers -------------------------------------

// ISO three-valued (Kleene) logic: `null` is UNKNOWN. A row is kept only when a
// predicate evaluates to exactly `true` (see callers comparing `=== true`).
type Truth = boolean | null;
const isNullish = (v: unknown): boolean => v === null || v === undefined;
const asTruth = (v: unknown): Truth => (isNullish(v) ? null : Boolean(v));
const not3 = (t: Truth): Truth => (t === null ? null : !t);
const and3 = (a: Truth, b: Truth): Truth => {
  if (a === false || b === false) {
    return false;
  }

  return a === null || b === null ? null : true;
};
const or3 = (a: Truth, b: Truth): Truth => {
  if (a === true || b === true) {
    return true;
  }

  return a === null || b === null ? null : false;
};
const xor3 = (a: Truth, b: Truth): Truth => (a === null || b === null ? null : a !== b);
/** The binary three-valued connectives, keyed by AST node kind. */
const BOOL3: Record<'and' | 'or' | 'xor', (a: Truth, b: Truth) => Truth> = {
  and: and3,
  or: or3,
  xor: xor3,
};

/** Raise an ISO data exception (SQLSTATE class 22): a runtime value/type fault. */
const dataException = (message: string): never => {
  throw new LenkeError(message, { code: ErrorCode.DataException });
};

const typeName = (v: unknown): string => {
  if (Array.isArray(v)) {
    return 'a list';
  }

  if (v !== null && typeof v === 'object') {
    return 'a graph element';
  }

  return typeof v;
};

// ISO arithmetic operands must be numbers (or NULL, which propagates). A
// non-numeric value is a data exception, not a silent `Number()` coercion to
// NaN — `'abc' + 1` and `true * 2` raise rather than producing garbage.
const numOf = (v: unknown): number | null => {
  if (isNullish(v)) {
    return null;
  }

  if (typeof v === 'number') {
    return v;
  }

  return dataException(`arithmetic requires a number, got ${typeName(v)}`);
};

// `v IN list` is a three-valued OR of equalities `v = e` over the elements,
// whose identity (empty list) is FALSE. So `null IN []` is FALSE — there is
// nothing to be uncertain about — while `null IN [1]` and `3 IN [1, null]` are
// UNKNOWN. A TRUE equality short-circuits past any UNKNOWN.
// Structural value equality — lists compare by length then element-wise, matching
// the Rust engine's `val_eq`. (TS previously used reference identity, so
// `[1,2] = [1,2]` disagreed between the two engines.) A null list element compares
// equal here, same as Rust; strict ISO three-valued list equality would be
// UNKNOWN when an element is null — a documented, engine-symmetric deviation.
const structuralEq = (a: unknown, b: unknown): boolean => {
  const aList = Array.isArray(a);
  const bList = Array.isArray(b);

  if (aList && bList) {
    return a.length === b.length && a.every((x, i) => structuralEq(x, b[i]));
  }

  if (aList || bList) {
    return false;
  }

  return a === b;
};

const inList = (v: unknown, list: unknown): Truth => {
  if (!Array.isArray(list)) {
    return null;
  }

  let sawUnknown = false;

  for (const e of list) {
    if (isNullish(v) || isNullish(e)) {
      sawUnknown = true;
      continue;
    }

    if (structuralEq(e, v)) {
      return true;
    }
  }

  return sawUnknown ? null : false;
};

/** Binary operators resolved to a function once, at compile time. */
const ARITH: Record<ArithOp, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};
const COMPARE: Record<CompareOp, (a: number | string, b: number | string) => boolean> = {
  '=': (a, b) => a === b,
  '<>': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
};

type FuncExpr = Extract<Expr, { kind: 'func' }>;

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'collect_list']);

/** Does an expression contain an aggregate anywhere (→ implicit grouping)? */
const hasAggregate = (expr: Expr): boolean => {
  switch (expr.kind) {
    case 'func':
      return AGGREGATES.has(expr.name) || expr.args.some(hasAggregate);
    case 'neg':
    case 'not':
    case 'isNull':
    case 'isTruth':
    case 'isLabeled':
      return hasAggregate(expr.expr);
    case 'arith':
    case 'concat':
    case 'and':
    case 'or':
    case 'xor':
    case 'compare':
      return hasAggregate(expr.left) || hasAggregate(expr.right);
    case 'in':
      return hasAggregate(expr.expr) || hasAggregate(expr.list);
    case 'list':
      return expr.items.some(hasAggregate);
    case 'case':
      return (
        (expr.subject ? hasAggregate(expr.subject) : false) ||
        expr.whens.some((w) => hasAggregate(w.when) || hasAggregate(w.then)) ||
        (expr.elseExpr ? hasAggregate(expr.elseExpr) : false)
      );
    default:
      return false;
  }
};

// ISO `<numeric value function>` unary forms, keyed by function name. Each takes
// a single number; null in → null out is handled by the caller.
const UNARY_NUM: Record<string, (n: number) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  ceiling: Math.ceil,
  floor: Math.floor,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (n) => 1 / Math.tan(n),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  degrees: (n) => (n * 180) / Math.PI,
  radians: (n) => (n * Math.PI) / 180,
};

const str = (v: unknown): string => String(v);

/** ISO unary string value functions: one string in, a value out. */
const UNARY_STR: Record<string, (s: string) => unknown> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  trim: (s) => s.trim(),
  btrim: (s) => s.trim(),
  ltrim: (s) => s.replace(/^\s+/, ''),
  rtrim: (s) => s.replace(/\s+$/, ''),
  char_length: (s) => s.length,
  character_length: (s) => s.length,
};

/** ISO binary numeric value functions: LOG takes (base, value). */
const BINARY_NUM: Record<string, (x: number, y: number) => number> = {
  power: (x, y) => x ** y,
  mod: (x, y) => x % y,
  log: (base, value) => Math.log(value) / Math.log(base),
};

/** Scalar (non-aggregate) functions: the ISO numeric/string value functions. */
const callScalar = (name: string, args: readonly unknown[]): unknown => {
  const [a, b] = args;
  const unaryNum = UNARY_NUM[name];

  if (unaryNum) {
    return isNullish(a) ? null : unaryNum(Number(a));
  }

  const unaryStr = UNARY_STR[name];

  if (unaryStr) {
    return isNullish(a) ? null : unaryStr(str(a));
  }

  const binaryNum = BINARY_NUM[name];

  if (binaryNum) {
    return isNullish(a) || isNullish(b) ? null : binaryNum(Number(a), Number(b));
  }

  switch (name) {
    case 'size':
    case 'length':
      if (isNullish(a)) {
        return null;
      }

      return Array.isArray(a) || typeof a === 'string' ? a.length : null;
    case 'left':
      return isNullish(a) || isNullish(b) ? null : str(a).slice(0, Math.max(0, Number(b)));
    case 'right': {
      if (isNullish(a) || isNullish(b)) {
        return null;
      }

      const s = str(a);
      const n = Number(b);

      return n <= 0 ? '' : s.slice(Math.max(0, s.length - n));
    }
    case 'coalesce':
      return args.find((x) => !isNullish(x)) ?? null;
    case 'nullif':
      // ISO `<case abbreviation>`: NULLIF(a, b) = NULL when a = b, else a.
      return !isNullish(a) && !isNullish(b) && a === b ? null : (a ?? null);
    case 'element_id':
      // ISO `<element_id function>`: the identifier of a node or edge.
      return a && typeof a === 'object' && 'id' in a ? (a as { id: unknown }).id : null;
    default:
      // Graph/conversion/string/list functions live in a second dispatcher so
      // neither switch exceeds the complexity budget.
      return callExtendedScalar(name, args);
  }
};

// --- ISO graph / conversion / string-list scalar functions -------------------
// Split out of `callScalar` (complexity budget). Semantics mirror the Rust
// engine (`gql/eval.rs`) byte-for-byte so both engines agree: labels/keys are
// sorted, slices are UTF-16-safe, `null` in → `null` out, and an unknown name is
// an `Unsupported` fault — never a silent `null`.

// Strict numeric-string parse matching Rust's `str::trim().parse::<f64>()`: the
// WHOLE trimmed string must be a finite decimal (optional sign, integer/fraction,
// exponent). `Number.parseFloat` is lenient — it would read `'12abc'` as `12`,
// diverging from the Rust engine — so we gate on the grammar first. Exotic forms
// (`inf`, `nan`, hex) are out of scope and yield null on both engines' common path.
const FINITE_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const numericStringToFloat = (s: string): number | null => {
  const t = s.trim();

  return FINITE_NUMERIC.test(t) ? Number.parseFloat(t) : null;
};

const toIntScalar = (a: unknown): number | null => {
  if (isNullish(a)) {
    return null;
  }

  if (typeof a === 'number') {
    return Math.trunc(a);
  }

  const p = numericStringToFloat(str(a));

  return p === null ? null : Math.trunc(p);
};

const toFloatScalar = (a: unknown): number | null => {
  if (isNullish(a)) {
    return null;
  }

  if (typeof a === 'number') {
    return a;
  }

  return numericStringToFloat(str(a));
};

const substringScalar = (a: unknown, b: unknown, len: unknown): string | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const s = str(a);
  const start = Math.max(0, Number(b));

  return isNullish(len) ? s.slice(start) : s.slice(start, start + Math.max(0, Number(len)));
};

const splitScalar = (a: unknown, b: unknown): string[] | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const delim = str(b);

  // Code-point spread is deliberate: it mirrors Rust's `s.chars()` so an
  // empty-delimiter split is byte-identical across engines.
  // oxlint-disable-next-line typescript/no-misused-spread
  return delim === '' ? [...str(a)] : str(a).split(delim);
};

const replaceScalar = (a: unknown, b: unknown, repl: unknown): string | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const search = str(b);

  return search === ''
    ? str(a)
    : str(a)
        .split(search)
        .join(isNullish(repl) ? '' : str(repl));
};

const headScalar = (a: unknown): unknown => (Array.isArray(a) && a.length > 0 ? a[0] : null);

const lastScalar = (a: unknown): unknown =>
  Array.isArray(a) && a.length > 0 ? a[a.length - 1] : null;

const reverseScalar = (a: unknown): unknown => {
  if (isNullish(a)) {
    return null;
  }

  if (Array.isArray(a)) {
    return [...a].reverse();
  }

  // Code-point reversal mirrors Rust's `s.chars().rev()` (byte-identical).
  // oxlint-disable-next-line typescript/no-misused-spread
  return typeof a === 'string' ? [...a].reverse().join('') : null;
};

const callExtendedScalar = (name: string, args: readonly unknown[]): unknown => {
  const [a, b] = args;

  switch (name) {
    // --- graph functions (label/key order sorted for cross-engine parity) ---
    case 'labels':
      return isVertex(a) ? [...a.labels].sort() : null;
    case 'type':
      return isEdge(a) ? ([...a.labels][0] ?? '') : null;
    case 'keys':
      return isElement(a) ? Object.keys(a.properties).sort() : null;
    // --- conversion (null in → null out) ---
    case 'tostring':
    case 'to_string':
      return isNullish(a) ? null : str(a);
    case 'tointeger':
    case 'to_integer':
      return toIntScalar(a);
    case 'tofloat':
    case 'to_float':
      return toFloatScalar(a);
    // --- string / list ---
    case 'substring':
      return substringScalar(a, b, args[2]);
    case 'split':
      return splitScalar(a, b);
    case 'replace':
      return replaceScalar(a, b, args[2]);
    case 'head':
      return headScalar(a);
    case 'last':
      return lastScalar(a);
    case 'reverse':
      return reverseScalar(a);
    default:
      throw new LenkeError(`call to an unknown or unimplemented function: ${name}()`, {
        code: ErrorCode.Unsupported,
      });
  }
};

// --- expression compilation --------------------------------------------------

/**
 * Lower an expression to a closure. Every `case` resolves its sub-expressions
 * to closures *now* and captures them, so the run-time path is plain function
 * application — no AST re-traversal, no `kind`/`op` dispatch.
 */
const compileExpr = (expr: Expr): CompiledExpr => {
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

      // Own-property only: a query text referencing `$__proto__` / `$constructor`
      // must read undefined (an unbound param), never `Object.prototype`. The
      // Rust engine is immune (params live in a HashMap); this matches it. A
      // param the caller genuinely passed under that key is an own property and
      // still resolves.
      return (env) => (Object.hasOwn(env.params, name) ? env.params[name] : undefined);
    }
    case 'prop': {
      const { variable, key } = expr;

      return (env) => propOf(env.binding.get(variable), key);
    }
    case 'list': {
      const items = expr.items.map(compileExpr);

      return (env) => items.map((f) => f(env));
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
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      const { op } = expr;
      const fn = ARITH[op];

      return (env) => {
        const lv = numOf(l(env));
        const rv = numOf(r(env));

        if (lv === null || rv === null) {
          return null;
        }

        // ISO: division/modulo by zero is a data exception, not Infinity/NaN.
        if ((op === '/' || op === '%') && rv === 0) {
          return dataException('division by zero');
        }

        return fn(lv, rv);
      };
    }
    case 'concat': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);

      return (env) => {
        const lv = l(env);
        const rv = r(env);

        return isNullish(lv) || isNullish(rv) ? null : String(lv) + String(rv);
      };
    }
    case 'not': {
      const fn = compileExpr(expr.expr);

      return (env) => not3(asTruth(fn(env)));
    }
    case 'and':
    case 'or':
    case 'xor': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      const fn = BOOL3[expr.kind];

      return (env) => fn(asTruth(l(env)), asTruth(r(env)));
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
      // `x IS [NOT] TRUE|FALSE|UNKNOWN` collapses three-valued logic to a
      // definite boolean: it tests whether x's truth value equals the target.
      const fn = compileExpr(expr.expr);
      const { truth, negated } = expr;

      return (env) => {
        const matches = asTruth(fn(env)) === truth;

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
    case 'in': {
      const e = compileExpr(expr.expr);
      const list = compileExpr(expr.list);
      const { negated } = expr;

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

      return (env) => {
        const lv = l(env);
        const rv = r(env);

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

        const t = typeof lv;
        const orderable = t === typeof rv && (t === 'number' || t === 'string' || t === 'boolean');

        if (!orderable) {
          return null; // UNKNOWN
        }

        return fn(lv as number | string, rv as number | string);
      };
    }
    case 'case':
      return compileCase(expr);
    case 'exists':
      return compileExists(expr);
    case 'countSubquery':
      return compileCountSubquery(expr);
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
});

/** ISO EXISTS: TRUE iff the correlated sub-pattern has at least one match. */
const compileExists = (expr: Extract<Expr, { kind: 'exists' }>): CompiledExpr => {
  const sub = compileSubMatch(expr);

  return (env) => {
    const matches = matchClauseBindings(env.graph, sub, env.binding, env.params)[Symbol.iterator]();

    return !matches.next().done;
  };
};

/** ISO count subquery: the number of matches of the correlated sub-pattern. */
const compileCountSubquery = (expr: Extract<Expr, { kind: 'countSubquery' }>): CompiledExpr => {
  const sub = compileSubMatch(expr);

  return (env) => [...matchClauseBindings(env.graph, sub, env.binding, env.params)].length;
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

        // `subject = when` with SQL/ISO null semantics: NULL never matches.
        if (!isNullish(s) && !isNullish(wv) && s === wv) {
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

  return (env) =>
    callScalar(
      name,
      args.map((f) => f(env)),
    );
};

/**
 * Compile an aggregate. The argument expression is lowered once; at run time we
 * fold it over the `group` of bindings (or `[binding]` when called outside an
 * aggregating projection).
 */
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

  const argFn = expr.args[0] ? compileExpr(expr.args[0]) : undefined;

  return (env) => {
    const group = env.group ?? [env.binding];

    if (name === 'count' && star) {
      return group.length;
    }

    const raw = group.map((b) => argFn!({ ...env, binding: b, group }));
    const nonNull = raw.filter((v) => !isNullish(v));
    const values = distinct ? [...new Set(nonNull)] : nonNull;

    switch (name) {
      case 'count':
        return values.length;
      case 'sum':
        return values.reduce<number>((s, v) => s + Number(v), 0);
      case 'avg':
        return values.length === 0
          ? null
          : values.reduce<number>((s, v) => s + Number(v), 0) / values.length;
      case 'min':
        return values.length === 0
          ? null
          : values.reduce((m, v) => (compareValues(v, m) < 0 ? v : m));
      case 'max':
        return values.length === 0
          ? null
          : values.reduce((m, v) => (compareValues(v, m) > 0 ? v : m));
      case 'collect_list':
        return values;
      default:
        return null;
    }
  };
};

// --- value / ordering helpers ------------------------------------------------

/** Derive a column name for a RETURN item that has no explicit `AS` alias. */
const columnName = (expr: Expr): string => {
  switch (expr.kind) {
    case 'var':
      return expr.name;
    case 'prop':
      return `${expr.variable}.${expr.key}`;
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
      return 3; // graph elements, lists, other objects
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

  const x = a as number | string;
  const y = b as number | string;

  if (x < y) {
    return -1;
  }

  return x > y ? 1 : 0;
};

/**
 * Compare two ORDER BY keys, honoring direction and ISO `NULLS FIRST/LAST`. Null
 * placement is absolute (first or last in the final order), independent of the
 * direction applied to non-null values. With no explicit null ordering it
 * defaults to treating null as the largest value (ASC → last, DESC → first).
 */
const compareSort = (
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
    const first = nullsFirst ?? descending;

    return aNull === first ? -1 : 1;
  }

  return compareValues(a, b) * (descending ? -1 : 1);
};

/** Stable distinct key for a projected binding; graph elements key by id. */
const valueKey = (v: unknown): string => {
  if (v && typeof v === 'object' && 'id' in v) {
    return `@${String((v as { id: unknown }).id)}`;
  }

  // `JSON.stringify` maps NaN and ±Infinity all to `"null"`, collapsing them
  // into the real-null group (and each other). Tag non-finite numbers distinctly.
  if (typeof v === 'number' && !Number.isFinite(v)) {
    return `#${String(v)}`;
  }

  return JSON.stringify(v) ?? 'undefined';
};
const rowKey = (b: Binding): string => [...b].map(([k, v]) => `${k}=${valueKey(v)}`).join('');

// --- projection compilation --------------------------------------------------

/** A projected output column: its name and the closure producing its value. */
type CReturnItem = { name: string; fn: CompiledExpr; isAgg: boolean };
type CSortItem = { fn: CompiledExpr; descending: boolean; nullsFirst?: boolean };

/**
 * A compiled projection body (shared by `RETURN` and `WITH`). All the structural
 * analysis — alias resolution, aggregate detection, picking the GROUP BY keys —
 * is done here, once.
 */
type CProjection = {
  star: boolean;
  distinct: boolean;
  items: readonly CReturnItem[];
  /** True when any non-`*` item aggregates → implicit grouping kicks in. */
  aggregating: boolean;
  /** The non-aggregate item closures, used to build each group's key. */
  groupKeys: readonly CompiledExpr[];
  orderBy: readonly CSortItem[];
  skip?: number;
  limit?: number;
};

const compileProjection = (projection: Projection): CProjection => {
  const items: CReturnItem[] = projection.items.map((i) => ({
    name: i.alias ?? columnName(i.expr),
    fn: compileExpr(i.expr),
    isAgg: hasAggregate(i.expr),
  }));
  const aggregating = !projection.star && items.some((i) => i.isAgg);
  const groupKeys = items.filter((i) => !i.isAgg).map((i) => i.fn);
  // ORDER BY keys are evaluated against the projected output overlaid on the
  // input binding (see `applyProjection`), so output aliases resolve even inside
  // an expression — `ORDER BY n + 2` uses the column `n`, not the input variable.
  const orderBy: CSortItem[] = (projection.orderBy ?? []).map((s) => ({
    fn: compileExpr(s.expr),
    descending: s.descending,
    nullsFirst: s.nullsFirst,
  }));

  return {
    star: projection.star,
    distinct: projection.distinct,
    items,
    aggregating,
    groupKeys,
    orderBy,
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
 * Apply a projection (`RETURN` or `WITH` body) to a set of bindings: implicit
 * grouping/aggregation, then DISTINCT, ORDER BY, SKIP, LIMIT. Returns the
 * projected bindings — `RETURN` turns these into rows, `WITH` feeds them on.
 */
const applyProjection = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Iterable<Binding> => {
  const { orderBy } = proj;
  type Keyed = { b: Binding; keys: readonly unknown[] };
  let keyed: Iterable<Keyed>;

  if (proj.aggregating) {
    // Grouping is a barrier — it must see every binding before it can emit. We
    // still fold into per-group buckets with single `push`es (never a spread).
    const groups = new Map<string, Binding[]>();

    for (const b of bindings) {
      const key = JSON.stringify(
        proj.groupKeys.map((fn) => valueKey(fn({ binding: b, params, graph }))),
      );
      const existing = groups.get(key);

      if (existing) {
        existing.push(b);
      } else {
        groups.set(key, [b]);
      }
    }

    if (groups.size === 0 && proj.groupKeys.length === 0) {
      groups.set('[]', []);
    }

    keyed = map((group: Binding[]) => {
      const rep: Binding = group[0] ?? new Map();
      const projected = projectBinding(proj, rep, params, graph, group);
      // ORDER BY sees the output columns overlaid on the input variables.
      const sortBinding = orderBy.length > 0 ? new Map([...rep, ...projected]) : rep;

      return {
        b: projected,
        keys: orderBy.map((s) => s.fn({ binding: sortBinding, params, graph, group })),
      };
    }, groups.values());
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

  // ORDER BY is the other barrier: materialize, then sort the owned array.
  let ordered: Iterable<Keyed> = keyed;

  if (orderBy.length > 0) {
    const arr = toArray(keyed);
    arr.sort((a, b) => {
      for (let i = 0; i < orderBy.length; i += 1) {
        const s = orderBy[i];
        const cmp = compareSort(a.keys[i], b.keys[i], s.descending, s.nullsFirst);

        if (cmp !== 0) {
          return cmp;
        }
      }

      return 0;
    });
    ordered = arr;
  }

  // SKIP/LIMIT stay lazy — `take` short-circuits, so `LIMIT n` over a huge
  // unordered stream stops after n rows instead of computing them all.
  const start = proj.skip ?? 0;
  let sliced: Iterable<Keyed> = start > 0 ? skip(start, ordered) : ordered;

  if (proj.limit !== undefined) {
    sliced = take(proj.limit, sliced);
  }

  return map((r: Keyed) => r.b, sliced);
};

// --- pattern compilation -----------------------------------------------------

/** A compiled property map + inline WHERE (the ISO element-pattern predicate). */
type CProp = { key: string; value: CompiledExpr };
type CPredicate = { props: readonly CProp[]; where?: CompiledExpr };

/** Range bounds whose endpoints are compiled value closures (resolved per seed). */
type CRangeBound = { gt?: CompiledExpr; gte?: CompiledExpr; lt?: CompiledExpr; lte?: CompiledExpr };

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

type CNode = {
  variable?: string;
  label?: LabelExpr;
  pred: CPredicate;
  seedHints?: readonly CSeedHint[];
};
type CRel = {
  variable?: string;
  label?: LabelExpr;
  direction: RelPattern['direction'];
  pred: CPredicate;
  quantifier?: RelPattern['quantifier'];
};
type CSegment = { rel: CRel; node: CNode };
type CPath = { start: CNode; segments: readonly CSegment[] };

const compileProps = (props: readonly PropertyConstraint[] | undefined): CProp[] =>
  (props ?? []).map(({ key, value }) => ({ key, value: compileExpr(value) }));

const compilePredicate = (
  properties: readonly PropertyConstraint[] | undefined,
  where: Expr | undefined,
): CPredicate => ({
  props: compileProps(properties),
  where: where ? compileExpr(where) : undefined,
});

// --- seed-hint extraction ----------------------------------------------------

/** A value usable as a seek key without binding the node's own variable. */
const isConstExpr = (e: Expr): boolean => e.kind === 'lit' || e.kind === 'param';

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
const collectHints = (where: Expr, into: HintMap): void => {
  switch (where.kind) {
    case 'and':
      collectHints(where.left, into);
      collectHints(where.right, into);

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
      if (
        !where.negated &&
        where.expr.kind === 'prop' &&
        where.list.kind === 'list' &&
        where.list.items.every(isConstExpr)
      ) {
        pushHint(into, where.expr.variable, {
          kind: 'within',
          key: where.expr.key,
          values: compileExpr(where.list),
        });
      }

      return;
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
    pred: compilePredicate(node.properties, node.where),
    seedHints: seedHints.length > 0 ? seedHints : undefined,
  };
};

const compileRel = (rel: RelPattern): CRel => {
  // A variable-length segment reaches a *set* of far vertices; it does not bind
  // a single edge, so a bound edge variable or a per-edge predicate cannot be
  // honored. Rather than silently ignore them (returning unbound/unfiltered
  // results), reject at compile time. ISO would bind a group variable / list of
  // edges here — not yet implemented.
  if (rel.quantifier && (rel.variable !== undefined || rel.properties?.length || rel.where)) {
    throw new LenkeError(
      'A variable-length relationship cannot bind an edge variable or carry a per-edge predicate (not yet supported)',
      { code: ErrorCode.Unsupported },
    );
  }

  return {
    variable: rel.variable,
    label: rel.label,
    direction: rel.direction,
    pred: compilePredicate(rel.properties, rel.where),
    quantifier: rel.quantifier,
  };
};

const compilePath = (pattern: PathPattern): CPath => ({
  start: compileNode(pattern.start),
  segments: pattern.segments.map(({ rel, node }) => ({
    rel: compileRel(rel),
    node: compileNode(node),
  })),
});

/**
 * The ISO element-pattern predicate: every property-map entry must equal the
 * element's stored value, and any inline `WHERE` must hold. Both are evaluated
 * against `binding`, which already includes this element's own variable, so
 * `(n WHERE n.age > 30)` can reference `n`.
 */
const satisfies = (
  element: Bound,
  pred: CPredicate,
  binding: Binding,
  params: Params,
  graph: Graph,
): boolean => {
  const env: EvalEnv = { binding, params, graph };

  for (const { key, value } of pred.props) {
    if (propOf(element, key) !== value(env)) {
      return false;
    }
  }

  return pred.where === undefined || pred.where(env) === true;
};

// --- matching ----------------------------------------------------------------

const matchNode = (
  binding: Binding,
  node: CNode,
  vertex: Vertex,
  params: Params,
  graph: Graph,
): Binding | null => {
  if (!matchesLabel(vertex, node.label)) {
    return null;
  }

  if (!consistent(binding, node.variable, vertex)) {
    return null;
  }

  const bound = withBinding(binding, node.variable, vertex);

  if (!satisfies(vertex, node.pred, bound, params, graph)) {
    return null;
  }

  return bound;
};

/** A scalar the property index can seek on (mirrors PropertyIndex's IndexableValue). */
const isScalar = (v: unknown): v is IndexableValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

const EMPTY: ReadonlySet<Vertex> = new Set<Vertex>();

/** Resolve a compiled range bound to concrete scalar endpoints, or null. */
const evalBound = (bound: CRangeBound, env: EvalEnv): RangeBound | null => {
  const out: RangeBound = {};
  let any = false;

  for (const key of ['gt', 'gte', 'lt', 'lte'] as const) {
    const fn = bound[key];

    if (!fn) {
      continue;
    }

    const v = fn(env);

    if (!isScalar(v)) {
      return null; // a non-scalar endpoint makes the seek meaningless
    }

    out[key] = v;
    any = true;
  }

  return any ? out : null;
};

/** A seekable predicate: its estimated cardinality and a thunk for the set. */
type SeedCandidate = { count: number; build: () => ReadonlySet<Vertex> };

/**
 * Every index seek a node pattern offers: its ISO equality constraints
 * (`(n {k: v})`) plus the seed hints lifted from WHERE / inline predicates.
 * Each candidate carries a cardinality estimate (computed without touching a
 * set) and a thunk that builds the set only if it's chosen.
 */
const indexCandidates = function* (
  graph: Graph,
  node: CNode,
  env: EvalEnv,
): Iterable<SeedCandidate> {
  const idx = graph.vertexPropertyIndex;
  const eqCandidate = (key: string, v: unknown): SeedCandidate => ({
    count: idx.countEquals(key, v) ?? 0,
    build: () => idx.equals(key, v) ?? EMPTY,
  });

  for (const { key, value } of node.pred.props) {
    if (idx.isIndexed(key)) {
      const v = value(env);

      if (isScalar(v)) {
        yield eqCandidate(key, v);
      }
    }
  }

  for (const hint of node.seedHints ?? []) {
    if (!idx.isIndexed(hint.key)) {
      continue;
    }

    if (hint.kind === 'eq') {
      const v = hint.value(env);

      if (isScalar(v)) {
        yield eqCandidate(hint.key, v);
      }
    } else if (hint.kind === 'within') {
      const list = hint.values(env);

      if (Array.isArray(list) && list.every(isScalar)) {
        let count = 0;

        for (const item of list) {
          count += idx.countEquals(hint.key, item) ?? 0;
        }

        yield {
          count,
          build: () => {
            const out = new Set<Vertex>();

            for (const item of list) {
              for (const vertex of idx.equals(hint.key, item) ?? EMPTY) {
                out.add(vertex);
              }
            }

            return out;
          },
        };
      }
    } else {
      const bound = evalBound(hint.bound, env);

      if (bound) {
        yield {
          count: idx.countRange(hint.key, bound) ?? 0,
          build: () => idx.range(hint.key, bound) ?? EMPTY,
        };
      }
    }
  }
};

/**
 * Seed candidates for a node pattern. An indexed equality / range / `IN` — from
 * an element-pattern map (`(n:Person {name: 'marko'})`) or a seekable WHERE
 * conjunct (`WHERE n.age > 30`) — seeks the index instead of scanning every
 * vertex. The most selective seek (smallest estimated cardinality) is chosen
 * and materialized; `matchNode` and the residual WHERE re-validate the rest, so
 * the seed only has to be a superset. Falls back to the label-narrowed scan
 * when nothing is indexed.
 */
const seedVertices = function* (
  graph: Graph,
  node: CNode,
  binding: Binding,
  params: Params,
): Iterable<Vertex> {
  const env: EvalEnv = { binding, params, graph };
  let best: SeedCandidate | undefined;

  for (const candidate of indexCandidates(graph, node, env)) {
    if (!best || candidate.count < best.count) {
      best = candidate;
    }
  }

  if (best) {
    yield* best.build();

    return;
  }

  yield* candidateVertices(graph, node.label);
};

/** The estimated number of seed vertices for starting a pattern at `node`. */
const estimateSeed = (graph: Graph, node: CNode, binding: Binding, params: Params): number => {
  // An already-bound variable seeds from exactly one vertex.
  if (node.variable && binding.has(node.variable)) {
    return 1;
  }

  const env: EvalEnv = { binding, params, graph };
  let best = Infinity;

  for (const candidate of indexCandidates(graph, node, env)) {
    best = Math.min(best, candidate.count);
  }

  return best === Infinity ? candidateCount(graph, node.label) : best;
};

const FLIP_DIRECTION: Record<RelPattern['direction'], RelPattern['direction']> = {
  out: 'in',
  in: 'out',
  both: 'both',
};

/**
 * Walk a fixed-length path from its other end: reverse the segment order and
 * flip each relationship's direction. The matched bindings are identical (same
 * edges, same nodes); only the seed side — and thus enumeration order — changes.
 */
const reversePath = (path: CPath): CPath => {
  const nodes = [path.start, ...path.segments.map((s) => s.node)];
  const segments: CSegment[] = [];

  for (let i = path.segments.length - 1; i >= 0; i--) {
    const seg = path.segments[i];
    segments.push({
      rel: { ...seg.rel, direction: FLIP_DIRECTION[seg.rel.direction] },
      node: nodes[i],
    });
  }

  return { start: nodes[nodes.length - 1], segments };
};

/**
 * Pick which end of a fixed-length path to seed from: the side with the smaller
 * estimated seed, so the join starts from the more selective anchor. Patterns
 * with a variable-length segment keep their written orientation (reversing a
 * quantified walk is not handled here).
 */
const orient = (graph: Graph, pattern: CPath, binding: Binding, params: Params): CPath => {
  if (pattern.segments.length === 0 || pattern.segments.some((s) => s.rel.quantifier)) {
    return pattern;
  }

  const endNode = pattern.segments[pattern.segments.length - 1].node;
  const startEst = estimateSeed(graph, pattern.start, binding, params);
  const endEst = estimateSeed(graph, endNode, binding, params);

  return endEst < startEst ? reversePath(pattern) : pattern;
};

/** Yield every binding that extends `binding` by matching `pattern`. */
const matchPattern = function* (
  graph: Graph,
  pattern: CPath,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  // Seed from whichever end is more selective, then walk from there.
  const path = orient(graph, pattern, binding, params);

  // Reuse an already-bound vertex if the start variable is known, otherwise
  // seed from an indexed constraint or a label-narrowed scan.
  const seeds: Iterable<Vertex> =
    path.start.variable && binding.has(path.start.variable)
      ? [binding.get(path.start.variable) as Vertex]
      : seedVertices(graph, path.start, binding, params);

  for (const seed of seeds) {
    const seeded = matchNode(binding, path.start, seed, params, graph);

    if (seeded) {
      yield* walkSegments(graph, path, 0, seed, seeded, params);
    }
  }
};

/** Recursively extend a binding across the remaining segments of a pattern. */
const walkSegments = function* (
  graph: Graph,
  pattern: CPath,
  index: number,
  from: Vertex,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  if (index >= pattern.segments.length) {
    yield binding;

    return;
  }

  const { rel, node } = pattern.segments[index];

  // Variable-length: enumerate the endpoint of every trail within [min, max]
  // hops (one per trail → ISO per-path multiplicity), then continue from each.
  // (The edge variable and per-edge predicate aren't bound for var-length
  // segments — rejected at compile time.)
  if (rel.quantifier) {
    for (const end of trailEnds(graph, from, rel, rel.quantifier)) {
      const matched = matchNode(binding, node, end, params, graph);

      if (matched) {
        yield* walkSegments(graph, pattern, index + 1, end, matched, params);
      }
    }

    return;
  }

  for (const { edge, node: nextVertex } of expand(graph, from, rel)) {
    if (!consistent(binding, rel.variable, edge)) {
      continue;
    }

    const withEdge = withBinding(binding, rel.variable, edge);

    if (!satisfies(edge, rel.pred, withEdge, params, graph)) {
      continue;
    }

    const matched = matchNode(withEdge, node, nextVertex, params, graph);

    if (matched) {
      yield* walkSegments(graph, pattern, index + 1, nextVertex, matched, params);
    }
  }
};

/** Per-expansion cap on trail-traversal steps; a guard against exponential blowup. */
const TRAIL_BUDGET = 1_000_000;

/**
 * Endpoints of every *trail* — a path that traverses each relationship at most
 * once (ISO/IEC 39075 default for a quantified path) — from `from` within
 * [min, max] hops of `rel`. Yielded one per trail, so an endpoint reachable by
 * `k` distinct trails is yielded `k` times (ISO per-path multiplicity); a `min`
 * of 0 includes the zero-length trail (the start node itself).
 *
 * Edge-uniqueness bounds a trail's length to the edge count, so this always
 * terminates even on cycles — but the *number* of trails can be exponential, so
 * a per-expansion step budget throws rather than letting a pathological `*`
 * exhaust memory/time.
 */
const trailEnds = function* (
  graph: Graph,
  from: Vertex,
  rel: CRel,
  q: NonNullable<CRel['quantifier']>,
): Iterable<Vertex> {
  if (q.min === 0) {
    yield from;
  }

  const used = new Set<Edge>();
  let steps = 0;

  // Explicit DFS stack — a trail can be as long as the edge count, so recursion
  // would overflow on a long chain. Each frame walks one vertex's outgoing
  // steps; `entry` is the edge taken to reach it, unmarked when the frame pops.
  const stack: {
    iter: Iterator<{ edge: Edge; node: Vertex }>;
    entry: Edge | null;
    depth: number;
  }[] = [{ iter: expand(graph, from, rel)[Symbol.iterator](), entry: null, depth: 0 }];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];

    // Past the max hop → this trail can't extend; backtrack.
    if (q.max !== null && top.depth >= q.max) {
      if (top.entry) {
        used.delete(top.entry);
      }

      stack.pop();
      continue;
    }

    // Each visit advances this frame's iterator by one step (the recursion-free
    // equivalent of the for-loop); when exhausted, backtrack.
    const res = top.iter.next();

    if (res.done) {
      if (top.entry) {
        used.delete(top.entry);
      }

      stack.pop();
      continue;
    }

    const { edge, node } = res.value;

    if (used.has(edge)) {
      continue; // trail: each relationship traversed at most once
    }

    steps += 1;

    if (steps > TRAIL_BUDGET) {
      throw new LenkeError(
        'Variable-length pattern exceeded the trail budget; add a tighter bound',
        { code: ErrorCode.ResourceExhausted },
      );
    }

    used.add(edge);
    const d = top.depth + 1;

    if (d >= q.min) {
      yield node;
    }

    stack.push({ iter: expand(graph, node, rel)[Symbol.iterator](), entry: edge, depth: d });
  }
};

// --- clause compilation ------------------------------------------------------

/** Every variable a pattern introduces (for OPTIONAL MATCH null-binding). */
const patternVars = (patterns: readonly PathPattern[]): string[] => {
  const vars: string[] = [];

  for (const p of patterns) {
    if (p.start.variable) {
      vars.push(p.start.variable);
    }

    for (const { rel, node } of p.segments) {
      if (rel.variable) {
        vars.push(rel.variable);
      }

      if (node.variable) {
        vars.push(node.variable);
      }
    }
  }

  return vars;
};

/** A compiled SET assignment: a label add, or a property set with a value closure. */
type CSetItem =
  | { variable: string; label: string }
  | { variable: string; key: string; value: CompiledExpr };

/** A compiled INSERT node/rel: labels are fixed, property values are closures. */
type CInsertNode = { variable?: string; labels: readonly string[]; props: readonly CProp[] };
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

type CMatch = {
  kind: 'match';
  optional: boolean;
  patterns: readonly CPath[];
  where?: CompiledExpr;
  nullVars: readonly string[];
};
type CWith = { kind: 'with'; projection: CProjection; where?: CompiledExpr };
type CReturn = { kind: 'return'; projection: CProjection };
type CInsert = { kind: 'insert'; patterns: readonly CInsertPath[] };
type CSet = { kind: 'set'; items: readonly CSetItem[] };
type CRemove = { kind: 'remove'; items: readonly RemoveItem[] };
type CDelete = { kind: 'delete'; detach: boolean; targets: readonly CompiledExpr[] };
type CFinish = { kind: 'finish' };
type CClause = CMatch | CWith | CReturn | CInsert | CSet | CRemove | CDelete | CFinish;

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

const compileClause = (clause: Clause): CClause => {
  switch (clause.kind) {
    case 'match': {
      const patterns = clause.patterns.map(compilePath);

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
            start: attach(patterns[i].start),
            segments: patterns[i].segments.map((s) => ({ rel: s.rel, node: attach(s.node) })),
          };
        }
      }

      return {
        kind: 'match',
        optional: clause.optional,
        patterns,
        where: clause.where ? compileExpr(clause.where) : undefined,
        nullVars: clause.optional ? patternVars(clause.patterns) : [],
      };
    }
    case 'with':
      return {
        kind: 'with',
        projection: compileProjection(clause.projection),
        where: clause.where ? compileExpr(clause.where) : undefined,
      };
    case 'return':
      return { kind: 'return', projection: compileProjection(clause.projection) };
    case 'insert':
      return { kind: 'insert', patterns: clause.patterns.map(compileInsertPath) };
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

type CLinear = { clauses: readonly CClause[] };
const compileLinear = (linear: LinearQuery): CLinear => ({
  clauses: linear.clauses.map(compileClause),
});

// --- write clauses -----------------------------------------------------------

const isEdge = (v: unknown): v is Edge =>
  typeof v === 'object' && v !== null && 'from' in v && 'to' in v;
const isElement = (v: unknown): v is Vertex | Edge =>
  typeof v === 'object' && v !== null && 'id' in v;
const isVertex = (v: unknown): v is Vertex => isElement(v) && !isEdge(v);

const evalProps = (
  props: readonly CProp[],
  b: Binding,
  params: Params,
  graph: Graph,
): Record<string, unknown> => {
  const env: EvalEnv = { binding: b, params, graph };
  const out: Record<string, unknown> = {};

  for (const { key, value } of props) {
    out[key] = value(env);
  }

  return out;
};

/** Create a node from a pattern, reusing an already-bound variable. */
const ensureNode = (
  graph: Graph,
  binding: Map<string, unknown>,
  node: CInsertNode,
  params: Params,
): Vertex => {
  if (node.variable && binding.has(node.variable)) {
    return binding.get(node.variable) as Vertex;
  }

  const vertex = graph.addVertex({
    labels: [...node.labels],
    properties: evalProps(node.props, binding, params, graph),
  });

  if (node.variable) {
    binding.set(node.variable, vertex);
  }

  return vertex;
};

const runInsert = (graph: Graph, clause: CInsert, binding: Binding, params: Params): Binding => {
  const out = new Map(binding);

  for (const pattern of clause.patterns) {
    let prev = ensureNode(graph, out, pattern.start, params);

    for (const { rel, node } of pattern.segments) {
      const next = ensureNode(graph, out, node, params);
      const [from, to] = rel.direction === 'in' ? [next, prev] : [prev, next];
      const edge = graph.addEdge({
        from,
        to,
        labels: [...rel.labels],
        properties: evalProps(rel.props, out, params, graph),
      });

      if (rel.variable) {
        out.set(rel.variable, edge);
      }

      prev = next;
    }
  }

  return out;
};

// Both labels and properties go through the element's index-maintaining
// mutators (`addLabelTo*` / `setProperty`) so the graph's label and property
// value indexes stay consistent — a later MATCH seeds from `vertexPropertyIndex`,
// so a direct `el.properties =` write would leave that index stale (and skip
// mutation events).
const runSet = (graph: Graph, clause: CSet, binding: Binding, params: Params): void => {
  for (const item of clause.items) {
    const el = binding.get(item.variable);

    if (!isElement(el)) {
      continue;
    }

    if ('label' in item) {
      if (isEdge(el)) {
        graph.addLabelToEdge(item.label, el);
      } else {
        graph.addLabelToVertex(item.label, el);
      }
    } else {
      el.setProperty(item.key, item.value({ binding, params, graph }));
    }
  }
};

const runRemove = (graph: Graph, clause: CRemove, binding: Binding): void => {
  for (const item of clause.items) {
    const el = binding.get(item.variable);

    if (!isElement(el)) {
      continue;
    }

    if ('label' in item) {
      if (isEdge(el)) {
        graph.removeLabelFromEdge(item.label, el);
      } else {
        graph.removeLabelFromVertex(item.label, el);
      }
    } else {
      el.removeProperty(item.key);
    }
  }
};

const runDelete = (graph: Graph, clause: CDelete, binding: Binding, params: Params): void => {
  for (const target of clause.targets) {
    const el = target({ binding, params, graph });

    if (isEdge(el)) {
      graph.removeEdge(el);
    } else if (isElement(el)) {
      const vertex = el as Vertex;

      // Plain DELETE must not orphan relationships: deleting a still-connected
      // node is a graph violation unless the user opted into DETACH (which
      // cascades the incident edges).
      if (!clause.detach && hasIncidentEdges(graph, vertex)) {
        throw new LenkeError(
          'Cannot delete a node that still has relationships; use DETACH DELETE',
          { code: ErrorCode.InvalidGraphOp },
        );
      }

      graph.removeVertex(vertex);
    }
  }
};

// --- clause processing -------------------------------------------------------

/**
 * Extend a binding through every pattern of a MATCH clause, then filter WHERE.
 * Fully lazy: each pattern is a `flatMap` over the prior stream, so a clause
 * that expands to millions of bindings never materializes them — they flow one
 * at a time to whatever consumes the result.
 */
const matchClauseBindings = (
  graph: Graph,
  clause: CMatch,
  binding: Binding,
  params: Params,
): Iterable<Binding> => {
  let stream: Iterable<Binding> = [binding];

  for (const pattern of clause.patterns) {
    stream = flatMap((b: Binding) => matchPattern(graph, pattern, b, params), stream);
  }

  return clause.where === undefined
    ? stream
    : filter((b: Binding) => clause.where!({ binding: b, params, graph }) === true, stream);
};

/** Per-incoming-binding: stream its matches, or (for OPTIONAL) one null-filled row. */
const matchOrOptional = function* (
  graph: Graph,
  clause: CMatch,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  let matched = false;

  for (const m of matchClauseBindings(graph, clause, binding, params)) {
    matched = true;

    yield m;
  }

  if (!matched && clause.optional) {
    // No match: keep the row with the pattern's new variables set to null.
    const filled = new Map(binding);

    for (const v of clause.nullVars) {
      if (!filled.has(v)) {
        filled.set(v, null);
      }
    }

    yield filled;
  }
};

/** Lazily expand a binding stream through a MATCH — no intermediate array. */
const runMatch = (
  graph: Graph,
  clause: CMatch,
  bindings: Iterable<Binding>,
  params: Params,
): Iterable<Binding> =>
  flatMap((binding: Binding) => matchOrOptional(graph, clause, binding, params), bindings);

const mapToRow = (b: Binding): Row => {
  const row: Row = {};

  for (const [k, v] of b) {
    row[k] = v;
  }

  return row;
};

/** Run one compiled linear query (clause sequence) to result rows. */
const runLinear = (linear: CLinear, graph: Graph, params: Params): Row[] => {
  // Bindings flow as a lazy stream; only barriers (mutations, aggregation,
  // ORDER BY) force materialization — so a streaming read never holds the whole
  // result set in memory.
  let bindings: Iterable<Binding> = [new Map()];

  for (const clause of linear.clauses) {
    switch (clause.kind) {
      case 'match':
        bindings = runMatch(graph, clause, bindings, params);
        break;
      case 'with': {
        const projected = applyProjection(clause.projection, bindings, params, graph);
        bindings =
          clause.where === undefined
            ? projected
            : filter(
                (b: Binding) => clause.where!({ binding: b, params, graph }) === true,
                projected,
              );
        break;
      }
      case 'insert':
        // Mutations must run eagerly and exactly once — force evaluation.
        bindings = toArray(map((b: Binding) => runInsert(graph, clause, b, params), bindings));
        break;
      case 'set': {
        const arr = toArray(bindings);

        for (const b of arr) {
          runSet(graph, clause, b, params);
        }

        bindings = arr;
        break;
      }
      case 'remove': {
        const arr = toArray(bindings);

        for (const b of arr) {
          runRemove(graph, clause, b);
        }

        bindings = arr;
        break;
      }
      case 'delete': {
        const arr = toArray(bindings);

        for (const b of arr) {
          runDelete(graph, clause, b, params);
        }

        bindings = arr;
        break;
      }
      case 'finish':
        return [];
      case 'return':
        return toArray(map(mapToRow, applyProjection(clause.projection, bindings, params, graph)));
    }
  }

  return []; // a write-only query produces no rows
};

// --- set operations ----------------------------------------------------------

/** Stable key for a result row; graph-element columns key by id. */
const rowKeyOf = (row: Row): string =>
  Object.entries(row)
    .map(([k, v]) => `${k}=${valueKey(v)}`)
    .join('');

const distinctRows = (rows: readonly Row[]): Row[] => {
  const seen = new Set<string>();

  return rows.filter((r) => {
    const k = rowKeyOf(r);

    return seen.has(k) ? false : (seen.add(k), true);
  });
};

/** Combine two row sets per a set operator. */
const combineRows = (op: SetOp, left: readonly Row[], right: readonly Row[]): Row[] => {
  const rightKeys = new Set(right.map(rowKeyOf));

  switch (op.op) {
    case 'union':
      return op.all ? [...left, ...right] : distinctRows([...left, ...right]);
    case 'except': {
      const kept = left.filter((r) => !rightKeys.has(rowKeyOf(r)));

      return op.all ? kept : distinctRows(kept);
    }
    case 'intersect': {
      const kept = left.filter((r) => rightKeys.has(rowKeyOf(r)));

      return op.all ? kept : distinctRows(kept);
    }
  }
};

// --- compile & execute -------------------------------------------------------

/** A whole compiled query: its linear parts and the set operators joining them. */
type CQuery = { parts: readonly CLinear[]; ops: readonly SetOp[] };

/**
 * Compile a parsed query into a reusable `Plan`. All graph/param-independent
 * work — operator dispatch, aggregate detection, alias resolution, label-seed
 * selection — happens here, once. Run the returned plan against any graph and
 * params; it never re-parses or re-analyzes.
 */
export const compile = (query: Query): Plan => {
  const compiled: CQuery = {
    parts: query.parts.map(compileLinear),
    ops: query.ops,
  };

  return (graph, params = {}) => {
    let rows = runLinear(compiled.parts[0], graph, params);
    compiled.ops.forEach((op, i) => {
      rows = combineRows(op, rows, runLinear(compiled.parts[i + 1], graph, params));
    });

    return rows;
  };
};

/** Compile and run a parsed query in one call (no plan reuse). */
export const execute = (query: Query, graph: Graph, params: Params = {}): Row[] =>
  compile(query)(graph, params);
