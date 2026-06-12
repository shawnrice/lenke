/**
 * GQL query AST. Plain data only (no closures), mirroring the gremlin package's
 * discipline: a parsed query is a serializable description of *what* to match,
 * never *how* to walk it. The executor decides traversal order.
 *
 * The surface is the ISO GQL (ISO/IEC 39075) core: `MATCH` graph patterns, an
 * optional `WHERE` filter, and a `RETURN` projection. Pattern syntax is the ISO
 * ASCII-art form: `(a:Person)-[r:KNOWS]->(b)`. Note this follows ISO, not
 * Cypher — `--` is a line comment, and undirected edges use `~`.
 */

/**
 * A whole query: one or more linear queries combined by set operators
 * (`p0 UNION p1 EXCEPT p2 …`, left-associative). `ops[i]` joins `parts[i]` to
 * `parts[i + 1]`, so `ops.length === parts.length - 1`.
 */
export type Query = {
  parts: readonly LinearQuery[];
  ops: readonly SetOp[];
};

/** `UNION` / `EXCEPT` / `INTERSECT`, optionally `ALL` (keep duplicates). */
export type SetOp = {
  op: 'union' | 'except' | 'intersect';
  all: boolean;
};

/**
 * A linear query: a sequence of clauses ending in `RETURN`. `WITH` projects and
 * chains intermediate results; `OPTIONAL MATCH` keeps rows that don't match.
 */
export type LinearQuery = {
  clauses: readonly Clause[];
};

export type Clause =
  | MatchClause
  | WithClause
  | InsertClause
  | SetClause
  | RemoveClause
  | DeleteClause
  | FinishClause
  | ReturnClause;

/** `INSERT pattern, …` — create the pattern's nodes and edges. */
export type InsertClause = {
  kind: 'insert';
  patterns: readonly PathPattern[];
};

/** `SET n.key = value` (property) or `SET n:Label` (label). */
export type SetClause = {
  kind: 'set';
  items: readonly SetItem[];
};
export type SetItem =
  | { variable: string; key: string; value: Expr }
  | { variable: string; label: string };

/** `REMOVE n.key` (property) or `REMOVE n:Label` (label). */
export type RemoveClause = {
  kind: 'remove';
  items: readonly RemoveItem[];
};
export type RemoveItem = { variable: string; key: string } | { variable: string; label: string };

/** `[DETACH] DELETE n, …`. */
export type DeleteClause = {
  kind: 'delete';
  detach: boolean;
  targets: readonly Expr[];
};

/** `FINISH` — run for side effects, return nothing. */
export type FinishClause = { kind: 'finish' };

/** `[OPTIONAL] MATCH p1, p2, … [WHERE pred]`. */
export type MatchClause = {
  kind: 'match';
  optional: boolean;
  patterns: readonly PathPattern[];
  where?: Expr;
};

/** `WITH … [WHERE pred]` — a projection that flows into the next clause. */
export type WithClause = {
  kind: 'with';
  projection: Projection;
  where?: Expr;
};

/** `RETURN …` — the final projection producing result rows. */
export type ReturnClause = {
  kind: 'return';
  projection: Projection;
};

/**
 * A linear path pattern: a starting node followed by zero or more
 * `(relationship)(node)` segments. `(a)-[:KNOWS]->(b)-[:KNOWS]->(c)` is one
 * PathPattern with two segments.
 */
export type PathPattern = {
  start: NodePattern;
  segments: readonly Segment[];
};

/** One hop: traverse `rel`, land on `node`. */
export type Segment = {
  rel: RelPattern;
  node: NodePattern;
};

/**
 * `(variable:LabelExpr {props} WHERE pred)` — all parts optional. A missing
 * `label` matches any node, including unlabelled ones. `properties` and `where`
 * are the ISO element-pattern predicate (§16.5): a property map and/or an
 * inline filter that the matched element must satisfy.
 */
export type NodePattern = {
  variable?: string;
  label?: LabelExpr;
  properties?: readonly PropertyConstraint[];
  where?: Expr;
};

/** One `key: valueExpression` entry of a pattern property map. */
export type PropertyConstraint = {
  key: string;
  value: Expr;
};

/**
 * An ISO label expression (ISO/IEC 39075 §16.7). This is the boolean-algebra
 * form — `A&B` (conjunction), `A|B` (disjunction), `!A` (negation), `%`
 * (wildcard) — *not* Cypher's colon-chained `:A:B`.
 */
export type LabelExpr =
  | { kind: 'label'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'not'; expr: LabelExpr }
  | { kind: 'and'; left: LabelExpr; right: LabelExpr }
  | { kind: 'or'; left: LabelExpr; right: LabelExpr };

/**
 * A relationship pattern with a direction.
 *  - `out`:  `-[...]->`  or abbreviated `->`
 *  - `in`:   `<-[...]-`  or abbreviated `<-`
 *  - `both`: `~[...]~`, `-[...]-`, `<-[...]->`  or abbreviated `~` / `<->`
 *
 * `label` is an ISO label expression over edge types (`KNOWS|CREATED`,
 * `!IGNORED`, …); a missing `label` matches any type.
 */
export type RelPattern = {
  variable?: string;
  label?: LabelExpr;
  direction: 'out' | 'in' | 'both';
  properties?: readonly PropertyConstraint[];
  where?: Expr;
  /** Variable-length quantifier: `*`={0,∞}, `+`={1,∞}, `{n}`, `{n,m}`. */
  quantifier?: { min: number; max: number | null };
};

/**
 * A projection body, shared by `RETURN` and `WITH`:
 * `DISTINCT (* | item, …) ORDER BY … SKIP n LIMIT n`. `star` carries all bound
 * variables forward; otherwise `items` are projected.
 */
export type Projection = {
  star: boolean;
  items: readonly ReturnItem[];
  distinct: boolean;
  orderBy?: readonly SortItem[];
  skip?: number;
  limit?: number;
};

/** One `ORDER BY` key, with optional ISO `NULLS FIRST` / `NULLS LAST`. */
export type SortItem = {
  expr: Expr;
  descending: boolean;
  /** `true` = NULLS FIRST, `false` = NULLS LAST, `undefined` = engine default. */
  nullsFirst?: boolean;
};

/** A single RETURN expression with an optional `AS` alias. */
export type ReturnItem = {
  expr: Expr;
  alias?: string;
};

/** Comparison operators usable in WHERE and RETURN expressions. */
export type CompareOp = '=' | '<>' | '<' | '>' | '<=' | '>=';

/**
 * Expression tree. Unlike gremlin's `Predicate` (which compares one value
 * against a constant), a GQL expression compares two arbitrary sub-expressions,
 * so `a.age > b.age` is expressible.
 */
export type ArithOp = '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { kind: 'var'; name: string }
  | { kind: 'param'; name: string }
  | { kind: 'prop'; variable: string; key: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'list'; items: readonly Expr[] }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr }
  | { kind: 'arith'; op: ArithOp; left: Expr; right: Expr }
  | { kind: 'concat'; left: Expr; right: Expr }
  | { kind: 'neg'; expr: Expr }
  | { kind: 'and'; left: Expr; right: Expr }
  | { kind: 'or'; left: Expr; right: Expr }
  | { kind: 'xor'; left: Expr; right: Expr }
  | { kind: 'not'; expr: Expr }
  | { kind: 'isNull'; expr: Expr; negated: boolean }
  // ISO `<boolean test>`: `x IS [NOT] TRUE|FALSE|UNKNOWN`. `truth` is the target
  // truth value (`null` = UNKNOWN); the predicate is always TRUE or FALSE.
  | { kind: 'isTruth'; expr: Expr; truth: boolean | null; negated: boolean }
  | { kind: 'in'; expr: Expr; list: Expr; negated: boolean }
  // ISO `<case expression>`. With `subject`: a simple CASE (`subject = when`);
  // without: a searched CASE (`when` is a boolean condition). `elseExpr` is the
  // ELSE result, defaulting to NULL.
  | {
      kind: 'case';
      subject?: Expr;
      whens: readonly { when: Expr; then: Expr }[];
      elseExpr?: Expr;
    }
  | { kind: 'func'; name: string; args: readonly Expr[]; distinct: boolean; star: boolean };
