import type { Edge, Graph, Vertex } from '@pl-graph/core';

import type {
  DeleteClause,
  Expr,
  InsertClause,
  LabelExpr,
  LinearQuery,
  MatchClause,
  NodePattern,
  PathPattern,
  Projection,
  PropertyConstraint,
  Query,
  RelPattern,
  RemoveClause,
  SetClause,
  SetOp,
} from './ast.js';
import { candidateVertices, expand, matchesLabel } from './graph-queries.js';

/**
 * The executor turns a parsed `Query` into result rows by *pattern matching*:
 * a declarative MATCH is evaluated as a sequence of nested loops that grow a
 * partial binding (variable -> graph element) one segment at a time. This is
 * the declarative<->imperative bridge — the language says "find this shape",
 * the executor picks the walk order (here, naive left-to-right).
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

/**
 * The ISO element-pattern predicate: every property-map entry must equal the
 * element's stored value, and any inline `WHERE` must hold. Both are evaluated
 * against `binding`, which already includes this element's own variable, so
 * `(n WHERE n.age > 30)` can reference `n`.
 */
const satisfiesPredicate = (
  element: Bound,
  properties: readonly PropertyConstraint[] | undefined,
  where: Expr | undefined,
  binding: Binding,
): boolean => {
  if (properties) {
    for (const { key, value } of properties) {
      if (propOf(element, key) !== evalExpr(value, binding)) {
        return false;
      }
    }
  }
  return where === undefined || evalExpr(where, binding) === true;
};

const matchNode = (binding: Binding, node: NodePattern, vertex: Vertex): Binding | null => {
  if (!matchesLabel(vertex, node.label)) {
    return null;
  }
  if (!consistent(binding, node.variable, vertex)) {
    return null;
  }
  const bound = withBinding(binding, node.variable, vertex);
  if (!satisfiesPredicate(vertex, node.properties, node.where, bound)) {
    return null;
  }
  return bound;
};

/** Yield every binding that extends `binding` by matching `pattern`. */
const matchPattern = function* (
  graph: Graph,
  pattern: PathPattern,
  binding: Binding,
): Iterable<Binding> {
  // Seed the start node: reuse an already-bound vertex if the variable is
  // known, otherwise scan candidates narrowed by label.
  const seeds: Iterable<Vertex> =
    pattern.start.variable && binding.has(pattern.start.variable)
      ? [binding.get(pattern.start.variable) as Vertex]
      : candidateVertices(graph, pattern.start.label);

  for (const seed of seeds) {
    const seeded = matchNode(binding, pattern.start, seed);
    if (seeded) {
      yield* walkSegments(graph, pattern, 0, seed, seeded);
    }
  }
};

/** Recursively extend a binding across the remaining segments of a pattern. */
const walkSegments = function* (
  graph: Graph,
  pattern: PathPattern,
  index: number,
  from: Vertex,
  binding: Binding,
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
      const matched = matchNode(binding, node, end);
      if (matched) {
        yield* walkSegments(graph, pattern, index + 1, end, matched);
      }
    }
    return;
  }

  for (const { edge, node: nextVertex } of expand(graph, from, rel)) {
    if (!consistent(binding, rel.variable, edge)) {
      continue;
    }
    const withEdge = withBinding(binding, rel.variable, edge);
    if (!satisfiesPredicate(edge, rel.properties, rel.where, withEdge)) {
      continue;
    }
    const matched = matchNode(withEdge, node, nextVertex);
    if (matched) {
      yield* walkSegments(graph, pattern, index + 1, nextVertex, matched);
    }
  }
};

/** Vertices reachable from `from` in [min, max] hops of `rel`. */
const reachable = (
  graph: Graph,
  from: Vertex,
  rel: RelPattern,
  q: NonNullable<RelPattern['quantifier']>,
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

// --- expression evaluation ---------------------------------------------------

// Query parameters for the current `execute` call. Set on entry; the executor
// is synchronous, so a plain module variable suffices.
let activeParams: Record<string, unknown> = {};

const propOf = (bound: unknown, key: string): unknown =>
  (bound as { properties?: Record<string, unknown> } | undefined)?.properties?.[key];

// ISO three-valued (Kleene) logic: `null` is UNKNOWN. A row is kept only when a
// predicate evaluates to exactly `true` (see `truthy`).
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

const numOf = (v: unknown): number | null => (isNullish(v) ? null : Number(v));

const inList = (v: unknown, list: unknown): Truth => {
  if (isNullish(v) || !Array.isArray(list)) {
    return null;
  }
  if (list.some((x) => x === v)) {
    return true;
  }
  return list.some(isNullish) ? null : false;
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
    default:
      return false;
  }
};

/** Fold an aggregate over a group of bindings. */
const foldAggregate = (expr: FuncExpr, group: readonly Binding[]): unknown => {
  if (expr.name === 'count' && expr.star) {
    return group.length;
  }
  const raw = group.map((b) => evalExpr(expr.args[0]!, b, group));
  const nonNull = raw.filter((v) => !isNullish(v));
  const values = expr.distinct ? [...new Set(nonNull)] : nonNull;
  switch (expr.name) {
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

/** Scalar (non-aggregate) functions. */
const callScalar = (name: string, args: readonly unknown[]): unknown => {
  const a = args[0];
  switch (name) {
    case 'upper':
      return isNullish(a) ? null : String(a).toUpperCase();
    case 'lower':
      return isNullish(a) ? null : String(a).toLowerCase();
    case 'trim':
      return isNullish(a) ? null : String(a).trim();
    case 'abs':
      return isNullish(a) ? null : Math.abs(Number(a));
    case 'size':
    case 'length':
      if (isNullish(a)) {
        return null;
      }
      return Array.isArray(a) || typeof a === 'string' ? a.length : null;
    case 'coalesce':
      return args.find((x) => !isNullish(x)) ?? null;
    default:
      throw new Error(`Unknown function: ${name}()`);
  }
};

/**
 * Evaluate an expression against a binding. `group`, when present, is the set of
 * bindings an aggregate folds over (implicit grouping); non-aggregate leaves
 * still read from `binding` (the group representative).
 */
const evalExpr = (expr: Expr, binding: Binding, group?: readonly Binding[]): unknown => {
  switch (expr.kind) {
    case 'lit':
      return expr.value;
    case 'var':
      return binding.get(expr.name);
    case 'param':
      return activeParams[expr.name];
    case 'prop':
      return propOf(binding.get(expr.variable), expr.key);
    case 'list':
      return expr.items.map((e) => evalExpr(e, binding, group));
    case 'func':
      return AGGREGATES.has(expr.name)
        ? foldAggregate(expr, group ?? [binding])
        : callScalar(
            expr.name,
            expr.args.map((arg) => evalExpr(arg, binding, group)),
          );
    case 'neg': {
      const v = numOf(evalExpr(expr.expr, binding, group));
      return v === null ? null : -v;
    }
    case 'arith': {
      const l = numOf(evalExpr(expr.left, binding, group));
      const r = numOf(evalExpr(expr.right, binding, group));
      if (l === null || r === null) {
        return null;
      }
      switch (expr.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '%':
          return l % r;
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'concat': {
      const l = evalExpr(expr.left, binding, group);
      const r = evalExpr(expr.right, binding, group);
      return isNullish(l) || isNullish(r) ? null : String(l) + String(r);
    }
    case 'not':
      return not3(asTruth(evalExpr(expr.expr, binding, group)));
    case 'and':
      return and3(
        asTruth(evalExpr(expr.left, binding, group)),
        asTruth(evalExpr(expr.right, binding, group)),
      );
    case 'or':
      return or3(
        asTruth(evalExpr(expr.left, binding, group)),
        asTruth(evalExpr(expr.right, binding, group)),
      );
    case 'xor':
      return xor3(
        asTruth(evalExpr(expr.left, binding, group)),
        asTruth(evalExpr(expr.right, binding, group)),
      );
    case 'isNull': {
      const isnull = isNullish(evalExpr(expr.expr, binding, group));
      return expr.negated ? !isnull : isnull;
    }
    case 'in': {
      const result = inList(
        evalExpr(expr.expr, binding, group),
        evalExpr(expr.list, binding, group),
      );
      return expr.negated ? not3(result) : result;
    }
    case 'compare': {
      const l = evalExpr(expr.left, binding, group);
      const r = evalExpr(expr.right, binding, group);
      if (isNullish(l) || isNullish(r)) {
        return null; // UNKNOWN
      }
      const a = l as number | string;
      const b = r as number | string;
      switch (expr.op) {
        case '=':
          return a === b;
        case '<>':
          return a !== b;
        case '<':
          return a < b;
        case '>':
          return a > b;
        case '<=':
          return a <= b;
        case '>=':
          return a >= b;
      }
    }
  }
};

// --- RETURN projection -------------------------------------------------------

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

/** Stable distinct key for a projected binding; graph elements key by id. */
const valueKey = (v: unknown): string => {
  if (v && typeof v === 'object' && 'id' in v) {
    return `@${(v as { id: unknown }).id}`;
  }
  return JSON.stringify(v) ?? 'undefined';
};
const rowKey = (b: Binding): string => [...b].map(([k, v]) => `${k}=${valueKey(v)}`).join('');

/** Build the output binding for one input binding (or aggregate group). */
const projectBinding = (
  projection: Projection,
  binding: Binding,
  group?: readonly Binding[],
): Binding => {
  const out = new Map<string, unknown>();
  if (projection.star) {
    for (const [name, value] of binding) {
      out.set(name, value);
    }
    return out;
  }
  for (const item of projection.items) {
    out.set(item.alias ?? columnName(item.expr), evalExpr(item.expr, binding, group));
  }
  return out;
};

/** An ORDER BY key, resolving bare aliases to their projected expression. */
const sortKey = (
  expr: Expr,
  binding: Binding,
  aliases: ReadonlyMap<string, Expr>,
  group?: readonly Binding[],
): unknown =>
  expr.kind === 'var' && aliases.has(expr.name)
    ? evalExpr(aliases.get(expr.name)!, binding, group)
    : evalExpr(expr, binding, group);

/**
 * Apply a projection (`RETURN` or `WITH` body) to a set of bindings: implicit
 * grouping/aggregation, then DISTINCT, ORDER BY, SKIP, LIMIT. Returns the
 * projected bindings — `RETURN` turns these into rows, `WITH` feeds them on.
 */
const applyProjection = (projection: Projection, bindings: readonly Binding[]): Binding[] => {
  const orderBy = projection.orderBy ?? [];
  const aliases = new Map<string, Expr>(
    projection.items.filter((i) => i.alias).map((i) => [i.alias!, i.expr]),
  );
  const aggregating = !projection.star && projection.items.some((i) => hasAggregate(i.expr));

  type Keyed = { b: Binding; keys: readonly unknown[] };
  let rows: Keyed[];

  if (aggregating) {
    const groupingItems = projection.items.filter((i) => !hasAggregate(i.expr));
    const groups = new Map<string, Binding[]>();
    for (const b of bindings) {
      const key = JSON.stringify(groupingItems.map((i) => valueKey(evalExpr(i.expr, b))));
      const existing = groups.get(key);
      if (existing) {
        existing.push(b);
      } else {
        groups.set(key, [b]);
      }
    }
    if (groups.size === 0 && groupingItems.length === 0) {
      groups.set('[]', []);
    }
    rows = [...groups.values()].map((group) => {
      const rep: Binding = group[0] ?? new Map();
      return {
        b: projectBinding(projection, rep, group),
        keys: orderBy.map((s) => sortKey(s.expr, rep, aliases, group)),
      };
    });
  } else {
    rows = bindings.map((b) => ({
      b: projectBinding(projection, b),
      keys: orderBy.map((s) => sortKey(s.expr, b, aliases)),
    }));
  }

  if (projection.distinct) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = rowKey(r.b);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }

  if (orderBy.length > 0) {
    rows = [...rows].sort((a, b) => {
      for (let i = 0; i < orderBy.length; i += 1) {
        const cmp = compareValues(a.keys[i], b.keys[i]) * (orderBy[i]!.descending ? -1 : 1);
        if (cmp !== 0) {
          return cmp;
        }
      }
      return 0;
    });
  }

  const start = projection.skip ?? 0;
  const end = projection.limit === undefined ? undefined : start + projection.limit;
  return rows.slice(start, end).map((r) => r.b);
};

// --- clause processing -------------------------------------------------------

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

/** Extend a binding through every pattern of a MATCH clause, then filter WHERE. */
const matchClauseBindings = function* (
  graph: Graph,
  clause: MatchClause,
  binding: Binding,
): Iterable<Binding> {
  let current: Binding[] = [binding];
  for (const pattern of clause.patterns) {
    const next: Binding[] = [];
    for (const b of current) {
      for (const ext of matchPattern(graph, pattern, b)) {
        next.push(ext);
      }
    }
    current = next;
  }
  for (const b of current) {
    if (clause.where === undefined || evalExpr(clause.where, b) === true) {
      yield b;
    }
  }
};

const runMatch = (graph: Graph, clause: MatchClause, bindings: readonly Binding[]): Binding[] => {
  const out: Binding[] = [];
  const nulls = clause.optional ? patternVars(clause.patterns) : [];
  for (const binding of bindings) {
    const matched = [...matchClauseBindings(graph, clause, binding)];
    if (matched.length > 0) {
      out.push(...matched);
    } else if (clause.optional) {
      // No match: keep the row with the pattern's new variables set to null.
      const filled = new Map(binding);
      for (const v of nulls) {
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

/** Run one linear query (clause sequence) to result rows. */
const runLinear = (linear: LinearQuery, graph: Graph): Row[] => {
  let bindings: Binding[] = [new Map()];
  for (const clause of linear.clauses) {
    switch (clause.kind) {
      case 'match':
        bindings = runMatch(graph, clause, bindings);
        break;
      case 'with': {
        const projected = applyProjection(clause.projection, bindings);
        bindings =
          clause.where === undefined
            ? projected
            : projected.filter((b) => evalExpr(clause.where!, b) === true);
        break;
      }
      case 'insert':
        bindings = bindings.map((b) => runInsert(graph, clause, b));
        break;
      case 'set':
        for (const b of bindings) {
          runSet(graph, clause, b);
        }
        break;
      case 'remove':
        for (const b of bindings) {
          runRemove(graph, clause, b);
        }
        break;
      case 'delete':
        for (const b of bindings) {
          runDelete(graph, clause, b);
        }
        break;
      case 'finish':
        return [];
      case 'return':
        return applyProjection(clause.projection, bindings).map(mapToRow);
    }
  }
  return []; // a write-only query produces no rows
};

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

const propsFrom = (
  props: PropertyConstraint[] | readonly PropertyConstraint[] | undefined,
  b: Binding,
) => {
  const out: Record<string, unknown> = {};
  for (const { key, value } of props ?? []) {
    out[key] = evalExpr(value, b);
  }
  return out;
};

/** Create a node from a pattern, reusing an already-bound variable. */
const ensureNode = (graph: Graph, binding: Map<string, unknown>, node: NodePattern): Vertex => {
  if (node.variable && binding.has(node.variable)) {
    return binding.get(node.variable) as Vertex;
  }
  const vertex = graph.addVertex({
    labels: labelsOf(node.label),
    properties: propsFrom(node.properties, binding),
  });
  if (node.variable) {
    binding.set(node.variable, vertex);
  }
  return vertex;
};

const runInsert = (graph: Graph, clause: InsertClause, binding: Binding): Binding => {
  const out = new Map(binding);
  for (const pattern of clause.patterns) {
    let prev = ensureNode(graph, out, pattern.start);
    for (const { rel, node } of pattern.segments) {
      const next = ensureNode(graph, out, node);
      const [from, to] = rel.direction === 'in' ? [next, prev] : [prev, next];
      const edge = graph.addEdge({
        from,
        to,
        labels: labelsOf(rel.label),
        properties: propsFrom(rel.properties, out),
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
const runSet = (graph: Graph, clause: SetClause, binding: Binding): void => {
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
      el.properties = { ...el.properties, [item.key]: evalExpr(item.value, binding) };
    }
  }
};

const runRemove = (graph: Graph, clause: RemoveClause, binding: Binding): void => {
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

const runDelete = (graph: Graph, clause: DeleteClause, binding: Binding): void => {
  for (const target of clause.targets) {
    const el = evalExpr(target, binding);
    if (isEdge(el)) {
      graph.removeEdge(el);
    } else if (isElement(el)) {
      graph.removeVertex(el as Vertex);
    }
  }
};

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

/** Execute a parsed query against a graph, returning projected result rows. */
export const execute = (
  query: Query,
  graph: Graph,
  params: Record<string, unknown> = {},
): Row[] => {
  const previousParams = activeParams;
  activeParams = params;
  try {
    let rows = runLinear(query.parts[0]!, graph);
    query.ops.forEach((op, i) => {
      rows = combineRows(op, rows, runLinear(query.parts[i + 1]!, graph));
    });
    return rows;
  } finally {
    activeParams = previousParams;
  }
};
