import type { Edge, Graph, Vertex } from '@pl-graph/core';

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
import { candidateVertices, expand, matchesLabel } from './graph-queries.js';

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
 * A compiled expression. The structural `switch (expr.kind)` happens once, at
 * compile time; what's left is this closure, evaluated against a binding (and,
 * for aggregates, the `group` of bindings it folds over).
 */
type CompiledExpr = (binding: Binding, params: Params, group?: readonly Binding[]) => unknown;

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

const numOf = (v: unknown): number | null => (isNullish(v) ? null : Number(v));

// `v IN list` is a three-valued OR of equalities `v = e` over the elements,
// whose identity (empty list) is FALSE. So `null IN []` is FALSE — there is
// nothing to be uncertain about — while `null IN [1]` and `3 IN [1, null]` are
// UNKNOWN. A TRUE equality short-circuits past any UNKNOWN.
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
    if (e === v) {
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

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'collect']);

/** Does an expression contain an aggregate anywhere (→ implicit grouping)? */
const hasAggregate = (expr: Expr): boolean => {
  switch (expr.kind) {
    case 'func':
      return AGGREGATES.has(expr.name) || expr.args.some(hasAggregate);
    case 'neg':
    case 'not':
    case 'isNull':
    case 'isTruth':
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
  sign: Math.sign,
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
    default:
      throw new Error(`Unknown function: ${name}()`);
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
      return (b) => b.get(name);
    }
    case 'param': {
      const { name } = expr;
      return (_b, params) => params[name];
    }
    case 'prop': {
      const { variable, key } = expr;
      return (b) => propOf(b.get(variable), key);
    }
    case 'list': {
      const items = expr.items.map(compileExpr);
      return (b, p, g) => items.map((f) => f(b, p, g));
    }
    case 'func':
      return compileFunc(expr);
    case 'neg': {
      const fn = compileExpr(expr.expr);
      return (b, p, g) => {
        const v = numOf(fn(b, p, g));
        return v === null ? null : -v;
      };
    }
    case 'arith': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      const op = ARITH[expr.op];
      return (b, p, g) => {
        const lv = numOf(l(b, p, g));
        const rv = numOf(r(b, p, g));
        return lv === null || rv === null ? null : op(lv, rv);
      };
    }
    case 'concat': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      return (b, p, g) => {
        const lv = l(b, p, g);
        const rv = r(b, p, g);
        return isNullish(lv) || isNullish(rv) ? null : String(lv) + String(rv);
      };
    }
    case 'not': {
      const fn = compileExpr(expr.expr);
      return (b, p, g) => not3(asTruth(fn(b, p, g)));
    }
    case 'and':
    case 'or':
    case 'xor': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      const fn = BOOL3[expr.kind];
      return (b, p, g) => fn(asTruth(l(b, p, g)), asTruth(r(b, p, g)));
    }
    case 'isNull': {
      const fn = compileExpr(expr.expr);
      const { negated } = expr;
      return (b, p, g) => {
        const isnull = isNullish(fn(b, p, g));
        return negated ? !isnull : isnull;
      };
    }
    case 'isTruth': {
      // `x IS [NOT] TRUE|FALSE|UNKNOWN` collapses three-valued logic to a
      // definite boolean: it tests whether x's truth value equals the target.
      const fn = compileExpr(expr.expr);
      const { truth, negated } = expr;
      return (b, p, g) => {
        const matches = asTruth(fn(b, p, g)) === truth;
        return negated ? !matches : matches;
      };
    }
    case 'in': {
      const e = compileExpr(expr.expr);
      const list = compileExpr(expr.list);
      const { negated } = expr;
      return (b, p, g) => {
        const result = inList(e(b, p, g), list(b, p, g));
        return negated ? not3(result) : result;
      };
    }
    case 'compare': {
      const l = compileExpr(expr.left);
      const r = compileExpr(expr.right);
      const op = COMPARE[expr.op];
      return (b, p, g) => {
        const lv = l(b, p, g);
        const rv = r(b, p, g);
        if (isNullish(lv) || isNullish(rv)) {
          return null; // UNKNOWN
        }
        return op(lv as number | string, rv as number | string);
      };
    }
    case 'case':
      return compileCase(expr);
  }
};

/**
 * Compile an ISO CASE expression. A simple CASE (with `subject`) returns the
 * first branch whose value equals the subject; a searched CASE returns the first
 * branch whose condition is exactly TRUE. No match falls to ELSE (or NULL).
 */
const compileCase = (expr: Extract<Expr, { kind: 'case' }>): CompiledExpr => {
  const subject = expr.subject ? compileExpr(expr.subject) : undefined;
  const whens = expr.whens.map((w) => ({ when: compileExpr(w.when), then: compileExpr(w.then) }));
  const elseFn = expr.elseExpr ? compileExpr(expr.elseExpr) : undefined;
  return (b, p, g) => {
    if (subject) {
      const s = subject(b, p, g);
      for (const w of whens) {
        const wv = w.when(b, p, g);
        // `subject = when` with SQL/ISO null semantics: NULL never matches.
        if (!isNullish(s) && !isNullish(wv) && s === wv) {
          return w.then(b, p, g);
        }
      }
    } else {
      for (const w of whens) {
        if (asTruth(w.when(b, p, g)) === true) {
          return w.then(b, p, g);
        }
      }
    }
    return elseFn ? elseFn(b, p, g) : null;
  };
};

const compileFunc = (expr: FuncExpr): CompiledExpr => {
  if (AGGREGATES.has(expr.name)) {
    return compileAggregate(expr);
  }
  const { name } = expr;
  const args = expr.args.map(compileExpr);
  return (b, p, g) =>
    callScalar(
      name,
      args.map((f) => f(b, p, g)),
    );
};

/**
 * Compile an aggregate. The argument expression is lowered once; at run time we
 * fold it over the `group` of bindings (or `[binding]` when called outside an
 * aggregating projection).
 */
const compileAggregate = (expr: FuncExpr): CompiledExpr => {
  const { name, star, distinct } = expr;
  const argFn = expr.args[0] ? compileExpr(expr.args[0]) : undefined;
  return (binding, params, g) => {
    const group = g ?? [binding];
    if (name === 'count' && star) {
      return group.length;
    }
    const raw = group.map((b) => argFn!(b, params, group));
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
      case 'collect':
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

/** Compare two values for ORDER BY; nulls sort last. */
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
    return `@${(v as { id: unknown }).id}`;
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
  // Alias -> its projected expression, so ORDER BY can refer to a bare alias.
  const aliases = new Map<string, Expr>(
    projection.items.filter((i) => i.alias).map((i) => [i.alias!, i.expr]),
  );
  const items: CReturnItem[] = projection.items.map((i) => ({
    name: i.alias ?? columnName(i.expr),
    fn: compileExpr(i.expr),
    isAgg: hasAggregate(i.expr),
  }));
  const aggregating = !projection.star && items.some((i) => i.isAgg);
  const groupKeys = items.filter((i) => !i.isAgg).map((i) => i.fn);
  // Resolve a bare-alias ORDER BY key to the projected expression at compile time.
  const orderBy: CSortItem[] = (projection.orderBy ?? []).map((s) => {
    const aliased = s.expr.kind === 'var' ? aliases.get(s.expr.name) : undefined;
    return {
      fn: compileExpr(aliased ?? s.expr),
      descending: s.descending,
      nullsFirst: s.nullsFirst,
    };
  });
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
  group?: readonly Binding[],
): Binding => {
  if (proj.star) {
    return new Map(binding);
  }
  const out = new Map<string, unknown>();
  for (const item of proj.items) {
    out.set(item.name, item.fn(binding, params, group));
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
  bindings: readonly Binding[],
  params: Params,
): Binding[] => {
  const { orderBy } = proj;
  type Keyed = { b: Binding; keys: readonly unknown[] };
  let rows: Keyed[];

  if (proj.aggregating) {
    const groups = new Map<string, Binding[]>();
    for (const b of bindings) {
      const key = JSON.stringify(proj.groupKeys.map((fn) => valueKey(fn(b, params))));
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
    rows = [...groups.values()].map((group) => {
      const rep: Binding = group[0] ?? new Map();
      return {
        b: projectBinding(proj, rep, params, group),
        keys: orderBy.map((s) => s.fn(rep, params, group)),
      };
    });
  } else {
    rows = bindings.map((b) => ({
      b: projectBinding(proj, b, params),
      keys: orderBy.map((s) => s.fn(b, params)),
    }));
  }

  if (proj.distinct) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = rowKey(r.b);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }

  if (orderBy.length > 0) {
    rows = [...rows].sort((a, b) => {
      for (let i = 0; i < orderBy.length; i += 1) {
        const s = orderBy[i]!;
        const cmp = compareSort(a.keys[i], b.keys[i], s.descending, s.nullsFirst);
        if (cmp !== 0) {
          return cmp;
        }
      }
      return 0;
    });
  }

  const start = proj.skip ?? 0;
  const end = proj.limit === undefined ? undefined : start + proj.limit;
  return rows.slice(start, end).map((r) => r.b);
};

// --- pattern compilation -----------------------------------------------------

/** A compiled property map + inline WHERE (the ISO element-pattern predicate). */
type CProp = { key: string; value: CompiledExpr };
type CPredicate = { props: readonly CProp[]; where?: CompiledExpr };
type CNode = { variable?: string; label?: LabelExpr; pred: CPredicate };
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

const compileNode = (node: NodePattern): CNode => ({
  variable: node.variable,
  label: node.label,
  pred: compilePredicate(node.properties, node.where),
});

const compileRel = (rel: RelPattern): CRel => ({
  variable: rel.variable,
  label: rel.label,
  direction: rel.direction,
  pred: compilePredicate(rel.properties, rel.where),
  quantifier: rel.quantifier,
});

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
const satisfies = (element: Bound, pred: CPredicate, binding: Binding, params: Params): boolean => {
  for (const { key, value } of pred.props) {
    if (propOf(element, key) !== value(binding, params)) {
      return false;
    }
  }
  return pred.where === undefined || pred.where(binding, params) === true;
};

// --- matching ----------------------------------------------------------------

const matchNode = (
  binding: Binding,
  node: CNode,
  vertex: Vertex,
  params: Params,
): Binding | null => {
  if (!matchesLabel(vertex, node.label)) {
    return null;
  }
  if (!consistent(binding, node.variable, vertex)) {
    return null;
  }
  const bound = withBinding(binding, node.variable, vertex);
  if (!satisfies(vertex, node.pred, bound, params)) {
    return null;
  }
  return bound;
};

/** Yield every binding that extends `binding` by matching `pattern`. */
const matchPattern = function* (
  graph: Graph,
  pattern: CPath,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  // Seed the start node: reuse an already-bound vertex if the variable is
  // known, otherwise scan candidates narrowed by label.
  const seeds: Iterable<Vertex> =
    pattern.start.variable && binding.has(pattern.start.variable)
      ? [binding.get(pattern.start.variable) as Vertex]
      : candidateVertices(graph, pattern.start.label);

  for (const seed of seeds) {
    const seeded = matchNode(binding, pattern.start, seed, params);
    if (seeded) {
      yield* walkSegments(graph, pattern, 0, seed, seeded, params);
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
  const { rel, node } = pattern.segments[index]!;

  // Variable-length: reach every vertex within [min, max] hops, then continue
  // from each. (The edge variable and per-edge predicate aren't bound for
  // var-length segments — a known simplification.)
  if (rel.quantifier) {
    for (const end of reachable(graph, from, rel, rel.quantifier)) {
      const matched = matchNode(binding, node, end, params);
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
    if (!satisfies(edge, rel.pred, withEdge, params)) {
      continue;
    }
    const matched = matchNode(withEdge, node, nextVertex, params);
    if (matched) {
      yield* walkSegments(graph, pattern, index + 1, nextVertex, matched, params);
    }
  }
};

/** Vertices reachable from `from` in [min, max] hops of `rel`. */
const reachable = (
  graph: Graph,
  from: Vertex,
  rel: CRel,
  q: NonNullable<CRel['quantifier']>,
): Set<Vertex> => {
  const cap = q.max ?? graph.verticesById.size + 1;
  const result = new Set<Vertex>();
  if (q.min === 0) {
    result.add(from);
  }
  let frontier = new Set<Vertex>([from]);
  for (let depth = 1; depth <= cap && frontier.size > 0; depth += 1) {
    const next = new Set<Vertex>();
    for (const v of frontier) {
      for (const { node } of expand(graph, v, rel)) {
        next.add(node);
      }
    }
    if (depth >= q.min && (q.max === null || depth <= q.max)) {
      for (const v of next) {
        result.add(v);
      }
    }
    frontier = next;
  }
  return result;
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

const compileInsertNode = (node: NodePattern): CInsertNode => ({
  variable: node.variable,
  labels: labelsOf(node.label),
  props: compileProps(node.properties),
});

const compileInsertPath = (pattern: PathPattern): CInsertPath => ({
  start: compileInsertNode(pattern.start),
  segments: pattern.segments.map(({ rel, node }) => ({
    rel: {
      variable: rel.variable,
      labels: labelsOf(rel.label),
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
    case 'match':
      return {
        kind: 'match',
        optional: clause.optional,
        patterns: clause.patterns.map(compilePath),
        where: clause.where ? compileExpr(clause.where) : undefined,
        nullVars: clause.optional ? patternVars(clause.patterns) : [],
      };
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

const labelsOf = (expr: LabelExpr | undefined): string[] => {
  if (!expr) {
    return [];
  }
  if (expr.kind === 'label') {
    return [expr.name];
  }
  if (expr.kind === 'and') {
    return [...labelsOf(expr.left), ...labelsOf(expr.right)];
  }
  return []; // `|`, `!`, `%` aren't creatable label sets
};

const isEdge = (v: unknown): v is Edge =>
  typeof v === 'object' && v !== null && 'from' in v && 'to' in v;
const isElement = (v: unknown): v is Vertex | Edge =>
  typeof v === 'object' && v !== null && 'id' in v;

const evalProps = (
  props: readonly CProp[],
  b: Binding,
  params: Params,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const { key, value } of props) {
    out[key] = value(b, params);
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
    properties: evalProps(node.props, binding, params),
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
        properties: evalProps(rel.props, out, params),
      });
      if (rel.variable) {
        out.set(rel.variable, edge);
      }
      prev = next;
    }
  }
  return out;
};

// Labels go through the graph's index-maintaining methods so MATCH can find
// them afterwards; properties write directly (no value index).
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
      el.properties = { ...el.properties, [item.key]: item.value(binding, params) };
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
      const props = { ...el.properties };
      delete props[item.key];
      el.properties = props;
    }
  }
};

const runDelete = (graph: Graph, clause: CDelete, binding: Binding, params: Params): void => {
  for (const target of clause.targets) {
    const el = target(binding, params);
    if (isEdge(el)) {
      graph.removeEdge(el);
    } else if (isElement(el)) {
      graph.removeVertex(el as Vertex);
    }
  }
};

// --- clause processing -------------------------------------------------------

/** Extend a binding through every pattern of a MATCH clause, then filter WHERE. */
const matchClauseBindings = function* (
  graph: Graph,
  clause: CMatch,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  let current: Binding[] = [binding];
  for (const pattern of clause.patterns) {
    const next: Binding[] = [];
    for (const b of current) {
      for (const ext of matchPattern(graph, pattern, b, params)) {
        next.push(ext);
      }
    }
    current = next;
  }
  for (const b of current) {
    if (clause.where === undefined || clause.where(b, params) === true) {
      yield b;
    }
  }
};

const runMatch = (
  graph: Graph,
  clause: CMatch,
  bindings: readonly Binding[],
  params: Params,
): Binding[] => {
  const out: Binding[] = [];
  for (const binding of bindings) {
    const matched = [...matchClauseBindings(graph, clause, binding, params)];
    if (matched.length > 0) {
      out.push(...matched);
    } else if (clause.optional) {
      // No match: keep the row with the pattern's new variables set to null.
      const filled = new Map(binding);
      for (const v of clause.nullVars) {
        if (!filled.has(v)) {
          filled.set(v, null);
        }
      }
      out.push(filled);
    }
  }
  return out;
};

const mapToRow = (b: Binding): Row => {
  const row: Row = {};
  for (const [k, v] of b) {
    row[k] = v;
  }
  return row;
};

/** Run one compiled linear query (clause sequence) to result rows. */
const runLinear = (linear: CLinear, graph: Graph, params: Params): Row[] => {
  let bindings: Binding[] = [new Map()];
  for (const clause of linear.clauses) {
    switch (clause.kind) {
      case 'match':
        bindings = runMatch(graph, clause, bindings, params);
        break;
      case 'with': {
        const projected = applyProjection(clause.projection, bindings, params);
        bindings =
          clause.where === undefined
            ? projected
            : projected.filter((b) => clause.where!(b, params) === true);
        break;
      }
      case 'insert':
        bindings = bindings.map((b) => runInsert(graph, clause, b, params));
        break;
      case 'set':
        for (const b of bindings) {
          runSet(graph, clause, b, params);
        }
        break;
      case 'remove':
        for (const b of bindings) {
          runRemove(graph, clause, b);
        }
        break;
      case 'delete':
        for (const b of bindings) {
          runDelete(graph, clause, b, params);
        }
        break;
      case 'finish':
        return [];
      case 'return':
        return applyProjection(clause.projection, bindings, params).map(mapToRow);
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
    let rows = runLinear(compiled.parts[0]!, graph, params);
    compiled.ops.forEach((op, i) => {
      rows = combineRows(op, rows, runLinear(compiled.parts[i + 1]!, graph, params));
    });
    return rows;
  };
};

/** Compile and run a parsed query in one call (no plan reuse). */
export const execute = (query: Query, graph: Graph, params: Params = {}): Row[] =>
  compile(query)(graph, params);
