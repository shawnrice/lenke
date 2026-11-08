import type { Edge, Graph, Vertex } from '@lenke/core';
import { type AlgorithmName, isTemporal, LenkeRecord } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type {
  Clause,
  CompareOp,
  CountValue,
  Expr,
  LabelExpr,
  MatchClause,
  NodePattern,
  PathPattern,
  PathMode,
  PathSelector,
  Projection,
  PropertyConstraint,
  Quantifier,
  ReturnItem,
  RelPattern,
  Segment,
  RemoveItem,
  SetItem,
  SetOp,
  TypeTest,
} from '../ast.js';
import { labelsMatch, matchesLabel } from '../graph-queries.js';

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
export type Bound = Vertex | Edge;

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

// Element identity, mirroring the Rust `value::equals`: nodes/edges are equal iff same
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
// mismatch. Mirrors the `Expr::GraphPred` arm of `exec::evaluator::eval`.
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

// `PROPERTY_EXISTS(n, key)`: is `key` a *present* property of element `n`? A
// boolean for an element (distinguishing an absent key from a stored null — null
// is first-class), and `null` for a non-element / NULL (three-valued). `key in
// props` would walk the prototype chain, so use `hasOwnProperty`.
const propPresent = (bound: unknown, key: string): boolean | null => {
  const props = (bound as { properties?: Record<string, unknown> } | undefined)?.properties;

  return props == null ? null : Object.hasOwn(props, key);
};

import {
  collectingUnknownFns,
  execEpoch,
  isMemoUncorrelated,
  noteCountParamName,
  noteParam,
  noteUnknownFn,
} from './compile-state.js';
// Scalar functions, three-valued logic & value helpers (leaf module).
import {
  AGGREGATES,
  ARITH,
  arithStep,
  asTruth,
  BINARY_NUM,
  binaryNumCall,
  nullifCall,
  roundCall,
  BINARY_STR_FN,
  binaryStrCall,
  BOOL3,
  bufferedScalarCall,
  COMPARE,
  concatStep,
  dataException,
  collectAggregates,
  everyAggregateIsCountStar,
  hasAggregate,
  inList,
  makeRecord,
  nonNumericAgg,
  not3,
  numArg,
  numOf,
  percentileOf,
  recordGet,
  scalarArityOk,
  SCALAR_ASSERTS_STR0_ONLY,
  SCALAR_NEEDS_ARG_ASSERT,
  structuralEq,
  temporalSum,
  UNARY_NUM,
  POLY_STR_LIST_FN,
  STR_NUM_FN,
  TRIM_1,
  unaryNumCall,
  UNARY_STR,
  polyStrListCall,
  strNumCall,
  unaryStrCall,
  unsupportedTemporalAgg,
} from './scalars.js';
import type { FuncExpr, Truth } from './scalars.js';
import { isNullish } from './values.js';

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
export const correlatedSubqueries = new WeakSet<object>();

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
/**
 * `<needle> IN <list>` as a test on the needle VALUE, or `null` when the haystack varies per row.
 *
 * Extracted from `case 'in'` so the generic evaluator and the LIFTED path (`memberProps`, item
 * 1269) share one implementation. Two copies of a three-valued membership rule is the drift this
 * file keeps paying for elsewhere, and the two call sites differ only in where the needle comes
 * from — the binding for `case 'in'`, the element itself for the lift.
 *
 * A CLOSED all-literal haystack is hashed ONCE, at compile time. That removes BOTH costs the linear
 * form paid per row: `case 'list'` rebuilding the array and calling an element closure per item,
 * and `inList` then scanning it. Measured at 200,000 rows on an unindexed key, `IN` over 500 inline
 * literals went 312.98ms -> 7.07ms (item 268).
 *
 * A CLOSED haystack that is not all-literal — a `$ids` param, or an inline list whose items are
 * params — has a value that is constant WITHIN an execution but not across executions.
 * `closedList` is the same predicate the seeding path uses for exactly this set of shapes (item
 * 184). Hash it ONCE per execution, keyed on `execEpoch`. Evaluating the haystack against the first
 * row's env and reusing it is sound precisely BECAUSE it is closed: a `lit`/`param` tree never
 * reads the binding, so every row would compute the same value.
 *
 * ⚠️ KEYING ON THE ARRAY'S IDENTITY INSTEAD WAS A 2.9x REGRESSION, and it is worth saying why,
 * because identity looks like the obvious key. `case 'list'` rebuilds its array per ROW, so for an
 * inline list of params the identity check missed on every row and re-hashed the whole haystack
 * each time — strictly worse than the linear scan it replaced. Measured at 100 terms, 200,000 rows:
 * `IN [$a, …]` went 203.73ms (pre-268) -> 587.42ms (identity memo) -> hashed here. An
 * execution-scoped key cannot have that failure mode, because it never hashes anything that varies
 * per row.
 */
const membershipTest = (list: Expr): ((needle: unknown, env: EvalEnv) => Truth) | null => {
  const closed = closedListValues(list);
  const constHay = closed === null ? null : hashValues(closed);

  if (constHay !== null) {
    return (needle) => hashedIn(needle, constHay);
  }

  if (closedList(list)) {
    const compiled = compileExpr(list);
    let epoch = -1;
    let hay: unknown;
    let hashed: Haystack | null = null;

    return (needle, env) => {
      if (epoch !== execEpoch) {
        epoch = execEpoch;
        hay = compiled(env);
        hashed = Array.isArray(hay) ? hashValues(hay) : null;
      }

      // `hashed` is null for a non-array binding (`$ids` bound to a number → the whole predicate
      // is UNKNOWN) or a non-hashable element (a NaN param), and both keep `inList` over the
      // cached value.
      return hashed === null ? inList(needle, hay) : hashedIn(needle, hashed);
    };
  }

  return null;
};

/**
 * The compiled reader for a `$param` (item 799).
 *
 * Its own function because `compileExpr` sits at this file's complexity gate and the two
 * compile-time exceptions below put it over — the same reason `filterPredicate` and the scalar
 * factories are not inline.
 */
const compileParam = (name: string): CompiledExpr => {
  // THE PER-ROW `Object.hasOwn` IS REDUNDANT FOR ALMOST EVERY NAME, and item 798 priced what
  // it costs: `WHERE k > $a` ran **45.4 ns a vertex against the identical literal's 25.2** on a
  // 200,000-vertex count — **1.76x with disjoint ranges** — for a value that cannot change
  // during one execution. The injection-safe spelling paying 1.76x the interpolated one is
  // this repo's named defect class.
  //
  // The redundancy is PROVED by code that already runs, not assumed: plan execution validates
  // every referenced name with `Object.hasOwn` BEFORE any row is touched and throws
  // `MissingParameter` unless it is present. So at row time the property is own, and the
  // check cannot fail. Even `$__proto__` unbound never reaches a row — it fails that
  // validation first.
  //
  // TWO NAMES ARE NOT COVERED BY THAT PROOF, and both are decided HERE so the hot closure
  // carries no test at all:
  //
  //   - `__now`, the one name the eager validation admits as ABSENT: an unsupplied
  //     `current_*` reads NULL rather than raising, and `undefined` would be wrong.
  //   - a name that exists on `Object.prototype` (`toString`, `constructor`, `__proto__`, …),
  //     which must read undefined rather than the INHERITED value. That is not merely
  //     theoretical: `compileValidator` runs these closures with `params: {}` and WITHOUT the
  //     eager validation, so `$toString` there would read `Object.prototype.toString` from the
  //     fast closure. The slow closure stays for those names, which is also what keeps the
  //     Rust engine's behaviour (its params live in a `HashMap`, immune by construction).
  if (name === '__now' || name in Object.prototype) {
    return (env) => {
      if (Object.hasOwn(env.params, name)) {
        return env.params[name];
      }

      return name === '__now' ? null : undefined;
    };
  }

  return (env) => env.params[name];
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
      noteParam(name);

      return compileParam(name);
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
      const test = membershipTest(expr.list);

      if (test !== null) {
        return (env) => {
          const r = test(e(env), env);

          return negated ? not3(r) : r;
        };
      }

      // A haystack that genuinely varies per row — a property, a function result. It is
      // re-evaluated and scanned linearly, which is the right answer for it: hashing a
      // fresh list per row could only add work. `membershipTest` declines exactly this
      // case, and it is the one shape that cannot be lifted either.
      const list = compileExpr(expr.list);

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
 * faults). Returns `undefined` when the shape doesn't apply.
 *
 * NO NATIVE COUNTERPART, as of item 614: the `Expr::Exists` arm of `exec::evaluator::eval`
 * fast-paths a bare vertex-hop semi-join only, and nothing in `opt` rewrites an EXISTS over
 * a var-length segment into a reachability test. So this is a TS-side win the native engine
 * does not have, not a mirrored path — priced nowhere, and worth measuring before anyone
 * assumes parity. (`any_match_reachable` xref:gone.)
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
  // two-hop side still resolves mid-vertices by id, and item 594 ANSWERED why that is a different
  // question rather than an oversight: **an `Edge` stores endpoint IDS, and `e.to` is a getter
  // that calls `getVertexById`.** There is no vertex object in hand at a first-hop landing, so
  // "read the box instead" would pay the very string-keyed lookup it is trying to avoid — which
  // is what the comment in `twoHopSide`'s unlabelled branch already says, and why its labelled
  // branch measured FLAT when tried. The items 591/592 lever does not reach here.
  //
  // The cost is therefore one global string-keyed adjacency lookup PER FIRST-HOP EDGE, and that
  // is measured rather than argued. 200,000 vertices at degree 5, varying only the anchor set so
  // first-hop edges vary with it:
  //
  //   2-hop, all anchors        206.97 ms   1,000,000 first-hop edges   207 ns/edge
  //   2-hop, ~2/3               149.20        655,555                   228
  //   2-hop, ~1/3 (bench row)    81.66        322,220                   253
  //   2-hop, ~1/10               35.80        100,000                   358
  //   1-hop, all anchors         32.64      1,000,000 counted edges       33 ns/edge
  //   2-hop, LABELLED middle    138.11        322,220                   429
  //
  // Linear in first-hop edges (the ns/edge climb at small anchor sets is the 200,000-vertex scan
  // amortized over fewer edges), and the ~174 ns/edge the two-hop pays over the one-hop is item
  // 194's ~190 ns for a string-keyed `Map.get`. A per-query memo on the mid id does not help: its
  // own `Map.get` is the same ~190 ns, so it would save only the inner per-type read (~24 ms of
  // 207). Making this cheaper means giving the core graph dense vertex indices instead of string
  // ids — an architectural change, not a rung.
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
  if (!isMemoUncorrelated() || correlatedSubqueries.has(expr)) {
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
  // the tree (the native engine instead rejects at parse, in `gql::Parser::call`
  // before the first row). A validator predicate compiles with the collector
  // unset, so its unknown-fn timing stays per-row — matching the Rust
  // `exec::evaluator::eval` path (both engines surface a validator's unknown fn at write
  // time, not declare time).
  if (collectingUnknownFns() && !isKnownScalarFn(name)) {
    noteUnknownFn(name);
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

  // The NUMERIC families, specialized while the query compiles (item 760). The general
  // closure below pays, for every row: a fresh argument ARRAY from `args.map`, three
  // dictionary misses inside `assertScalarArgTypes`, the walk down `callScalar`'s dispatch
  // chain, and a read of `env.graph.limits`. Measured at 200,000 rows, a scalar call cost
  // 35-43 ns a row OVER a `count(a.age)` floor of 20.9 — and flat across unary, binary,
  // generic and string, which is what says the cost is the machinery and not the function.
  //
  // This is the TS twin of item 759, where the native engine's same question had the
  // OPPOSITE answer for one of its parts: hoisting the name match alone bought nothing
  // there, because rustc compiles a string match to a length switch. A JS `Record` lookup on
  // a megamorphic string key is not that.
  //
  // `SCALAR_NEEDS_ARG_ASSERT` is the gate: a name whose arguments are validated by POSITION
  // keeps the general path, so skipping the assert cannot silently lose a type error. No
  // member of `UNARY_NUM`/`BINARY_NUM` is in it today — the gate is there so that adding one
  // does not have to be noticed.
  if (!SCALAR_NEEDS_ARG_ASSERT.has(name)) {
    const unary = UNARY_NUM[name];

    if (unary !== undefined && args.length === 1) {
      return unaryNumCall(unary, args[0]);
    }

    const binary = BINARY_NUM[name];

    if (binary !== undefined && args.length === 2) {
      return binaryNumCall(binary, args[0], args[1]);
    }

    // `round` and `nullif` (item 788), the two names in neither table — `round` because its
    // second argument is OPTIONAL and a null one means zero digits rather than a null result,
    // `nullif` because it is polymorphic and returns a null. Both were on the general dispatch
    // at 40.6 and 39.4 ns a row against a specialized band of 18-27. Inside this gate for the
    // reason the gate exists: neither name is in `SCALAR_NEEDS_ARG_ASSERT` today, and adding one
    // later must not silently skip its positional check.
    if (name === 'round' && args.length >= 1 && args.length <= 2) {
      return roundCall(args[0], args[1]);
    }

    if (name === 'nullif' && args.length === 2) {
      return nullifCall(args[0], args[1]);
    }
  }

  // The one-argument STRING family (item 761), which the gate above excludes because
  // `assertScalarArgTypes` checks its argument POSITION. So this path folds that one check
  // into the closure rather than skipping it, and `SCALAR_ASSERTS_STR0_ONLY` admits only the
  // names whose entire positional check is "position 0 is a string" — `left`/`right`/
  // `substring` also check a numeric position, and `reverse`/`size`/`cardinality` accept a
  // list and raise a different message.
  //
  // Priced the same way as 760, with the row that separates machinery from work:
  // `char_length` is gated out for the same reason as `upper` and returns a NUMBER, so it
  // allocates nothing. At 200,000 rows it cost 53.86 ns a row against an 18.67 string floor —
  // 35.19 ns of machinery, the same figure 760 found — while `upper` cost 65.16, so about
  // 11 ns of its 46 is the `toUpperCase` itself and is not available to any fix here.
  const unaryStr = UNARY_STR[name];

  if (unaryStr !== undefined && args.length === 1 && SCALAR_ASSERTS_STR0_ONLY.has(name)) {
    return unaryStrCall(name, unaryStr, args[0]);
  }

  // The ONE-ARGUMENT trim family (item 790), through the same factory. `SCALAR_ASSERTS_STR0_ONLY`
  // cannot admit these — their `STR_ARG_POSITIONS` entry is `[0, 1]` — but `assertScalarArgTypes`
  // skips an `undefined` argument, so at ONE argument the check IS str0-only. `TRIM_1`'s doc
  // carries the argument and the measurement; the arity test here is what makes it true.
  const trim1 = args.length === 1 ? TRIM_1[name] : undefined;

  if (trim1 !== undefined) {
    return unaryStrCall(name, trim1, args[0]);
  }

  // The POLYMORPHIC string-or-list family — `size`, `cardinality`, `reverse` (item 792). Their
  // positional check is "a string OR a list" (plus a PATH for `cardinality`), which is why neither
  // the numeric gate nor `SCALAR_ASSERTS_STR0_ONLY` admits them; `polyStrListCall` folds that check
  // in rather than skipping it. `size` was the largest RATIO left in the TS survey — 42.0 ns a row
  // against `char_length`'s 19.9 for the same work.
  const poly = args.length === 1 ? POLY_STR_LIST_FN[name] : undefined;

  if (poly !== undefined) {
    return polyStrListCall(name, poly, args[0]);
  }

  // The "a STRING at 0, then NUMBERS" family — `left`, `right`, `substring` (item 794), the last
  // one on the general dispatch. `strNumCall` folds BOTH positional checks in, in the assert's own
  // order. The arity test admits `substring`'s optional third argument and nothing wider.
  const strNum = args.length === 2 || args.length === 3 ? STR_NUM_FN[name] : undefined;

  if (strNum !== undefined) {
    return strNumCall(name, strNum, args[0], args[1], args[2]);
  }

  // The two-argument string PREDICATES (item 769) — the TS counterpart of item 766, which took
  // the same three natively from 36-40 ns a row to 8-10. Expect less here: a good part of that
  // was a `Col::Bool` output column, and TypeScript has no typed columns to write into.
  //
  // `SCALAR_ASSERTS_STR0_ONLY` does NOT admit these (they assert positions 0 AND 1), so the
  // closure folds both checks in, in the order `assertScalarArgTypes` performs them — see
  // `binaryStrCall`, where the order is the contract rather than a detail.
  const binaryStr = BINARY_STR_FN[name];

  if (binaryStr !== undefined && args.length === 2) {
    return binaryStrCall(name, binaryStr, args[0], args[1]);
  }

  // Everything else keeps the general dispatch, but not the per-row argument ARRAY (item
  // 763). `args.map((f) => f(env))` allocated one array per row — 200,000 a rep on the probe
  // fixture — and item 762 found that allocation is what makes this path BIMODAL, swinging
  // between a ~45 ns and a ~82 ns mode inside one process while the specialized closures sit
  // flat. The native engine's `Expr::Call` arm reuses one buffer for the same reason.
  //
  // The factory is at module scope and the retention audit that makes it safe is documented
  // there.
  return bufferedScalarCall(name, args);
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
): boolean => sortsOnOutputNames(ret, new Set(proj.items.map((it) => it.name)));

/**
 * The same rule as {@link sortsOnOutputOnly}, over an explicit set of output NAMES.
 *
 * Split out because a caller that has not compiled a projection still computes its own output
 * names — `detectNodeProjection` builds them as it compiles each item's expression (item 606) —
 * and the alternative was a second copy of the `every(kind === 'var' && names.has(…))` test.
 * `plainRowProjection`'s comment states why that matters: "two copies of this list is how one of
 * them falls behind the other."
 */
export const sortsOnOutputNames = (
  ret: Extract<Clause, { kind: 'return' }>,
  names: ReadonlySet<string>,
): boolean =>
  (ret.projection.orderBy ?? []).every(
    (sort) => sort.expr.kind === 'var' && names.has(sort.expr.name),
  );

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

// --- value / ordering helpers ------------------------------------------------

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
    /**
     * The aggregate's own AST node. Narrowed from `object` to the func node it has always been
     * (`foldableOf` pushes straight from `collectAggregates`) because item 1198 READS it — the
     * streaming route needs the node's `args` to lower the argument, and its identity to tell a
     * bare aggregate from a wrapped one. It is still used as a `Map` key, which an opaque
     * `object` served, but a key is not all it is any more.
     */
    readonly expr: Extract<Expr, { kind: 'func' }>;
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
export const noteCountParam = (v: CountValue | undefined): void => {
  if (v !== undefined && typeof v === 'object') {
    noteCountParamName(v.param);
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
 * The native side makes the same bare-alias-vs-expression decision in
 * `gql::Parser::order_keys`.
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

export const compileProjection = (projection: Projection): CProjection => {
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
  ):
    | { expr: Extract<Expr, { kind: 'func' }>; fold: AggFold; argFn: CompiledExpr }[]
    | undefined => {
    const out: { expr: Extract<Expr, { kind: 'func' }>; fold: AggFold; argFn: CompiledExpr }[] = [];

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
    | { expr: Extract<Expr, { kind: 'func' }>; fold: AggFold; argFn: CompiledExpr }[] => {
    if (!aggregating || countedGroups || having !== undefined) {
      return undefined;
    }

    const all: { expr: Extract<Expr, { kind: 'func' }>; fold: AggFold; argFn: CompiledExpr }[] = [];

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

/**
 * Apply a projection (`RETURN` or `WITH` body) to a set of bindings: implicit
 * grouping/aggregation, then DISTINCT, ORDER BY, SKIP, LIMIT. Returns the
 * projected bindings — `RETURN` turns these into rows, `WITH` feeds them on.
 */
/** A counted group mid-accumulation: its size, and the first binding seen (the representative
 *  the rest of the projection reads as `group[0]`). */
export type CountedGroup = { rep: Binding; n: number };

/**
 * A one-row group view carrying ONE already-folded aggregate, whose SIZE IS AN ERROR TO READ.
 *
 * `shortcuts.ts`'s streaming aggregate routes admit exactly one aggregate (their arity gate), so a
 * wrapping expression over the folded value — `abs(min(n.k) - 10)`, `size(collect(n.k))` — can only
 * ever look up THAT aggregate, never the group's length; only a second aggregate would need it, and
 * that shape falls to the general path. Those routes stream, so they do not have a row count to
 * hand over without counting rows, which measurably taxed the bare spelling (item 1198).
 *
 * So rather than invent a number, reading `length` THROWS. If the arity gate is ever widened, the
 * shape that needs a count fails loudly here instead of silently reporting a wrong one.
 */
export const foldedAggOnlyView = (aggNode: object, value: unknown): Binding[] => {
  const folded = new Map<object, { readonly v: unknown }>([[aggNode, { v: value }]]);

  return new Proxy<Binding[]>([new Map<string, unknown>()], {
    get(target, prop, recv) {
      if (prop === FOLDED) {
        return folded;
      }

      if (prop === 'length') {
        throw new LenkeError(
          'lenke: a streamed single-aggregate group view was asked for its SIZE, which it does ' +
            'not know — the shape should have fallen to the general path (see `foldedAggOnlyView`)',
          { code: ErrorCode.Unsupported },
        );
      }

      return Reflect.get(target, prop, recv) as unknown;
    },
  });
};

/** One bucket of a folded grouping: a representative, a row count, one accumulator each. */
export type FoldedBucket = { rep: Binding; n: number; accs: unknown[] };

export type FoldedAgg = {
  readonly expr: object;
  readonly fold: AggFold;
  readonly argFn: CompiledExpr;
};

// --- pattern compilation -----------------------------------------------------

/** A compiled property map + inline WHERE (the ISO element-pattern predicate). */
export type CProp = { key: string; value: CompiledExpr };
/**
 * One lifted DOTTED-path comparison (item 900): the path's segments, the operator, and the
 * right-hand side as a compiled closure.
 *
 * `path[0]` is a property of the element; every later segment is a record/map field.
 */
export type CPathProp = {
  readonly path: readonly string[];
  readonly op: CompareOp;
  readonly value: (env: EvalEnv) => unknown;
};

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
  /**
   * Keys of `<ownVar>.<key>` conjuncts that stand ALONE as a boolean predicate (`WHERE n.flag`),
   * read off the element like `eqProps`/`cmpProps` instead of through the binding `Map`.
   *
   * A third list for the reason `cmpProps` gives for being the second one: these carry no value
   * side and no operator at all, so folding them in would make the tuned equality path pay for a
   * shape that needs neither field.
   *
   * NOT `eqProps` with a `true` right-hand side, and that is a correctness condition rather than
   * tidiness. A property in boolean context is DYNAMIC under the static boolean-context check, so
   * a non-boolean value must RAISE; a lifted equality would silently fail to match instead, which
   * changes which queries error. The gate loop therefore applies `asTruth` and keeps the raise.
   *
   * Item 875. Item 874 measured why this exists: `directEqProps` declines its whole chain on the
   * first conjunct that is not a `compare`, so `WHERE n.flag` fell to the generic evaluator at
   * 20,000 `prop`-closure calls per 20,000 vertices where `WHERE n.flag = true` made ZERO — a
   * comparison never reaches `compileExpr` at all.
   */
  truthProps?: readonly string[];
  /**
   * The NEGATED twin of {@link truthProps}: `WHERE NOT n.flag` (item 984).
   *
   * `directEqProps` declined the WHOLE chain on a `NOT` conjunct, because its loop admits a bare
   * `prop` or a `compare` and nothing else — so `NOT p.b` ran entirely through the generic
   * evaluator while `p.b = false`, which IS a compare, lifted into `eqProps`. Two spellings of
   * one question, measured **2.20x apart** at 200,000 rows (item 983: 8.14 ms against 3.56).
   *
   * A row survives iff the cell is cleanly FALSE. `asTruth` is the same function the generic
   * path uses, so a non-boolean RAISES here exactly as it does there — the lift changes the
   * route, not the answer and not which queries throw.
   */
  notTruthProps?: readonly string[];

  /**
   * `WHERE n.k IN [..]`, and the `n.k = a OR n.k = b` spelling that `membershipFromEqChain` folds
   * into the same `in` node — read off the ELEMENT instead of through the binding (item 1269).
   *
   * A fifth list for the same blunt reason as the others: `directEqProps` admits a bare `prop`, a
   * `NOT prop` and a `compare`, and declined its WHOLE chain on anything else — so an `in` conjunct
   * took the entire predicate to the generic evaluator. Three spellings of one question, measured
   * at 200,000 vertices on an unindexed key, all answering 2000:
   *
   * ```text
   *   {age: 50} inline        3.195 ms   16.0 ns a vertex
   *   age = 50                3.358      16.8
   *   age IN [50]             5.884      29.4
   *   age = 50 OR age = 50    5.885      29.4      <- IN and OR are already one shape
   * ```
   *
   * 1.84x, and item 230 had already measured and attributed that exact pair (17.2 ns against 29.0):
   * a predicate passed with the node's OWN variable lets the lift read the element directly, where
   * anything `directEqProps` does not recognize pays a binding `Map` write and read per element.
   *
   * Carries a `test` built by `membershipTest` — the SAME function `case 'in'` uses, so the two
   * spellings agree on three-valued membership by construction rather than by re-deriving it. A
   * haystack that varies per row declines the lift, exactly as it declines hoisting there.
   */
  memberProps?: readonly CMemberProp[];

  /**
   * `WHERE n.k IS NULL` / `IS NOT NULL`, and the `NOT (n.k IS NULL)` spelling — read off the
   * ELEMENT instead of through the binding (item 1270).
   *
   * A sixth list for the same reason as the fifth: `isNull` is an `Expr` kind of its own, so
   * `directEqProps` declined its WHOLE chain on it while the INLINE spelling of the same question
   * — `(n {k: null})`, which this engine reads AS `IS NULL` — landed in `props` and was already
   * element-direct. Measured at 200,000 vertices, the first two answering an identical 2000:
   *
   * ```text
   *   {nk: null} inline        3.317 ms   16.6 ns a vertex
   *   nk IS NULL               5.683      28.4            1.71x
   *   nk IS NOT NULL           5.549      27.7
   *   NOT (nk IS NULL)         6.438      32.2            worse still
   * ```
   *
   * The native engine had this same omission in its own matcher and it cost ~4x twice over (items
   * 1261 and 1262) — including the `NOT (… IS NULL)` spelling, which is why that one is folded here
   * rather than left for a second pass.
   *
   * ⚠️ A NULL TEST IS TOTAL, which is what makes this lift simple where the others needed care:
   * `isNullish` returns a plain boolean, there is no UNKNOWN to settle, and nothing here can RAISE.
   * It applies `isNullish` — the SAME function `case 'isNull'` uses — so absent and stored-null
   * cells are classified identically on both routes rather than by re-deriving the rule.
   */
  nullProps?: readonly CNullProp[];

  /**
   * `WHERE n.flag IS TRUE` and its family (item 1286) — the `isTruth` leaf item 1272 listed as
   * declined and unpriced.
   *
   * Priced at 200,000 vertices against `n.marker = true`, a `compare` arranged to keep EXACTLY the
   * same rows so the two answer an identical 20000 and a per-survivor cost cannot explain the gap:
   *
   * ```text
   *   n.marker = true    4.473 ms   lifts into eqProps
   *   n.flag IS TRUE    10.379      2.32x, no arm for it
   *   n.k IS NULL        4.616      lifts into nullProps (item 1270)
   * ```
   *
   * The `IS NULL` row is why this is the right layer: `isNull` and `isTruth` are BOTH refused by
   * `rowLocal`'s allowlist, so the node-count gate declines both — and `isNull` is fast anyway,
   * because `pushWhereIntoNode` routes a clause `WHERE` through `compilePredicate`, where item 1270
   * gave it an arm. The allowlist was a red herring; the missing arm was the whole cost.
   *
   * Applied beside `nullProps` because it shares the property that matters: it cannot raise, so it
   * is safe even ahead of a residual.
   */
  truthTestProps?: readonly CTruthTestProp[];

  /**
   * `WHERE n.v IS TYPED INTEGER` and its family (item 1298) — the last structurally liftable leaf
   * item 1272 listed as declined, priced at item 1297.
   *
   * 200,000 nodes against `n.marker = true`, a `compare` marking exactly the rows the test keeps,
   * so both answer an identical 100000:
   *
   * ```text
   *   n.marker = true            4.367 ms
   *   n.v IS TYPED INTEGER      12.976      2.97x
   *   n.v IS NOT TYPED INTEGER   6.971      1.60x
   * ```
   *
   * ⚠️ THE TWO SPELLINGS COST DIFFERENTLY BEFORE THIS LIFT (12.976 against 6.971 on a 50/50 split
   * answering the same count), and item 1297 recorded that as its own open question since the lift
   * was absent from BOTH. If they still differ after this, that asymmetry is a second defect and
   * not this one.
   */
  typedTests?: readonly CTypedTestProp[];

  /**
   * `WHERE n IS LABELED Person` and its family (item 1289) — the `isLabeled` leaf item 1272 listed
   * as declined, priced at item 1288.
   *
   * 200,000 vertices against `n.a >= 0`, a `compare` every row satisfies, so both answer an
   * identical 200000 and the gap is pure route cost:
   *
   * ```text
   *   n.a >= 0              4.076 ms
   *   n IS LABELED P       10.656      2.61x
   * ```
   */
  labelTests?: readonly CLabelTest[];

  /**
   * The same lift for a DOTTED path — `WHERE n.meta.city = 'nyc'` (item 900).
   *
   * A fourth list for a blunt reason: `asPropCompare` matches a plain `prop` only, so a dotted
   * conjunct made `directEqProps` decline and took THE WHOLE PREDICATE to the generic evaluator.
   * Item 874 priced that route at 2.02x for a flat property; item 899 measured the dotted spelling
   * at 101.5 ns/row against a flat 26.5 on the same scan, and attributed all of it to the field
   * step rather than to reading the record.
   *
   * Carries its `op` and applies through `compareTruth` — the SAME function the generic `compare`
   * arm uses — so an `=` here means what `=` means there (the EXPRESSION reading: a null operand
   * is UNKNOWN and the row drops), and the lift cannot change an answer. That is why it needs no
   * null-right-hand-side guard of its own, where `eqProps` does: `eqProps` reaches for
   * `structuralEq` and has to rule out the inline reading, this does not.
   *
   * `path` always has at least TWO segments. One segment is `eqProps`/`cmpProps`' own case and
   * stealing it would re-route a tuned path for nothing.
   */
  pathProps?: readonly CPathProp[];
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
export type CSeedHint =
  | { kind: 'eq'; key: string; value: CompiledExpr }
  | { kind: 'within'; key: string; values: CompiledExpr }
  | { kind: 'range'; key: string; bound: CRangeBound }
  /**
   * `element_id(n) = '<id>'` — a point lookup by element id. It carries no `key`,
   * because the thing it seeks on is not a property: the graph's own `verticesById` is
   * the index, so this hint needs no `createIndex` to be useful. At most ONE vertex.
   *
   * Item 618. Before it, GQL's commonest serving query was a label scan with an
   * `element_id` call and a string compare per vertex — measured at 4413 µs against
   * 1.75 µs for the same lookup on an indexed property.
   */
  | { kind: 'id'; value: CompiledExpr }
  /**
   * `element_id(n) IN ['a', 'b']` — the LIST form of the hint above, and the `=`-chain spelling
   * of it (item 1315). At most `|ids|` vertices, resolved straight from `verticesById`, so like
   * its single-id twin it needs no `createIndex`.
   *
   * Item 618 gave the single id a seed and the list kept scanning, which is the canonical pair
   * CLAUDE.md names — `k = $a OR k = $b` vs `k IN [$a, $b]` — on IDS rather than on a property.
   * Measured at 200,000 vertices before this existed:
   *
   * ```text
   *   element_id(n) = 'v137'                       0.0078 ms   seeded
   *   element_id(n) IN ['v137','v9000','v4242']   10.8884      1396x
   *   element_id(n) = a OR = b OR = c             17.8057      2283x
   * ```
   *
   * Sound for the reason every hint here is: it only narrows the SEED, and `matchNode` plus the
   * residual `WHERE` re-validate, so a seed may be a superset and never a subset. A non-string
   * entry resolves to nothing, which is correct rather than merely safe — `element_id` yields a
   * string, so no vertex can equal a number.
   */
  | { kind: 'idIn'; values: CompiledExpr }
  /**
   * The node at one END of the edge whose external id is `value` — the single node a hop
   * can start from when its REL variable's id is pinned (`MATCH (a)-[r:R]->(b) WHERE
   * element_id(r) = $x`). `sourceEnd` picks which end: an `out` hop starts at the edge's
   * `from`, an `in` hop at its `to`.
   *
   * Item 621, the TS twin of 620. Like every hint here it only narrows a SEED — `matchNode`
   * and the residual `WHERE` re-validate — so it may be a superset and never a subset.
   */
  | { kind: 'edgeEnd'; value: CompiledExpr; sourceEnd: boolean }
  | { kind: 'edgeEndIn'; values: CompiledExpr; sourceEnd: boolean };

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

/** One lifted `<ownVar>.<key> IS [NOT] NULL` conjunct (item 1270). */
export type CNullProp = {
  key: string;
  /** `true` for `IS NOT NULL`, mirroring the AST's own `negated` flag. */
  negated: boolean;
};

/**
 * One lifted `<ownVar>.<key> IS [NOT] TRUE|FALSE|UNKNOWN` conjunct (item 1286).
 *
 * ⚠️ TOTAL AND NON-RAISING, which is what makes this the easiest of the lifted families to get
 * right — the same property `CNullProp` has. `case 'isTruth'` says it outright: the test is an
 * EXACT three-valued comparison, not a truthiness coercion, so a non-boolean is simply "no"
 * rather than a fault, and it yields a plain boolean with no UNKNOWN to settle.
 */
/**
 * One lifted `<ownVar>.<key> IS [NOT] TYPED <value type> [NOT NULL]` conjunct (item 1298).
 *
 * TOTAL AND NON-RAISING, like `CTruthTestProp`: `valueIsTypedTy` returns a plain boolean and
 * `case 'isTyped'` composes it with `negated ? !m : m`, so there is no UNKNOWN to settle.
 *
 * ⚠️ AND YET IT RUNS IN THE **LATE** GROUP, after `truthProps`, exactly as `truthTestProps` does.
 * Non-raising does NOT imply hoistable in this engine — the engine is the authority (item 1286) and
 * it hoists no form of this test, measured at item 1297 with `n.s` as the faulting sibling:
 *
 * ```text
 *   WHERE n.s AND n.n IS TYPED STRING      native ERR   FALSE every row and STILL raises
 *   WHERE n.s AND n.s IS TYPED INTEGER     native ERR   FALSE every row and STILL raises
 * ```
 */
export type CTypedTestProp = {
  key: string;
  ty: TypeTest;
  /** The `NOT NULL` suffix, mirroring the AST. */
  notNull: boolean;
  /** `true` for the `IS NOT TYPED` spelling, mirroring the AST's own flag. */
  negated: boolean;
};

export type CTruthTestProp = {
  key: string;
  /** `true`/`false` for IS TRUE / IS FALSE; `null` for IS UNKNOWN, mirroring the AST. */
  truth: boolean | null;
  /** `true` for the `IS NOT …` spelling, mirroring the AST's own flag. */
  negated: boolean;
};

/**
 * One lifted `<ownVar> IS [NOT] LABELED <label expr>` conjunct (item 1289).
 *
 * ⚠️ THE SUBJECT IS THE ELEMENT, NOT A PROPERTY, which is what makes this the first lifted family
 * with no `key`. Every other one reads `propOf(element, key)`; this one reads `element.labels`.
 *
 * TOTAL AND NON-RAISING, like `CNullProp` and `CMemberProp`: `case 'isLabeled'` yields
 * `isElement(el) ? labelsMatch(el.labels, label) : false` — a plain boolean with no UNKNOWN to
 * settle and nothing that can fault. The native engine HOISTS it past a faulting sibling, measured
 * at item 1288, so it belongs in the non-raising group.
 */
export type CLabelTest = {
  label: LabelExpr;
  /** `true` for the `IS NOT LABELED` spelling, mirroring the AST's own flag. */
  negated: boolean;
};

/** One lifted `<ownVar>.<key> IN <closed list>` conjunct (item 1269). */
type CMemberProp = {
  key: string;
  test: (needle: unknown, env: EvalEnv) => Truth;
  /**
   * `true` for the `NOT IN` spelling (item 1288), applied as `not3` of the test — the SAME
   * composition `case 'in'` uses, so the two routes cannot drift on the three-valued rule.
   *
   * Item 1269 left this out deliberately and said why: "`NOT IN` is `not3` of this test, and
   * `not3` of UNKNOWN is UNKNOWN, so lifting it would be sound — but it is unmeasured, so it stays
   * on the generic path rather than being added untested." Now measured, at 200,000 vertices with
   * the selectivity matched by construction so both spellings answer an identical 180000:
   *
   * ```text
   *   n.keep = true                     3.542 ms   the lifted twin
   *   n.a NOT IN [0..9]                 9.409      2.66x
   *   n.a IN [0..9]                     3.823      already lifted — the instrument's control
   * ```
   */
  negated: boolean;
};

/**
 * Did the prefix lift a family whose reading can RAISE where the whole-chain route would not?
 *
 * `truth`/`notTruth` coerce a value to a boolean and raise on a non-boolean. `eq`, `nulls` and
 * `member` cannot raise — equality is total (a cross-type `=` answers no-match), `isNullish`
 * returns a plain boolean, and membership is built on equality.
 *
 * ⚠️ `cmp`/`path` USED TO BE HELD BACK HERE AND NO LONGER ARE (item 1545). An ordering comparison
 * does throw on a cross-type pair, so lifting one ahead of a residual can RAISE where the
 * whole-chain route settled the row FALSE first — a query that works today can start throwing on
 * mixed-type data. That is a deliberate trade the owner took on being shown it: the hold cost
 * **1.55x on `n.a < 1 AND <unliftable>` (8.60 → 5.55 ms) and 2.66x on the reverse spelling
 * (14.63 → 5.50)**, at 200,000 vertices with the selectivity matched to the `eq` twin so the pair
 * differs only in which family the conjunct lands in. The win is an ORDERING effect and cannot be
 * had without it: the lifted arm beats the unliftable conjunct ALONE (5.55 against 8.2) precisely
 * because it drops 99% of rows before the expensive residual runs.
 *
 * `truth`/`notTruth` stay held back, and that is not timidity — `and-short-circuit-conformance.ts`
 * pins `WHERE n.s AND false` and `WHERE n.s AND n.n IS UNKNOWN` as agreeing across the engines, and
 * lifting a bare-property coercion ahead of the residual breaks both.
 *
 * Named rather than inlined because the four-way test put `directEqProps` over the complexity cap,
 * and because the question it asks deserves a sentence of its own.
 */
const raisesWhereTheChainWouldNot = (lists: {
  truth: readonly string[];
  notTruth: readonly string[];
  cmp: readonly CCmpProp[];
  path: readonly CPathProp[];
}): boolean => lists.truth.length > 0 || lists.notTruth.length > 0;

/**
 * The tail `directEqProps` could not read, as one expression — or `'decline'`, meaning the chain
 * keeps its old whole-predicate route (item 1284).
 *
 * ⚠️ A TAIL THAT READS ANOTHER VARIABLE DECLINES, as it always did. The callers that pass an
 * `ownVar` have PROVED the predicate element-local, so such a tail should not arrive here at all —
 * but the three sites that evaluate a residual (`relOnlyHopCount` and the two `startLifted` gates)
 * bind only the element's OWN variable, so a residual reading `m` would be evaluated against a
 * binding that has no `m`. Declining there costs nothing measured: the 1.8x this item bought is a
 * tail on the element's own variable (`n.a >= n.a`, `upper(n.s)`), not on another one.
 *
 * `direct-eq-props-param.test.ts`'s `a conjunct on ANOTHER variable declines the WHOLE chain` is
 * the guard, and it keeps its teeth UNCHANGED rather than being rewritten to match a wider rule.
 */
const residualOf = (
  rest: readonly Expr[],
  ownVar: string,
  lifted: {
    truth: readonly string[];
    notTruth: readonly string[];
    cmp: readonly CCmpProp[];
    path: readonly CPathProp[];
  },
): Expr | undefined | 'decline' => {
  // A RAISE-CAPABLE family must not lift ahead of a residual — see `raisesWhereTheChainWouldNot`.
  // Checked here, where the residual's existence is already known, so `directEqProps` keeps ONE
  // decision instead of two: it sits at the complexity cap and each extra branch there has to earn
  // its place.
  if (rest.length > 0 && raisesWhereTheChainWouldNot(lifted)) {
    return 'decline';
  }

  for (const conjunct of rest) {
    for (const free of freePredicateVars(conjunct)) {
      if (free !== ownVar) {
        return 'decline';
      }
    }
  }

  if (rest.length === 0) {
    return undefined;
  }

  // ONE expression when a single conjunct is left, an `and` of the rest otherwise — rebuilt from
  // the FLATTENED list, so a two-conjunct residual is flat even if the source parenthesised it.
  return rest.length === 1 ? rest[0] : { kind: 'and', items: rest };
};

/**
 * `<ownVar> IS [NOT] LABELED <label expr>` as a liftable conjunct, or null (item 1289).
 *
 * `NOT (x IS LABELED L)` folds by FLIPPING `negated`, the same way `asNullTest` and `asTruthTest`
 * fold their `NOT (…)` spellings — both of this file's earlier two-pass mistakes (items 1261 then
 * 1262) came from handling one spelling and noticing the other later.
 */
/**
 * File one lifted `IS [NOT] LABELED` conjunct, returning whether it claimed the conjunct.
 *
 * The same shape as `liftNullTest` and `liftTruthTest`, and extracted for the same reason: this is
 * the third family added to a `directEqProps` that sits at its complexity cap, so each arm is one
 * branch in the loop and the matching lives in here.
 *
 * ⚠️ THE SUBJECT IS A `var`, NOT A `prop` — the one arm in that loop which matches the bare
 * variable, because `IS LABELED` asks about the ELEMENT rather than about one of its properties.
 */
/**
 * File one lifted membership conjunct: `'taken'`, `'stop'` (decline the rest of the chain), or
 * `'skip'` (not this family).
 *
 * ⚠️ `NOT IN` LIFTS TOO SINCE ITEM 1288, and it stays in the NON-RAISING group: `not3` of a
 * membership cannot raise, and the native engine HOISTS it past a faulting sibling — the
 * measurement item 1286 established as the authority on that question:
 *
 * ```text
 *   WHERE n.s AND n.n NOT IN [1, 2]   native ok []   FALSE for every row, so hoisted
 *   WHERE n.s AND n.n NOT IN [99]     native ERR     TRUE, settles nothing, uninformative
 * ```
 *
 * ⚠️ THE OR SPELLING IS FOLDED BY `asMembershipNode`, not received already folded — item 1269's
 * first cut assumed otherwise and left `OR` on the generic path at 6.042 while `IN` went to 3.699.
 *
 * Extracted at item 1289 because `directEqProps` sits at its complexity cap and this arm carries
 * four conditions; the three-way result keeps the chain-declining case explicit at the call site
 * rather than hiding it in a boolean.
 */
/**
 * File one lifted NEGATED compare: `'taken'`, `'stop'` (decline the rest of the chain) or `'skip'`.
 *
 * `NOT (n.k = v)` is `n.k <> v` and `NOT (n.k <> v)` is `n.k = v`, so the lift is a flip of the
 * operator (item 1272).
 *
 * ⚠️ EQUALITY ONLY, AND THE RESTRICTION IS NaN. `NOT (x >= 2)` is NOT `x < 2`: this repo keeps NaN
 * JS-unordered, so every ordering comparison against NaN is FALSE, making the negation TRUE where
 * the flipped operator is FALSE. `=`/`<>` have no such hole — they are exact complements on every
 * value this engine stores. `NEGATED_COMPARE` enforces this, and
 * `negated-compare-lift.test.ts` demonstrates what widening it would cost with a NaN PARAM, which
 * is not coerced the way a stored NaN is. Same restriction `opt::normalize_pred` carries natively.
 *
 * ⚠️ THE DOTTED FORM LIFTS TOO SINCE ITEM 1290. `asPropCompare` matches a plain `prop` only, so
 * `NOT (n.m.k = 5)` used to decline — while `n.m.k <> 5`, the same question, lifted into
 * `pathProps` (item 900). Measured at 200,000 vertices against that positive form, which is the
 * right twin because item 899 measured the dotted field step at 101.5 ns/row against a flat 26.5:
 *
 * ```text
 *   n.m.k <> 5           8.613 ms
 *   NOT (n.m.k = 5)     15.783      1.83x
 * ```
 *
 * The engine hoists both spellings past a faulting sibling, so this adds nothing to `pathProps`'
 * existing ordering:
 *
 * ```text
 *   WHERE n.s AND n.m.k = 99          native ok []   FALSE every row -> hoisted
 *   WHERE n.s AND NOT (n.m.k <> 99)   native ok []   folds to `=`, FALSE every row -> hoisted
 *   WHERE n.s AND NOT (n.m.k = 99)    native ERR     TRUE every row -> uninformative
 * ```
 */
const liftNegatedCompare = (
  conjunct: Expr,
  ownVar: string,
  eq: CProp[],
  cmp: CCmpProp[],
  path: CPathProp[],
): 'taken' | 'stop' | 'skip' => {
  const negated = asNegatedCompare(conjunct);

  if (negated === null) {
    return 'skip';
  }

  const npc = asPropCompare(negated);

  if (npc?.variable === ownVar) {
    if (npc.op === '=') {
      eq.push({ key: npc.key, value: compileExpr(npc.value) });
    } else {
      cmp.push({ key: npc.key, op: npc.op, value: compileExpr(npc.value) });
    }

    return 'taken';
  }

  // The DOTTED form, tried only after the flat one — the same order the positive arm uses, and for
  // the same reason: `asPathCompare` is the broader matcher.
  const npath = asPathCompare(negated);

  if (npath?.variable === ownVar) {
    path.push({ path: npath.path, op: npath.op, value: compileExpr(npath.value) });

    return 'taken';
  }

  // A negated compare on ANOTHER variable, or one whose value side is not closed, declines the rest
  // of the chain — which is what happened to EVERY negated compare before item 1272, so nothing
  // regresses by declining here.
  return 'stop';
};

const liftMembership = (
  conjunct: Expr,
  ownVar: string,
  out: CMemberProp[],
): 'taken' | 'stop' | 'skip' => {
  const node = asMembershipNode(conjunct);

  if (node?.kind !== 'in' || node.expr.kind !== 'prop' || node.expr.variable !== ownVar) {
    return 'skip';
  }

  const test = membershipTest(node.list);

  // A haystack that varies per row cannot be lifted — and declining the rest of the chain here
  // matches what the loop does with every other conjunct it cannot read.
  if (test === null) {
    return 'stop';
  }

  out.push({ key: node.expr.key, test, negated: node.negated });

  return 'taken';
};

const directEqProps = (
  where: Expr,
  ownVar: string | undefined,
): {
  eq: CProp[];
  cmp: CCmpProp[];
  truth: string[];
  /** Keys of `NOT <ownVar>.<key>` conjuncts — the negated twin of `truth` (item 984). */
  notTruth: string[];
  path: CPathProp[];
  /** `<ownVar>.<key> IN <closed list>` conjuncts (item 1269). */
  member: CMemberProp[];
  /** `<ownVar>.<key> IS [NOT] NULL` conjuncts (item 1270). */
  nulls: CNullProp[];
  /** `<ownVar>.<key> IS [NOT] TRUE|FALSE|UNKNOWN` conjuncts (item 1286). */
  truthTests: CTruthTestProp[];
  /** `<ownVar>.<key> IS [NOT] TYPED <type>` conjuncts (item 1298). */
  typedTests: CTypedTestProp[];
  /** `<ownVar> IS [NOT] LABELED <label expr>` conjuncts (item 1289). */
  labelTests: CLabelTest[];
  residual: Expr | undefined;
} | null => {
  if (ownVar === undefined) {
    return null;
  }

  // ⚠️ A NESTED `and` IS FLATTENED (item 1271), and the note that used to stand here said why it
  // was not: "the parser produces one flat `items` list for `a AND b AND c`, so the nested shape
  // arrives only from parenthesisation, and declining it is a missed optimisation, not a wrong
  // answer." Both halves are true and the conclusion was still wrong — a missed optimisation that
  // PARENTHESES alone turn on is this engine's named bug class, and it was the most expensive
  // decline left in this function. 200,000 vertices, all three answering an identical 2000:
  //
  //   a=50 AND b=0 AND c=0        3.558 ms   17.8 ns a vertex
  //   (a=50 AND b=0) AND c=0      7.615      38.1            2.14x
  //   a=50 AND (b=0 AND c=0)      6.732      33.7            1.89x
  //
  // DEPTH-FIRST, LEFT TO RIGHT, so the flattened list is the conjuncts in WRITTEN order — the same
  // order the flat spelling produces. That matters beyond tidiness: this loop groups what it lifts
  // into families, so the order conjuncts arrive in is the order a RAISE is reached in, and a
  // flatten that reordered them could change which query errors.
  const conjuncts: Expr[] = [];

  flattenAnd(where, conjuncts);
  const eq: CProp[] = [];
  const cmp: CCmpProp[] = [];
  const truth: string[] = [];
  const notTruth: string[] = [];
  const path: CPathProp[] = [];
  const member: CMemberProp[] = [];
  const nulls: CNullProp[] = [];
  const truthTests: CTruthTestProp[] = [];
  const typedTests: CTypedTestProp[] = [];
  const labelTests: CLabelTest[] = [];

  // ⚠️ AN UNADMITTED CONJUNCT STOPS THE LOOP, it no longer forfeits the chain (item 1284).
  // `stop` is the index of the first conjunct this loop could not read; everything from there on
  // is the residual and keeps WRITTEN ORDER. Lifting a PREFIX is what makes that sound without a
  // reordering argument: the lifted families run before the residual, and a prefix is already
  // before it in the source, so no conjunct overtakes another. The forfeit was expensive —
  // 200,000 vertices, the unliftable conjunct `n.a >= n.a` (true for every row, so the answers
  // are identical and it cannot raise):
  //
  //   a=50 alone, lifts                 4.160 ms   20.8 ns a vertex
  //   a=50 AND b=0, both lift           4.083      20.4
  //   a=50 AND <unliftable>             8.072      40.4            1.94x
  //   a=50 AND b=0 AND <unliftable>    10.686      53.4            2.62x
  //   [CTL] <unliftable> alone         12.496      62.5            nothing lifts either way
  //
  // The unliftable conjunct runs only on the 1% that survive `a = 50`, so nearly all of that is
  // the SIBLINGS' forfeited lift rather than its own cost.
  //
  // ⚠️ THE REVERSE ORDER IS DELIBERATELY NOT DONE. `<unliftable> AND a=50` measured 13.750 and a
  // lift would take it to ~4.3 (3.2x), but only by running `a = 50` FIRST — which is observable
  // when the unliftable conjunct can RAISE, because short-circuiting on FALSE would then skip a
  // throw that happens today. It needs its own argument and its own item; the test
  // `a declining conjunct is not overtaken` pins the boundary so it cannot be taken by accident.
  /**
   * The conjuncts this loop could not read, in WRITTEN ORDER — the residual.
   *
   * ⚠️ IT USED TO BE A PREFIX RULE and that forfeited every lift after the first unreadable
   * conjunct (item 1544). `stop` was the index of the first conjunct the scan could not read and
   * everything from there on became the residual, so `<unliftable> AND n.a = 50` lifted NOTHING
   * while `n.a = 50 AND <unliftable>` lifted the equality. Two spellings of one question, measured
   * 13.952 ms against 5.741 — the equivalent-spelling class CLAUDE.md names, answering identically.
   *
   * Collecting the unreadable ones instead lets a liftable conjunct lift from ANY position. That
   * reorders evaluation: the lifted families run before the residual, so a row the lift rejects
   * never reaches a residual that might have raised. The engine declined exactly this on those
   * grounds until the owner settled it at item 1543 — evaluation order is chosen for SPEED per
   * engine, and an error one side raises where the other short-circuits past it is accepted.
   *
   * The OTHER guard is untouched and still does its job: `residualOf` declines the whole lift when
   * a raise-capable family (`truth`, `notTruth`, `cmp`, `path`) would lift ahead of a residual, so
   * this widens only the families that cannot raise.
   */
  const skipped: Expr[] = [];

  for (const conjunct of conjuncts) {
    // A BARE PROPERTY standing alone as the predicate (`WHERE n.flag`), which this used to
    // decline along with the whole chain — it is not a `compare`. Item 874 counted the cost of
    // that: the generic evaluator does a binding `Map` lookup and a closure call per scanned
    // vertex, where a lifted conjunct reads the element directly, and the two spellings of this
    // one question measured 2.02x apart. `truthProps` carries no value side, so there is nothing
    // to check for closedness; the variable check is the whole precondition.
    if (conjunct.kind === 'prop' && conjunct.variable === ownVar) {
      truth.push(conjunct.key);
      continue;
    }

    // `WHERE NOT n.flag` (item 984). Before this the check below declined the WHOLE chain on it
    // — a `not` is neither a bare `prop` nor a `compare` — so the predicate ran entirely through
    // the generic evaluator, while `n.flag = false` lifted into `eqProps` because it IS a
    // compare. Item 983 measured those two spellings of one question **2.20x apart**.
    if (
      conjunct.kind === 'not' &&
      conjunct.expr.kind === 'prop' &&
      conjunct.expr.variable === ownVar
    ) {
      notTruth.push(conjunct.expr.key);
      continue;
    }

    // `WHERE NOT (n.k = v)` is `n.k <> v`, and `NOT (n.k <> v)` is `n.k = v` (item 1272). Before
    // this, `NOT` of a compare was neither a bare `prop` nor a `compare` and declined the whole
    // chain, while the `<>` spelling of the same question lifted into `cmpProps`. 200,000 vertices,
    // both answering an identical 198000:
    //
    //   a <> 50          3.859 ms   19.3 ns a vertex
    //   NOT (a = 50)     6.467      32.3            1.68x
    //
    // ⚠️ EQUALITY ONLY, AND THE RESTRICTION IS NaN. `NOT (x >= 2)` is NOT `x < 2`: this repo keeps
    // NaN JS-unordered, so every ordering comparison against NaN is FALSE, making the negation TRUE
    // where the flipped operator is FALSE. `=`/`<>` have no such hole — they are exact complements
    // on every value this engine stores:
    //
    //   present and equal      `=` TRUE,    NOT -> FALSE   `<>` FALSE
    //   present and unequal    `=` FALSE,   NOT -> TRUE    `<>` TRUE
    //   null or absent cell    `=` UNKNOWN, NOT -> UNKNOWN  `<>` UNKNOWN   (a filter drops both)
    //
    // This is the same restriction `opt::normalize_pred` carries in the Rust engine, and the reason
    // item 1262's rewrite there is equality-only.
    // `WHERE NOT (n.k = v)`, `NOT (n.k <> v)`, and since item 1290 the DOTTED forms.
    const neg = liftNegatedCompare(conjunct, ownVar, eq, cmp, path);

    if (neg === 'stop') {
      skipped.push(conjunct);
      continue;
    }

    if (neg === 'taken') {
      continue;
    }

    // `WHERE n.k IS NULL` / `IS NOT NULL` (item 1270), and `NOT (n.k IS NULL)` — the third
    // spelling, canonicalized by FLIPPING the flag rather than by a separate list. The native
    // engine fixed its own two spellings in two passes (items 1261 then 1262) because the second
    // was not noticed until the first shipped; both are here at once.
    if (liftNullTest(conjunct, ownVar, nulls)) {
      continue;
    }

    // `WHERE n.flag IS TRUE` and its family (item 1286), including the `NOT (… IS TRUE)`
    // spelling. Measured at 2.32x against the `= true` spelling of the same question, with the
    // selectivity matched by construction so both answer an identical 20000.
    if (liftTruthTest(conjunct, ownVar, nulls, truthTests)) {
      continue;
    }

    // `WHERE n.v IS TYPED INTEGER` (item 1298).
    if (liftTypedTest(conjunct, ownVar, typedTests)) {
      continue;
    }

    // `WHERE n IS LABELED P` (item 1289).
    if (liftLabelTest(conjunct, ownVar, labelTests)) {
      continue;
    }

    // `WHERE n.k IN [..]` AND the `n.k = a OR n.k = b` spelling (item 1269).
    //
    // ⚠️ THE OR SPELLING HAS TO BE FOLDED HERE, and the first cut of this item assumed it arrived
    // already folded. It does not: `membershipFromEqChain` is applied inside `compileExpr`'s
    // `case 'or'` — deliberately, so that every ANALYSIS pass still sees the original `or` and
    // `collectHints`' seeding keeps firing — which is a stage this loop runs BEFORE. The two
    // spellings had measured identically (5.884 against 5.885), and that was two shapes costing
    // the same rather than one shape, so lifting `in` alone left `OR` at 6.042 while `IN` went to
    // 3.699. Folding here reads the same function and still does not touch the AST.
    //
    // NEGATED IS LEFT OUT, deliberately. `NOT IN` is `not3` of this test, and `not3` of UNKNOWN is
    // UNKNOWN, so lifting it would be sound — but it is unmeasured, so it stays on the generic
    // path rather than being added untested.
    // `WHERE n.k IN [..]`, `NOT IN`, and the `n.k = a OR n.k = b` spelling.
    const mem = liftMembership(conjunct, ownVar, member);

    if (mem === 'stop') {
      skipped.push(conjunct);
      continue;
    }

    if (mem === 'taken') {
      continue;
    }

    if (conjunct.kind !== 'compare') {
      skipped.push(conjunct);
      continue;
    }

    // `asPropCompare` is the seed-hint extractor's own reader: it handles both operand orders
    // (because `n.k = 2` and `2 = n.k` are one question and this engine's named bug class is the
    // two costing differently) and already requires a CLOSED value side.
    // A DOTTED path lifts too (item 900), and it is tried BEFORE the plain-property decline
    // below — otherwise one dotted conjunct in an AND chain takes the WHOLE predicate to the
    // generic evaluator, including every flat conjunct beside it that would have lifted.
    const pathc = asPathCompare(conjunct);

    if (pathc !== null) {
      if (pathc.variable !== ownVar) {
        skipped.push(conjunct);
        continue;
      }

      path.push({ path: pathc.path, op: pathc.op, value: compileExpr(pathc.value) });
      continue;
    }

    const pc = asPropCompare(conjunct);

    if (pc === null || pc.variable !== ownVar) {
      skipped.push(conjunct);
      continue;
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

  // `path` IS part of this guard, and leaving it out is why item 900's attempt measured nothing
  // (item 903). A LONE dotted conjunct accumulated into `path` and was then discarded here because
  // the other three lists were empty — so it lifted only when some OTHER conjunct lifted beside
  // it, and the benchmark predicate is a lone dotted compare. A new list has to be added to every
  // place that asks "did anything lift", not just to the return type.
  if (
    eq.length === 0 &&
    cmp.length === 0 &&
    truth.length === 0 &&
    notTruth.length === 0 &&
    path.length === 0 &&
    member.length === 0 &&
    nulls.length === 0 &&
    truthTests.length === 0 &&
    typedTests.length === 0 &&
    labelTests.length === 0
  ) {
    return null;
  }

  // `residual` is the tail the loop could not read — what the note that used to stand here called
  // "the next step rather than this one". It is `undefined` for a fully-admitted chain, ONE
  // expression when a single conjunct is left, and an `and` of the rest otherwise, rebuilt from
  // the FLATTENED list so that a two-conjunct residual is flat even if the source parenthesised
  // it.
  const residual = residualOf(skipped, ownVar, { truth, notTruth, cmp, path });

  if (residual === 'decline') {
    return null;
  }

  // ⚠️ WITH A RESIDUAL, ONLY THE NON-RAISING FAMILIES MAY LIFT — and this is a WRONG ANSWER rather
  // than a missed optimisation. `truthProps` reads a value and coerces it to a boolean, which
  // RAISES on a non-boolean; the generic `and` arm does not, because FALSE dominates and settles
  // the row first. So lifting a bare `prop` ahead of a residual exposes a raise the whole-chain
  // route suppresses. Measured, as a TS-vs-native divergence that
  // `packages/native/src/and-short-circuit-conformance.test.ts` caught:
  //
  //   MATCH (n:P) WHERE n.s AND false             native ok []   TS ok [] -> ERR E_INVALID_VALUE
  //   MATCH (n:P) WHERE n.s AND n.n IS UNKNOWN    native ok []   TS ok [] -> ERR E_INVALID_VALUE
  //
  // `cmp` and `path` are held back for the same reason one step removed: an ordering comparison
  // throws on a cross-type pair (an `=` does not — it answers no-match), so a residual that would
  // have settled the row to FALSE first is load-bearing there too. `eq`, `nulls` and `member`
  // cannot raise: equality is total, `isNullish` returns a plain boolean, and membership is built
  // on equality. They are also where the 1.8-2.3x is, so the restriction costs nothing measured.
  //
  // A FULLY-ADMITTED chain is untouched by this — it has no residual, every conjunct lifts, and
  // item 259 covers the ordering among families.
  return {
    eq,
    cmp,
    truth,
    notTruth,
    path,
    member,
    nulls,
    truthTests,
    typedTests,
    labelTests,
    residual,
  };
};

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
    ...(direct === null || direct.truth.length === 0 ? {} : { truthProps: direct.truth }),
    ...(direct === null || direct.notTruth.length === 0 ? {} : { notTruthProps: direct.notTruth }),
    ...(direct === null || direct.path.length === 0 ? {} : { pathProps: direct.path }),
    ...(direct === null || direct.member.length === 0 ? {} : { memberProps: direct.member }),
    ...(direct === null || direct.nulls.length === 0 ? {} : { nullProps: direct.nulls }),
    ...(direct === null || direct.truthTests.length === 0
      ? {}
      : { truthTestProps: direct.truthTests }),
    ...(direct === null || direct.typedTests.length === 0 ? {} : { typedTests: direct.typedTests }),
    ...(direct === null || direct.labelTests.length === 0 ? {} : { labelTests: direct.labelTests }),
  };
};

// --- seed-hint extraction ----------------------------------------------------

export type HintMap = Map<string, CSeedHint[]>;

const pushHint = (into: HintMap, variable: string, hint: CSeedHint): void => {
  const list = into.get(variable);

  if (list) {
    list.push(hint);
  } else {
    into.set(variable, [hint]);
  }
};

const BOUND_OF: Partial<Record<CompareOp, keyof CRangeBound>> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

/**
 * The first string NOT prefixed by `p`, so `[p, prefixUpper(p))` covers exactly the strings
 * starting with `p` — or `undefined` when no such bound exists (item 1028).
 *
 * Increments the last CODE POINT, not the last UTF-16 unit: `String.prototype.slice` and index
 * access work in UTF-16, so a surrogate pair would be split and the bound would be a lone
 * surrogate. `Array.from` / `codePointAt` iterate code points, which is what the index's own
 * comparison order uses.
 *
 * `undefined` for an empty prefix (every string starts with it, so there is no upper bound) and
 * for one ending at the maximum code point (nothing sorts above it).
 *
 * EXPORTED so the arithmetic can be tested directly, which is the only thing with teeth against
 * it: the residual WHERE re-applies `starts_with`, so a bound that is merely too WIDE changes no
 * answer. Mutants replacing the code-point walk with a UTF-16 slice, or making the bound
 * inclusive, both pass every end-to-end case for that reason (item 1028) — they are perf bugs, and
 * CLAUDE.md's rule for an answer-equivalent choice is to extract the arithmetic and unit-test it.
 */
/**
 * The `[gte, lt)` pair a prefix seeks, or `undefined` when it cannot seek at all (item 1029).
 *
 * EXTRACTED because the decision is a route CHOICE and therefore answer-equivalent: the residual
 * `starts_with` re-validates whatever the seek returns, so a mutant that seeks on the LOWER bound
 * alone changes no answer — it only picks the slower shape (measured 3.6 -> 11.3 ms on an empty
 * prefix, where `>= ''` materializes every id through the index). CLAUDE.md's rule for exactly
 * this: extract the arithmetic and unit-test it.
 *
 * Both sides are present or neither is. A lower bound without its upper is the pessimization
 * above, so "no successor" means "no seek" rather than "half a seek".
 */
export const prefixBound = (v: unknown): { gte: string; lt: string } | undefined => {
  if (typeof v !== 'string') {
    return undefined;
  }

  const lt = prefixUpper(v);

  return lt === undefined ? undefined : { gte: v, lt };
};

export const prefixUpper = (p: string): string | undefined => {
  const chars = Array.from(p);
  const last = chars.pop();

  if (last === undefined) {
    return undefined;
  }

  const next = (last.codePointAt(0) ?? 0) + 1;

  if (next > 0x10_ff_ff) {
    return undefined;
  }

  return chars.join('') + String.fromCodePoint(next);
};

export const collectHints = (where: Expr, into: HintMap): void => {
  switch (where.kind) {
    case 'and':
      for (const conjunct of where.items) {
        collectHints(conjunct, into);
      }

      return;
    case 'compare': {
      // An id equality first. A `func` operand is not a `prop`, so this and `asPropCompare`
      // are mutually exclusive — the order is for reading, not precedence.
      const ic = asIdCompare(where);

      if (ic) {
        pushHint(into, ic.variable, { kind: 'id', value: compileExpr(ic.value) });

        return;
      }

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
    case 'func': {
      // A PREFIX IS A RANGE (item 1028). `STARTS WITH` parses to this `func`, so no compare arm
      // can see it and the predicate reached no index — measured at **5.287 ms against 0.105**
      // for the explicit `>= p AND < succ(p)` spelling it is equivalent to, over 100,000 rows.
      // Two spellings of one question, which is the class every index-seeding bug in this engine
      // has belonged to.
      //
      // The residual WHERE still applies `starts_with`, as it does for every seed here, so the
      // bound only has to be a SUPERSET and the answer never depends on `prefixUpper`'s
      // arithmetic. (It is in fact exact: `[p, succ(p))` is the prefix set.)
      //
      // LITERAL prefixes only. A param's value is not known when hints are collected, and the
      // bound is a compiled EXPRESSION rather than a value, so a param prefix would need a
      // compiled "successor of" form — recorded rather than built, since the literal spelling is
      // the one `STARTS WITH` is written in.
      if (where.name !== 'starts_with' || where.args.length !== 2) {
        return;
      }

      const [subject, prefix] = where.args;

      // A LITERAL **or a PARAM** (item 1029). Item 1028 handled only the literal and reasoned that
      // "the literal spelling is the one `STARTS WITH` is written in" — which contradicts this
      // file's own note on `IN $names`, that binding is the INJECTION-SAFE form and inline
      // literals are the rare one. The same argument applies here, so the param is likely the
      // commoner spelling and 1028 dismissed it too quickly.
      //
      // The successor is computed at EVALUATION time rather than compile time, which is all the
      // param case needed: a `CompiledExpr` is a closure, so the upper bound wraps the prefix's
      // own closure. No new compiled form and no change to `CRangeBound`.
      if (subject?.kind !== 'prop' || prefix === undefined || !isConstExpr(prefix)) {
        return;
      }

      const base = compileExpr(prefix);

      // A LITERAL KEEPS ITS PRECOMPUTED BOUND (item 1028's shape). Routing it through the param
      // closures instead cost the literal spelling ~10% — 0.067-0.075 -> 0.076-0.085 ms, nearly
      // disjoint — because each evaluation recomputes `prefixUpper` for a value that was known at
      // compile time. Small, but it is a control this change can reach and need not move.
      if (prefix.kind === 'lit' && typeof prefix.value === 'string') {
        const upper = prefixUpper(prefix.value);

        if (upper !== undefined) {
          pushHint(into, subject.variable, {
            kind: 'range',
            key: subject.key,
            bound: { gte: base, lt: compileExpr({ kind: 'lit', value: upper }) },
          });
        }

        return;
      }

      pushHint(into, subject.variable, {
        kind: 'range',
        key: subject.key,
        bound: {
          // BOTH SIDES COME FROM `prefixBound`, so they are present together or not at all. When
          // it declines, each closure returns `undefined`, which is not a scalar — so `evalBound`
          // finds no usable endpoint and declines the seek, exactly as the scan did before.
          //
          // Dropping only the UPPER side was tried first and is a PESSIMIZATION: the lower bound
          // alone is `>= ''` for an empty prefix, so the seek materializes every id through the
          // index and then filters — **3.6 -> 11.3 ms**, a 3x regression against the plain scan,
          // caught by the control that exists for this shape.
          gte: (env) => prefixBound(base(env))?.gte,
          lt: (env) => prefixBound(base(env))?.lt,
        },
      });

      return;
    }
    case 'in': {
      if (where.negated || !closedList(where.list)) {
        return;
      }

      if (where.expr.kind === 'prop') {
        pushHint(into, where.expr.variable, {
          kind: 'within',
          key: where.expr.key,
          values: compileExpr(where.list),
        });

        return;
      }

      // `element_id(n) IN [...]` (item 1315). The property arm above tests `kind === 'prop'`, and
      // an `element_id` call is a `func`, so the list spelling had no hint at all while the single
      // `=` spelling seeded — 1396x on 200,000 vertices.
      const idVar = idArgVariable(where.expr);

      if (idVar !== null) {
        pushHint(into, idVar, { kind: 'idIn', values: compileExpr(where.list) });
      }

      return;
    }
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

        return;
      }

      // The ID twin, for the same reason and with the same argument (item 1315). Without it the
      // `=`-chain spelling of an id list was the SLOWEST of the three — 17.8 ms against the `IN`
      // spelling's 10.9 and the single id's 0.0078 — so fixing `IN` alone would have left the two
      // list spellings 1.6x apart, which is the gap this switch exists to close.
      const idChain = uniformIdEqChain(where);

      if (idChain) {
        pushHint(into, idChain.variable, {
          kind: 'idIn',
          values: compileExpr({ kind: 'list', items: idChain.values }),
        });
      }

      return;
    }
    default:
  }
};

/** Append seed hints to a node, or hand it back unchanged. */
export const withPin = (node: CNode, extra: readonly CSeedHint[]): CNode =>
  extra.length > 0 ? { ...node, seedHints: [...(node.seedHints ?? []), ...extra] } : node;

/**
 * Can a segment's rel carry an edge-id pin (item 621)?
 *
 * The `quantifier` half is REDUNDANT today and kept deliberately: a quantified rel that binds
 * a variable is compiled to a `unit` by `compilePath`, so `unit === undefined` already
 * excludes it, and one that binds NO variable has no rel variable to look up. Mutation
 * confirms it — deleting the check changes no answer. Kept because it states the REASON (`r`
 * binds a LIST of edges, so `element_id(r)` is not one edge's id) where the `unit` check
 * states only a mechanism.
 */
export const pinnableSegment = (seg: CSegment): boolean =>
  seg.unit === undefined && seg.rel.quantifier === undefined;

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
export const coalesceRangeHints = (hints: readonly CSeedHint[]): CSeedHint[] => {
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
  // `rel.variable` is deliberately NOT passed, and that is now a MEASURED decision rather than
  // an omission (item 632). Passing it makes an inline rel `WHERE` lift to the element-direct
  // `cmpProps`/`eqProps` exactly as a node's does — verified, `{props:0,where:false,cmp:1}`
  // with it against `{props:0,where:true,cmp:0}` without — and it is worth 1%: the inline
  // spelling measured 454.39ms before and 448.22 after, against the clause spelling's 212.42
  // on the spelling probe's 600,000-edge fixture. The ~2x between those two spellings is a
  // ROUTE difference, not a predicate-evaluator one, so lifting the predicate cannot close it.
  pred: compilePredicate(rel.properties, rel.where),
  quantifier: rel.quantifier,
});

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
export const matchVarSets = (
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

export const compilePath = (pattern: PathPattern): CPath => {
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
 *
 * ALSO REJECTED — replacing the three `for...of` loops below with INDEXED loops (audit item 802).
 * `for...of` over an array builds an iterator and a step result per element, and `props` is EMPTY
 * whenever the predicate came from a clause `WHERE` — an iterator allocated to visit nothing. It
 * is a TRADE, not a win: on a count whose predicate lifts into `eqProps` (`WHERE n.s = 's3'`) the
 * indexed form read 5.66/5.49/5.36 ms against 5.77/6.51/6.14, but on a two-bound `cmpProps` count
 * it read 6.47/7.42/6.14 against 5.93/6.13/5.66 — SLOWER in all three rounds. With both halves of
 * item 802 applied the two shapes come out flat, which is the two effects cancelling rather than
 * either one paying. Item 454's ladder is the reason: 4 ns of the ~24 ns a vertex is the binding
 * `Map` write and ~10 is the property read, so the loop header is not where the time is.
 */
/**
 * `satisfies` PRE-RESOLVED for the one shape a filtered count almost always has: a single ordering
 * comparison on one property, `WHERE n.age > 45`. Returns `undefined` for anything else, and the
 * caller then uses `satisfies` exactly as before.
 *
 * WHY (item 1338). `satisfies` is reached once per ELEMENT and does the same work every time before
 * it can get to the comparison: allocate an `EvalEnv`, then test eleven other carriers. Item 1337
 * ablated the whole call out of `buildNodeCount`'s tally and measured **2.23x** (3.84 -> 1.72 ms at
 * 200,000 vertices), with the ceiling BELOW Gremlin's 2.16 rather than level with it.
 *
 * ⚠️ AND THE COST IS DISTRIBUTED, which is why this is a specialization and not a fix to one term.
 * Item 802 refuted the env allocation and the scaffolding by micro-benchmark; item 1338 re-tested
 * by ablation and agreed — the env reads 3.69 against 4.01 reused (overlapping), and hoisting the
 * right-hand side reads 1.09x against a measured ~1.11x noise floor on the same shape. No single
 * term is resolvable; the aggregate is 2.23x.
 *
 * ⚠️ THE GUARD IS AN ALLOW-LIST OVER THE PREDICATE'S OWN KEYS, and that is not a stylistic choice —
 * it is the fix for a WRONG ANSWER this function already caused. The first version listed the
 * carriers to refuse by hand, and the list was short: `CPredicate` has TWELVE
 * (`props`, `where`, `eqProps`, `cmpProps`, `truthProps`, `notTruthProps`, `memberProps`,
 * `nullProps`, `pathProps`, `labelTests`, `truthTestProps`, `typedTests`) and four were missed, so
 * `WHERE p.meta.city = 'NYC' AND p.n > 2` specialized to the `p.n > 2` half and answered 5 instead
 * of 2. `dotted-predicate-routes.test.ts` caught it.
 *
 * Iterating the keys PRESENT on the predicate inverts that failure mode: a carrier this function
 * has never heard of makes it refuse, where a hand-written deny-list makes it ignore. The cost of
 * being wrong here is a wrong answer, which is item 1328's argument for allow-lists, applied to a
 * type's fields rather than a step kind.
 *
 * SEMANTICS ARE NOT RE-DERIVED. The closure calls `compareTruth` with `COMPARE[op]` and `propOf` —
 * the very functions `satisfies`'s own `cmpProps` loop calls, in the same order — so UNKNOWN still
 * drops the row (item 259) and a cross-type ordering still settles it. The tally's comment requires
 * that the two spellings "agree by construction"; this keeps `satisfies` as the only implementation
 * and binds its arm rather than writing a second one.
 */
/** The five carriers {@link specializeSingleProp} can answer; exactly one may be populated. */
const SPECIALIZABLE: ReadonlySet<string> = new Set([
  'eqProps',
  'cmpProps',
  'nullProps',
  'memberProps',
  'props',
]);

/** The two carriers {@link specializeEqPair} can answer, both of them equality readings. */
const PAIRABLE: ReadonlySet<string> = new Set(['props', 'eqProps']);

/**
 * TWO equality conjuncts as ONE straight-line closure, or `undefined` when the predicate is not
 * that shape. The width-2 sibling of {@link specializeSingleProp}.
 *
 * ⚠️ ITEM 1604 — THE ARITY CLIFF, nominated by `bun run bench:usage` rather than by a profile.
 * `read: keyed dedup lookup` is the slowest INDEXED read in the TS engine by 6-20x over its
 * siblings (76.4k ops/s against 468k-1.49M) and the only indexed read row where TS LOSES to native
 * (76.4k against 162.0k). Its query is `WHERE u.score = $s AND u.active = true` — and the planner
 * says exactly why:
 *
 * ```text
 *    WHERE u.score = $s AND u.active = true    carriers eqProps(2)           specializes FALSE
 *    (u:User {score: $s}) WHERE u.active       carriers props(1) eqProps(1)  specializes FALSE
 *    WHERE u.score = $s                        carriers eqProps(1)           specializes TRUE
 * ```
 *
 * `specializeSingleProp` takes exactly one entry in exactly one carrier, so the one-conjunct shape
 * is specialized and BOTH spellings of the two-conjunct one fall to the general `satisfies` loop.
 * Priced over 1000 seeded candidates, two runs each, one shape per process:
 *
 * ```text
 *    one-clause    20708  21140 ns     specialized
 *    one-inline    21515  21759        specialized
 *    two-clause    54575  56653        NOT                 2.7x the one-conjunct twin
 *    two-inline    58921  59478        NOT
 *    three-clause  76166  81336        NOT                 the next cliff, left there on purpose
 * ```
 *
 * So the FIRST conjunct costs ~21 ns a candidate and each unspecialized one adds ~34.
 *
 * ⚠️ THE UNROLL IS THE SHAPE `filteredHopCount` ALREADY MEASURED, not a new idea: that function's
 * header records a two-filter count at **54.81 ms against a one-filter 28.49**, an inline indexed
 * loop at 41.79, monomorphic key/pred arrays at 43.82 ("so the polymorphic `Step` property load was
 * NOT the cost — that hypothesis is refuted"), and an UNROLLED straight-line pair over captured
 * locals at **30.25** — landing on the one-filter twin. The same cliff at the same arity in a
 * different file, so this takes the answer that was already paid for.
 *
 * ⚠️ A SEPARATE FUNCTION, NOT A WIDENED `specializeSingleProp`. That function's guard structure —
 * one populated carrier, iterate the keys PRESENT so an unknown carrier REFUSES rather than being
 * ignored — exists because its first version used a hand-written list and MISSED FOUR CARRIERS,
 * answering 5 where the right answer was 2. Widening it would put all five of its arms on the same
 * change; this adds a second narrow contract beside it and leaves those untouched.
 *
 * ⚠️ BOTH SPELLINGS OR NEITHER. `props` and `eqProps` are admitted together, which is not
 * generosity: specializing only the clause form would open a 2.7x EQUIVALENT-SPELLING GAP, the
 * defect class this engine is named after, on the exact row that nominated the work.
 *
 * SEMANTICS ARE BOUND, NOT RE-DERIVED, and the two carriers' readings stay apart exactly as item
 * 1598 established — `props` is the INLINE reading (plain `structuralEq`, so `{k: null}` matches a
 * stored null and an absent key) and `eqProps` is the EXPRESSION one (a null right-hand side
 * rejects outright). `satisfies` runs `props` BEFORE `eqProps`, so this emits them in that order
 * and a faulting value expression still faults in the same place.
 */
export const specializeEqPair = (
  pred: CPredicate,
): ((element: Bound, env: EvalEnv) => boolean) | undefined => {
  // The same INVERTED refusal `specializeSingleProp` uses: iterate the keys PRESENT on the
  // predicate, so a carrier this function has never heard of makes it refuse rather than be
  // ignored. A thirteenth carrier added to `CPredicate` must land here as a decline.
  for (const [carrier, held] of Object.entries(pred)) {
    if (held === undefined || (Array.isArray(held) && held.length === 0)) {
      continue;
    }

    if (!Array.isArray(held) || !PAIRABLE.has(carrier)) {
      return undefined;
    }
  }

  const inline = pred.props;
  const lifted = pred.eqProps ?? [];

  // EXACTLY two entries across the two carriers. One is `specializeSingleProp`'s and is tried
  // first by the call sites; three or more is the next cliff and keeps the general loop.
  if (inline.length + lifted.length !== 2) {
    return undefined;
  }

  // Straight-line over captured locals, in `satisfies`'s carrier order: both inline entries, then
  // one of each, then both lifted. Three closures rather than a loop over a pair of arrays,
  // because `filteredHopCount` measured the loop at 41.79 ms against the unroll's 30.25.
  if (inline.length === 2) {
    const [{ key: k0, value: v0 }, { key: k1, value: v1 }] = inline;

    return (element, env) =>
      structuralEq(propOf(element, k0), v0(env)) && structuralEq(propOf(element, k1), v1(env));
  }

  /**
   * ⚠️ THE MIXED ARM IS NOT REACHED BY ANY ENGINE QUERY TODAY, and that is measured rather than
   * assumed. Making it THROW left the suite green except for this file's own two direct tests — so
   * every real query carrying both an inline and a clause constraint splits them into TWO
   * `InlinePred`s, each width-1, which `fastTallyPred` composes from two `specializeSingleProp`
   * results instead. A single pred holding both carriers only arrives from a hand-built
   * `compilePredicate(properties, where, ownVar)` call.
   *
   * It stays, for `specializeSingleProp`'s own stated reason: nothing ENFORCES that split, so a
   * caller that ever does combine them must find a correct arm here rather than a decline that
   * silently costs 2.7x — or worse, a closure built for the wrong carrier. Item 475's rule is that
   * a surviving mutant on a new guard means "redundant" as readily as "untested", and the two have
   * opposite fixes; this is the redundant kind, with its semantics pinned by direct unit tests
   * rather than left to a route that does not exist.
   */
  if (inline.length === 1) {
    const [{ key: k0, value: v0 }] = inline;
    const [{ key: k1, value: v1 }] = lifted;

    return (element, env) => {
      if (!structuralEq(propOf(element, k0), v0(env))) {
        return false;
      }

      const rhs = v1(env);

      return rhs === null || rhs === undefined ? false : structuralEq(propOf(element, k1), rhs);
    };
  }

  const [{ key: k0, value: v0 }, { key: k1, value: v1 }] = lifted;

  return (element, env) => {
    const r0 = v0(env);

    if (r0 === null || r0 === undefined || !structuralEq(propOf(element, k0), r0)) {
      return false;
    }

    const r1 = v1(env);

    return r1 === null || r1 === undefined ? false : structuralEq(propOf(element, k1), r1);
  };
};

/**
 * One closure for a predicate narrow enough to pre-resolve, trying the width-1 arms before the
 * width-2 pair. The order is not load-bearing — the two are disjoint by entry count — but it keeps
 * the cheaper, five-carrier function first, and it is ONE decision per QUERY either way.
 */
export const specializeNarrowPred = (
  pred: CPredicate,
): ((element: Bound, env: EvalEnv) => boolean) | undefined =>
  specializeSingleProp(pred) ?? specializeEqPair(pred);

export const specializeSingleProp = (
  pred: CPredicate,
): ((element: Bound, env: EvalEnv) => boolean) | undefined => {
  let only: 'eqProps' | 'cmpProps' | 'nullProps' | 'memberProps' | 'props' | undefined;

  for (const [carrier, held] of Object.entries(pred)) {
    if (held === undefined) {
      continue;
    }

    // An EMPTY array carries nothing.
    if (Array.isArray(held) && held.length === 0) {
      continue;
    }

    // A populated array is fine ONLY if it is one of the two this function answers, and only if
    // it is the only one — `eqProps` AND `cmpProps` together need a loop, which is the thing being
    // removed. Everything else, including any non-array carrier such as `where`, refuses.
    if (Array.isArray(held) && SPECIALIZABLE.has(carrier) && only === undefined) {
      only = carrier as 'eqProps' | 'cmpProps' | 'nullProps' | 'memberProps' | 'props';

      continue;
    }

    return undefined;
  }

  if (only === 'cmpProps') {
    const carried = pred.cmpProps;

    if (carried?.length !== 1) {
      return undefined;
    }

    const [{ key, op, value }] = carried;

    // ORDERING ops only: an equality is routed to `compareTruth` instead.
    //
    // ⚠️ AND `cmpProps` DOES CARRY EQUALITIES, which is the opposite of what this comment first
    // claimed. `satisfies`'s own loop describes `cmpProps` as "the ORDERING comparisons `eqProps`
    // cannot carry", so I wrote this off as belt-and-braces — then made the branch THROW and ran
    // the suite: SEVEN tests fired. The refusal is reached, not defensive.
    //
    // Dropping it nonetheless SURVIVES mutation, because for a NUMBER PAIR `COMPARE['=']` and
    // `structuralEq` agree, so the two routes coincide on every input the suite has. They are not
    // proven to agree in general — NaN and ±0 are where equality notions part company — so the
    // refusal stays and the question stays unasked. One comparison per QUERY buys that.
    if (op === '=' || op === '<>') {
      return undefined;
    }

    const cmp = COMPARE[op];

    /**
     * ITEM 1339: the numeric pair is answered by `cmp` DIRECTLY, skipping the `compareTruth` CALL.
     *
     * ⚠️ READ `compareTruth`'s HEADER BEFORE TOUCHING THIS — it refutes a NEIGHBOURING lever and
     * the difference is the whole point. That header records adding
     * `if (op !== '=' && … typeof lv === 'number' …) return fn(lv, rv)` INSIDE `compareTruth`: "It
     * was written and measured and it moved NOTHING", across five shapes, twice over. This is not
     * that change. That one short-circuits WITHIN the function and still pays the call; this one
     * removes the call at the site. Measured in the specialized closure, 200,000 vertices:
     *
     *     through `compareTruth`     median 2.95 ms
     *     `cmp` called directly      median 2.09      1.41x
     *     `propOf` replaced instead  median 3.01      0.98x — REFUTED
     *
     * SEMANTICS ARE TAKEN FROM THAT HEADER, NOT RE-DERIVED: it states the numeric arm is
     * "byte-identical, NaN included", and `cmp` here IS the `COMPARE[op]` that header passes.
     */
    return (element, env) => {
      const lhs = propOf(element, key);
      const rhs = value(env);

      return typeof lhs === 'number' && typeof rhs === 'number'
        ? (cmp as (a: number, b: number) => boolean)(lhs, rhs)
        : compareTruth(op, cmp, lhs, rhs) === true;
    };
  }

  if (only === 'memberProps') {
    const members = pred.memberProps;

    if (members?.length !== 1) {
      return undefined;
    }

    const [{ key, test, negated }] = members;

    /**
     * ITEM 1350: the MEMBERSHIP carrier, the last of the four `satisfies` arms worth specializing.
     *
     * Item 1348 isolated it against the right floor — same column, same selectivity, ONE element,
     * differing only in which carrier it lifts into: `n.age = 1` (`eqProps`, specialized at 1340)
     * **2.4889 ms** against `n.age IN [1]` (`memberProps`) **3.9441**, ranges disjoint. A
     * one-element list is the fair pairing because item 1268 refuted linearity in k — a TS `IN`
     * count is flat in list length.
     *
     * SEMANTICS ARE BOUND, NOT RE-DERIVED. `satisfies`'s own loop is
     * `(negated ? not3(r) : r) !== true -> false`, so passing is `(negated ? not3(r) : r) === true`
     * over the same `test` and the same `propOf`. `not3` of UNKNOWN is UNKNOWN, so a `NOT IN` over
     * an absent or null cell still drops the row — item 1288's composition, reused rather than
     * rewritten.
     *
     * ⚠️ `negated` IS DECIDED HERE, NOT PER ELEMENT — item 1339's "answer it at the call site"
     * applied to a branch instead of a comparison. Two closures, each with the test it needs.
     */
    return negated
      ? (element, env) => not3(test(propOf(element, key), env)) === true
      : (element, env) => test(propOf(element, key), env) === true;
  }

  if (only === 'nullProps') {
    const nulls = pred.nullProps;

    if (nulls?.length !== 1) {
      return undefined;
    }

    const [{ key, negated }] = nulls;

    /**
     * ITEM 1347: the NULL carrier, the same lever one carrier further along.
     *
     * Item 1346 re-priced item 1260's `IS NOT NULL` against Gremlin's `has(k)` and found the cause
     * by CONTROL rather than inference: on one instrument at 200,000 vertices, the carrier items
     * 1338-1340 specialized measures 1.06x its Gremlin twin (parity) and this one measures
     * **1.57x** (GQL 3.5265 against 2.2393, ranges disjoint). A presence test rides `nullProps`,
     * which `SPECIALIZABLE` refused, so it still paid the whole `satisfies` dispatch per element.
     *
     * SEMANTICS ARE BOUND, NOT RE-DERIVED — the same rule as the two arms above. `satisfies`'s own
     * `nullProps` loop is `if (isNullish(propOf(element, key)) === negated) return false`, so
     * passing is exactly `isNullish(...) !== negated`, with `negated` true for `IS NOT NULL`. This
     * calls the same `isNullish` and the same `propOf`.
     *
     * ⚠️ NO `env`. Unlike the ordering and equality arms there is no right-hand side to evaluate,
     * so this closure reads the element alone — which is most of why it is cheaper.
     *
     * ⚠️ THE ORDERING QUESTION DOES NOT ARISE HERE, and that is worth stating because the arm this
     * binds sits inside a careful ordering argument. `satisfies` runs `nullProps` late precisely
     * because it CANNOT RAISE, and the file records a live TS-vs-native divergence that turns on
     * that placement (`WHERE n.s AND n.z IS NOT NULL`, item 1270). It cannot be reached from here:
     * the single-carrier guard above admits this branch only when `nullProps` is the ONLY populated
     * carrier, so there is no sibling conjunct whose raise could be suppressed or exposed.
     */
    return (element) => isNullish(propOf(element, key)) !== negated;
  }

  if (only === 'props') {
    const inline = pred.props;

    if (inline.length !== 1) {
      return undefined;
    }

    const [{ key, value }] = inline;

    /**
     * ITEM 1598: the INLINE carrier — `(u:User {team: $v})`, the ISO equality spelling.
     *
     * Item 1597's probe found a stable **1.76x EQUIVALENT-SPELLING GAP** between the two spellings
     * of one seeded count, which is the defect class this engine is named after:
     *
     * ```text
     *    MATCH (u:User) WHERE u.team = $v RETURN count(*)    11097  11639  12157 ns
     *    MATCH (u:User {team: $v})        RETURN count(*)    19544  20254  21954
     * ```
     *
     * Both take `countShortcut` and both seek. The difference was entirely here: a clause `WHERE`
     * lifts into `eqProps` and gets item 1340's pre-resolved closure, while the inline form lands
     * in `props`, which `SPECIALIZABLE` refused — so the general `satisfies` dispatch ran per
     * candidate for one spelling and not the other.
     *
     * ⚠️ THIS IS A SEPARATE ARM ON PURPOSE, and merging it into the `eqProps` closure below would
     * be a WRONG ANSWER rather than a slow one. The two carriers implement DIFFERENT readings of
     * equality, and `satisfies`'s own `eqProps` comment is the matrix:
     *
     * ```text
     *    {k: null}         matches a stored null AND an absent key     <- this arm
     *    WHERE n.k = null  matches NEITHER                             <- the arm below
     * ```
     *
     * `propOf` returns `null` for both an absent key and a stored null, so `structuralEq` ALONE
     * gives the inline reading — which is why this arm has NO null rejection and the one below
     * must keep its. Item 260 settled that `{k: null}` means IS NULL; memory's
     * `inline-props-null-is-is-null` records it. Admitting `props` into the arm below instead of
     * giving it its own would have changed answers on exactly that case, which is why item 1597
     * recorded the gap rather than closing it in its last minutes.
     *
     * SEMANTICS ARE BOUND, NOT RE-DERIVED, as in the four arms above: `satisfies`'s `props` loop is
     * `if (!structuralEq(propOf(element, key), value(env))) return false`, so passing is exactly
     * `structuralEq(propOf(element, key), value(env))` over the same two functions. `structuralEq`
     * is CALLED rather than replaced by JS `===`, and here that is not defence in depth: unlike
     * `eqProps`, a LIST value does reach this carrier — `(n {tags: [1, 2]})` is an inline literal —
     * and `satisfies`'s own comment records the bug where JS `!==` made such a constraint never
     * match. `inline-props-specialized.test.ts` pins it through this arm.
     */
    return (element, env) => structuralEq(propOf(element, key), value(env));
  }

  const carried = pred.eqProps;

  if (carried?.length !== 1) {
    return undefined;
  }

  const [{ key, value }] = carried;

  /**
   * ITEM 1340: the EQUALITY arm, the same lever one carrier along. `eqProps` is what
   * `WHERE n.tag = 't3'` lifts into, so items 1338/1339's specializer refused it and the full
   * dispatch was still paid per element. Measured unindexed at 200,000 vertices, GQL ~4.45 ms
   * against Gremlin's ~3.46 — 1.29x.
   *
   * THE NULL REJECTION IS REPLICATED EXACTLY, and it is not incidental: `propOf` returns `null`
   * for an absent key AND for a stored null, so `structuralEq` alone cannot tell them apart and
   * gives the INLINE reading (`{k: null}` matches both). Rejecting a null right-hand side gives
   * the EXPRESSION reading instead, which is what `satisfies`'s own `eqProps` loop does and what
   * lets a `$param` be lifted at all — item 210's "route two". Dropping it would make
   * `WHERE n.k = $p` with a null param match stored nulls, which `=` must not.
   *
   * `structuralEq` is CALLED, not re-implemented, so a list-valued equality still matches a stored
   * list exactly as the clause spelling does (the bug item 210 records: JS `!==` made an inline
   * list constraint never match).
   *
   * ⚠️ THE ARM'S INPUT CONTRACT IS MEASURED, NOT ASSUMED, and it explains two surviving mutants.
   * Making this closure THROW on an `undefined` right-hand side, and again on a non-scalar one,
   * left all 3,477 tests green — so only SCALARS arrive here, never `undefined` and never a list
   * or map. Hence:
   *
   *   - `undefined`-rejection: unreachable today. Kept because nothing ENFORCES that contract; the
   *     check is one comparison and an unbound param arriving here would otherwise compare
   *     structurally against a property.
   *   - `structuralEq` versus JS `===`: indistinguishable today, because the two agree on every
   *     scalar (NaN false both ways, ±0 true both ways). `structuralEq` stays because it is the
   *     function `satisfies` uses, so the day a list DOES lift into `eqProps` this arm is already
   *     right rather than silently wrong.
   *
   * Both are defence in depth over a contract this file cannot see enforced — which is a different
   * thing from dead code, and the distinction is why neither was deleted.
   */
  return (element, env) => {
    const rhs = value(env);

    if (rhs === null || rhs === undefined) {
      return false;
    }

    return structuralEq(propOf(element, key), rhs);
  };
};

import { matchNode } from './bindings.js';

// --- clause compilation ------------------------------------------------------

/** Every variable a pattern introduces (for OPTIONAL MATCH null-binding). */
export const patternVars = (patterns: readonly PathPattern[]): string[] => {
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
export const checkLinearScope = (
  clauses: readonly Clause[],
  initial: ReadonlySet<string>,
): void => {
  const scope = new Set(initial);

  for (const clause of clauses) {
    switch (clause.kind) {
      case 'match': {
        // NO SCOPE COPY (item 909). This used to build `withPat = new Set(scope)`, add the
        // pattern's variables to the COPY, check the clause `WHERE` against it, and then iterate
        // the WHOLE copy back into `scope` — so a MATCH clause cost one `Set` allocation plus a
        // full iteration of the entire visible scope, every compile.
        //
        // The copy bought nothing. `scope` ends up as `scope ∪ patternVars` either way (that is
        // what the copy-back did), and the `WHERE` has to see exactly that set — so adding the
        // pattern's variables to `scope` directly and checking against `scope` is the same two
        // facts with neither the allocation nor the second pass.
        //
        // The one behavioural difference is unobservable: if `checkExprScope` THROWS, the old
        // code left `scope` without the pattern's variables and this leaves them in. A throw here
        // aborts the whole compile, so nothing reads `scope` afterwards.
        for (const v of patternVars(clause.patterns)) {
          scope.add(v);
        }

        if (clause.where) {
          checkExprScope(clause.where, scope);
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
export type CMergeUpdate =
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
// The native engine reaches the same outcome through the GRAMMAR instead of a named
// check: `gql::Parser::insert_node_expr` accepts only `:A` and `:A&B` after an INSERT
// template, so `A|B` / `!A` / `%` never parse there. (A typeless edge's empty `[]` is caught
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

export const compileInsertPath = (pattern: PathPattern): CInsertPath => ({
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

export const compileSetItem = (item: SetItem): CSetItem =>
  'label' in item
    ? { variable: item.variable, label: item.label }
    : { variable: item.variable, key: item.key, value: compileExpr(item.value) };

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
  // One walk per conjunct rather than two (item 919). THIS partition has teeth where
  // `pushWhereIntoNode`'s does not: swapping these two destinations fails 7 tests, because a
  // faulting subquery then evaluates for a vertex the cheap conjunct should have rejected.
  // `subquery-conjunct-split.test.ts` is the file that catches it.
  const cheap: Expr[] = [];
  const costly: Expr[] = [];

  for (const c of conjuncts) {
    (hasSubquery(c) ? costly : cheap).push(c);
  }

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
export const filterPredicate = (where: Expr): CompiledExpr => {
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

export const seedPrefilter = (
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
  // `Row[] | undefined` — the one rung that may decline at RUNTIME, because an endpoint label's
  // vacuity is a property of the graph and not of the query (item 1399).
  varLengthCount: ((graph: Graph, params: Params) => Row[] | undefined) | null;
  /** Precomputed grouped-count closure for `MATCH (n) RETURN n.k, count(*)`; else null. */
  groupCountShortcut: ReachFn | null;
  /** The same over a HOP — `MATCH (a)-[:T]->(b) RETURN b.k, count(*)`; else null. */
  groupHopShortcut: ReachFn | null;
  /** BFS closure for unbounded var-length + DISTINCT; else null. */
  reachShortcut: ReachFn | null;
  /** Fused `MATCH (a)-[:T]->(x) RETURN <exprs over x>` row builder; else null. */
  hopProjection: RowsFn | null;
  /** A two-segment pattern projecting rows (item 1619) — `detectHop2Projection`. */
  hop2Projection: AlwaysRowsFn | null;
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
  /**
   * Does this linear query mutate the graph? Carried by CONSTRUCTION — item 1510.
   *
   * `runLinear` reads it to decide whether to wrap the run in `graph.transaction`. It used to
   * compute it per call as `clauses.some((c) => WRITE_CLAUSES.has(c.kind))`, which allocates a
   * closure and does a `Set` lookup per clause to answer a question the compiled query already
   * settles — 14.7% of an 82 ns `RETURN 1 AS v`. Same move as `Plan.readsPath`/`mayFault` on the
   * Gremlin side (items 1504, 1507).
   *
   * ⚠️ TOP-LEVEL CLAUSES ONLY, which is the right rule HERE and the opposite of `mayFault`'s. A
   * nested write — a subquery or a `CALL` body that inserts — is a `CLinear` of its own, and
   * `runLinear` is what runs it, so it wraps its own transaction when it executes. Propagating
   * inward would be wrong twice over: it would claim a read-only outer query writes, and
   * `graph.transaction` nests.
   */
  writes: boolean;
};
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
export const boundExprs = (c: Clause): Map<string, Expr> | null => {
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

/** Every variable a pattern BINDS: its nodes, its rels, and the path itself. */
export const patternNames = (p: PathPattern): Set<string> => {
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
export const repeatsNodeVariable = (clauses: readonly Clause[]): boolean => {
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
export const faultFreeSortKey = (expr: Expr): boolean =>
  expr.kind === 'var' || expr.kind === 'prop';

/**
 * `RETURN` delivers exactly ONE row and that row cannot depend on the incoming order.
 *
 * Every item must CARRY an aggregate, because an item without one is an implicit GROUP BY key —
 * which both makes the result many rows and makes a sort position observable. An explicit
 * `GROUP BY` is refused for the same reason. This is the same one-row argument items 544-546
 * made about `DISTINCT` and `ORDER BY` on the projection, asked here of the clause in FRONT of it.
 */
export const oneOrderFreeRow = (ret: Extract<Clause, { kind: 'return' }>): boolean => {
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
/**
 * A `{1,1}` quantifier asks exactly what a plain hop asks, so drop it (item 684).
 *
 * `{1,1}` is ONE repetition. But the quantifier carries the segment past every gate that bails
 * on `segments.some((s) => s.rel.quantifier)`, so the plain spelling takes the O(1)
 * `edgesByLabel` bucket size while `{1,1}` enumerates — **1.600us against 3580.920 at 50,000
 * vertices / 50,000 E edges, a 2238x spread for an identical answer** (item 683). That is the
 * equivalent-spelling class, which no correctness test can catch because both answers are right.
 *
 * The same normalization lives in the native engine's OPTIMIZER (`opt.rs`: a one-hop `VarLength`
 * with no `until`/`body_filter` under WALK/TRAIL becomes an `Expand`), which is why the two
 * spellings sit within 3.3% there. This is the TS half; there is no `ir::Plan` to canonicalize,
 * so it has to happen on the AST.
 *
 * EVERY GATE IS A WAY THE TWO SPELLINGS COME APART, and the first two were measured, not assumed:
 *
 * - **An edge variable.** Under a quantifier it binds a LIST (`e: [{…}]`); without one it binds a
 *   SCALAR (`e: {…}`). Dropping the quantifier would change the result's TYPE.
 * - **`simple` / `acyclic` mode.** `acyclic` forbids any repeated NODE, so at one hop it drops a
 *   self-loop `A -> A` that a plain hop keeps. (lenke defaults to `trail`, which at one hop
 *   forbids nothing — one hop uses one edge — so the common case is inside the safe set.)
 * - **A non-`walk` selector.** `ANY`/`ANY SHORTEST` pick among paths; a plain hop has no paths to
 *   pick among.
 * - **A group or nested subpath** (`hopFrom`/`hopTo`/`unitRest`/`innerQ`/`nested`) — a different
 *   shape, whose inner variables are group vars exposed as LISTS.
 * - **A `subpathWhere`** — a PER-REPETITION predicate, which is not a per-edge filter. This one
 *   is REDUNDANT and mutation says so: removing it changes no answer, because `subpathWhere`
 *   exists only on a parenthesized subpath, which the group gate above has already declined. Kept
 *   as defence in depth against a future shape that carries one without being a group.
 *
 * Runs with a no-allocation pre-scan because this chain is on the EXECUTE path, not behind the
 * parse cache: a query with no quantifier at all must not pay for the rewrite.
 */
const vacuousQuantifier = (pattern: PathPattern, seg: Segment): boolean => {
  const q = seg.rel.quantifier;

  return (
    q?.min === 1 &&
    q?.max === 1 &&
    seg.rel.variable === undefined &&
    (pattern.mode === undefined || pattern.mode === 'walk' || pattern.mode === 'trail') &&
    (pattern.selector === undefined || pattern.selector === 'walk') &&
    seg.hopFrom === undefined &&
    seg.hopTo === undefined &&
    (seg.unitRest === undefined || seg.unitRest.length === 0) &&
    seg.innerQ === undefined &&
    seg.nested === undefined &&
    seg.subpathWhere === undefined
  );
};

export const dropVacuousQuantifier = (clauses: readonly Clause[]): readonly Clause[] => {
  let found = false;

  for (const clause of clauses) {
    if (clause?.kind !== 'match') {
      continue;
    }

    for (const pattern of clause.patterns) {
      if (pattern.segments.some((seg) => vacuousQuantifier(pattern, seg))) {
        found = true;
        break;
      }
    }

    if (found) {
      break;
    }
  }

  if (!found) {
    return clauses;
  }

  return clauses.map((clause) => {
    if (clause?.kind !== 'match') {
      return clause;
    }

    return {
      ...clause,
      patterns: clause.patterns.map((pattern) => {
        if (!pattern.segments.some((seg) => vacuousQuantifier(pattern, seg))) {
          return pattern;
        }

        return {
          ...pattern,
          segments: pattern.segments.map((seg) => {
            if (!vacuousQuantifier(pattern, seg)) {
              return seg;
            }

            const { quantifier: _dropped, ...rel } = seg.rel;

            return { ...seg, rel };
          }),
        };
      }),
    };
  });
};

/**
 * A node position this clause's `WHERE` may fold a label test INTO: the variable appears at
 * exactly one node position in the clause and nowhere else.
 *
 * `count > 1` is kept as its own state rather than dropped on sight, because a second sighting has
 * to POISON the first — a `Map` that only ever records the first occurrence would happily fold
 * `MATCH (n)-[:T]->(n) WHERE n IS LABELED L` into one of the two `n`s and leave the other
 * unconstrained. That is answer-equivalent HERE (the same element is tested either way, and the
 * pattern re-checks both positions against the same binding), but it is equivalent by an argument
 * about the walk rather than by construction, and the next reader should not have to re-derive it.
 */
type FoldSite = { node: NodePattern; count: number; poisoned: boolean };

/**
 * Can this PATTERN's node positions take a folded label at all?
 *
 * A pattern label is not only a filter — it participates in MATCHING — so the two spellings part
 * company wherever something downstream chooses among the paths the pattern admits:
 *
 *   - **A path SELECTOR.** `ANY SHORTEST (a)-[:T]->*(b) WHERE b IS LABELED L` picks the shortest
 *     path satisfying the PATTERN and only then filters. Fold `L` inward and the selector chooses
 *     among a different set of paths, which is a WRONG ANSWER, not a slower one.
 *
 *     ⚠️ THIS CONDITION IS CURRENTLY UNREACHABLE AND IS KEPT ANYWAY — measured, not assumed: the
 *     mutant that deletes it SURVIVES the whole gql suite. The reason is that this engine accepts
 *     a selector only with a single VARIABLE-LENGTH segment (`ANY SHORTEST (a)-[:T]->(m)-[:T]->(b)`
 *     is a syntax error, "currently support a single variable-length segment"), so a non-`walk`
 *     selector always implies a quantifier and the condition below declines it first.
 *
 *     It stays because the thing making it unreachable is a PARSER limitation the error message
 *     itself calls temporary, and the unsoundness it guards is not the endpoint case: for a filter
 *     on an INTERMEDIATE node of a fixed-length selector pattern, the selector keeps one path per
 *     endpoint PAIR, so filtering before the selector can keep a pair that filtering after would
 *     drop. Same shape as `mergeFarPreds`' `truthProps` — a correctness precondition held live for
 *     when the surface grows into it.
 *   - **A QUANTIFIER anywhere in the pattern.** A node inside a repetition binds a GROUP variable
 *     (a list), so `IS LABELED` on it is a test on the list's elements after the walk, where a
 *     pattern label is a per-repetition constraint that prunes the walk. Different questions.
 * The path MODE is deliberately NOT a condition, and the distinction is the whole reason a selector
 * is one. A mode (`trail`, `acyclic`, …) is a FILTER on walks: it removes the walks that repeat an
 * element. A label is also a filter on walks. Filters COMMUTE, so applying the label inside the
 * pattern or outside it leaves the same surviving set. A SELECTOR does not commute, because it
 * picks an EXTREMUM of the surviving set and so depends on what survived. Requiring
 * `mode === undefined` would also decline everything in practice: the parser defaults `mode` to
 * `'trail'` and `selector` to `'walk'`, never leaving either unset — which is exactly how the first
 * cut of this pass silently folded nothing at all, with the empty fold looking like a measurement
 * that said the lever was not there.
 *
 * Each condition is declined for the whole pattern rather than per position: a quantifier three
 * segments away still decides which walks reach this node, so a position-local test would be the
 * wrong unit.
 */
const patternTakesFold = (pattern: PathPattern): boolean =>
  (pattern.selector === undefined || pattern.selector === 'walk') &&
  pattern.segments.every(
    (seg) =>
      seg.rel.quantifier === undefined &&
      seg.innerQ === undefined &&
      seg.nested === undefined &&
      (seg.unitRest === undefined || seg.unitRest.length === 0) &&
      seg.subpathWhere === undefined,
  );

/** Record one node position, poisoning the site if the variable has been seen before. */
const noteNodeSite = (sites: Map<string, FoldSite>, node: NodePattern): void => {
  const name = node.variable;

  if (name === undefined) {
    return;
  }

  const seen = sites.get(name);

  if (seen === undefined) {
    sites.set(name, { node, count: 1, poisoned: false });

    return;
  }

  seen.count += 1;
  seen.poisoned = true;
};

/**
 * The foldable node positions of one `MATCH` clause, keyed by variable.
 *
 * A variable used at a RELATIONSHIP position poisons it outright. An edge's pattern label is its
 * TYPE and `IS LABELED` on an edge asks about its label set, and while those coincide today, a
 * fold that quietly assumes it would be the kind of surface-specific guess CLAUDE.md asks not to
 * reason from. The node case is the measured one; the edge case can be its own item with its own
 * ground truth.
 */
export const foldSitesOf = (clause: MatchClause): Map<string, FoldSite> => {
  const sites = new Map<string, FoldSite>();

  for (const pattern of clause.patterns) {
    if (!patternTakesFold(pattern)) {
      continue;
    }

    noteNodeSite(sites, pattern.start);

    for (const seg of pattern.segments) {
      noteNodeSite(sites, seg.node);

      if (seg.rel.variable !== undefined) {
        sites.set(seg.rel.variable, {
          node: seg.node,
          count: 2,
          poisoned: true,
        });
      }
    }
  }

  return sites;
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
export const plainGroupNode = (n: NodePattern | undefined): boolean =>
  n === undefined ||
  (n.label === undefined && (n.properties?.length ?? 0) === 0 && n.where === undefined);

import { edgesOfTypes, outNeighbors, relTypeNames } from './adjacency.js';
import { consistent, hasPredicate } from './bindings.js';
import { matchClauseBindings } from './clauses.js';
import {
  SUBQUERY_EXPRS,
  asIdCompare,
  asMembershipNode,
  asNegatedCompare,
  asPathCompare,
  asPropCompare,
  cheapPureExpr,
  closedList,
  closedListValues,
  conjunctMix,
  flattenAnd,
  flattenConjuncts,
  freePredicateVars,
  hasSubquery,
  idArgVariable,
  isConstExpr,
  isKnownScalarFn,
  liftLabelTest,
  liftNullTest,
  liftTruthTest,
  liftTypedTest,
  membershipFromEqChain,
  patternBoundVars,
  truthCannotRaise,
  uniformEqChain,
  uniformIdEqChain,
} from './expr-analysis.js';
import type { AlwaysRowsFn, RowsFn } from './hop-projection.js';
// Imported at FUNCTION level like the other detectors — this module and `executor` import
// each other, which the existing comment on the shortcuts import explains is safe.
// Count / reachability fast-paths (see executor/shortcuts.ts) — this back-edge and
// the shortcuts' import of the trunk's bucket primitives form a safe function-level
// cycle, matching the other executor submodules.
import {
  plainNode,
  plainRel,
  side,
  sideOfVertex,
  sideOfVertexGated,
  threeHopSide,
  twoHopSide,
} from './hop-sides.js';
import type { ThreeHopSide, TwoHopSide } from './hop-sides.js';
import { compareTruth, valueIsTypedTy } from './predicates.js';
import { COUNT_FOLD, FOLDED, extremumFold, foldFor } from './projection.js';
import { columnName, valueKey } from './rows.js';
import type { ReachFn } from './shortcuts.js';
import { propOf } from './values.js';
import { isEdge, isElement, isVertex } from './values.js';
