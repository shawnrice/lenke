/**
 * AST ANALYSIS: reading a parsed GQL expression without compiling it.
 *
 * Everything here answers a question ABOUT an `Expr` — which names it reads free, whether it can
 * raise, whether it is a constant, whether a comparison is really an id test or a membership test —
 * and nothing here produces a `CompiledExpr`. That line is what makes it a module: it is the one
 * part of the executor that depends on nothing else in it.
 *
 * ⚠️ IT IS THE FIRST TRUE LEAF, AND THAT WAS MEASURED BEFORE IT WAS MOVED (item 1666). 39 symbols
 * importing **zero values** from `core.ts` — only four types, and a type import is erased, so it
 * adds no runtime edge and `import/no-cycle` correctly ignores it. Everything else in `executor/`
 * can import this file; it imports none of them.
 *
 * ⚠️ WHY A LEAF HAD TO COME FIRST. The obvious next extraction was the expression COMPILER — 25
 * mutually-recursive symbols, 2,105 lines, a genuine strongly-connected component. It is closed in
 * the symbol graph, but `core.ts` reads four of its members (`compileExpr`, `compileProps`,
 * `filterPredicate`, `gatePredicate`), so pulling it out first would have made it import 52 values
 * up from `core.ts` while `core.ts` imported four back — a module cycle, where the same code in the
 * other order has none. Extracting bottom-up cannot create one at any step, and this is the bottom.
 *
 * The compiler can follow once enough of its 52 dependencies live here and in its sibling leaves.
 *
 * ⚠️ `cannotFault` / `truthCannotRaise` / `valueCannotRaise` ARE A TRIO AND BELONG TOGETHER. They
 * decide whether a conjunct is safe to evaluate ahead of a faulting one, which is what licenses
 * reordering a `WHERE` at all (items 259, 1662's `cheapPureExpr` gate). Splitting them across
 * modules would let one be strengthened without the others.
 */

import { DEFAULT_CONFIG } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { CompareOp, Expr, LabelExpr, NodePattern, PathPattern, TypeTest } from '../ast.js';
import type { CLabelTest, CNullProp, CTruthTestProp, CTypedTestProp } from './core.js';
import { callScalar } from './scalars.js';

export const closedListValues = (e: Expr): readonly unknown[] | null => {
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
export const membershipFromEqChain = (e: Expr): Expr | null => {
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

// Compile-time side channel: the names of unknown/unimplemented functions a
// *query* references, gathered while `compile` walks the tree so it can throw
// `UnknownFunction` eagerly (before running, and independent of row count /
// branch reachability). Set only for the duration of one query `compile`; left
// null while a validator predicate compiles, so a validator's unknown fn keeps
// its per-row fault (parity with `exec::evaluator::eval`, the per-row path).
//
// The native engine has NO equivalent of this collector: `gql::Parser::call` rejects an
// unknown name at PARSE time (`E_UNKNOWN_FUNCTION: unknown function \`{name}\``), which is
// earlier still, so both engines fault before any row either way. The old citation named a
// plan-level `unknown_fns` set checked in a `run_cquery_body`; neither exists (xref:gone).

// Compile-time side channel: the names of `$param`s used as a `LIMIT` / `OFFSET`
// bound. Their bound value must be a non-negative integer, so it is validated
// up-front in the plan closure (mirrors `gql::Parser::usize_lit`, which rejects a
// `$param` bound that is not a non-negative integer as it reads it),
// making a bad bound fault before any row is produced — identically over zero
// rows or many. The name is also added to `paramCollector` so a missing bound
// param surfaces the usual `MissingParameter` error.
// A shared empty probe arg list — `callScalar` treats absent args as null, so a
// KNOWN scalar function resolves to null (never throwing `UnknownFunction`);
// only a genuinely unknown name reaches the `UnknownFunction` throw.
export const FN_PROBE_ARGS: readonly unknown[] = [];
/**
 * Compile-time name resolution for a scalar function. Probes the shared scalar
 * dispatch with placeholder args: the ONLY source of `ErrorCode.UnknownFunction`
 * is an unresolved name (every known function returns — or throws some *other*
 * error — on null args), so a thrown `UnknownFunction` means the name is bogus.
 * Any other throw means the name DID resolve (its real per-row error, e.g. bad
 * arity, still stands). Reachability-independent by construction — the name is
 * resolved whether or not the call ever executes.
 */
export const isKnownScalarFn = (name: string): boolean => {
  try {
    callScalar(name, FN_PROBE_ARGS, DEFAULT_CONFIG.limits);

    return true;
  } catch (error) {
    return !(error instanceof LenkeError && error.code === ErrorCode.UnknownFunction);
  }
};
/** Collect the variables a sub-pattern introduces (start node, each hop's rel + node). */
export const patternBoundVars = (p: PathPattern, into: Set<string>): void => {
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
 * must not be flagged.
 *
 * The native engine rejects the same predicates by a DIFFERENT mechanism — it parses a
 * validator predicate in a scope holding only the bound variable, so a free name is an
 * `unknown variable \`q\`` parse error rather than a walk over a free-variable set. Measured
 * at item 614: both engines accept `p.age > 0` and reject `q.age > 0` and
 * `p.age > 0 AND q.age > 0`, with different message text. (xref:gone: `free_predicate_vars`,
 * `plan.rs` xref:gone.)
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
/**
 * A conjunct as a membership node, or `null` — `in` as itself, an `=`-OR-chain folded (item 1269).
 *
 * `membershipFromEqChain` is applied HERE rather than read off the AST for the reason its own note
 * gives: it runs inside `compileExpr`'s `case 'or'` so that every ANALYSIS pass still sees the
 * original `or` and `collectHints`' seeding keeps firing. `directEqProps` is one of those passes,
 * so it has to fold for itself — and folding a local copy changes nothing for the others.
 */
export const asMembershipNode = (e: Expr): Expr | null => {
  if (e.kind === 'in') {
    return e;
  }

  /**
   * ITEM 1352: `NOT (n.k IN [..])` with the flag FLIPPED, the third sibling of this shape.
   * `asNullTest` has done it for `NOT (… IS NULL)` since item 1270 and `asLabelTest` for labels;
   * this recogniser did not, so the `NOT (…)` spelling was neither an `in` nor an `or` and
   * declined the whole chain to the generic evaluator while `NOT IN` lifted.
   *
   * ⚠️ FOUND BY `bun run spelling`, NOT BY A TEST, and it had the defect class's signature: both
   * spellings answered identically, so nothing in 4,662 tests could see it. Three isolated
   * confirmation runs read `n.k NOT IN [1,2]` at 3.01/3.08/2.91 ms against
   * `NOT (n.k IN [1,2])` at 8.62/8.58/6.51.
   *
   * ⚠️ AND ITEM 1350 WIDENED IT. The gap pre-dates that item (item 1288 created it by lifting
   * `NOT IN`), which measured ~1.9x; specializing `memberProps` took the lifted spelling to ~3.0 ms
   * and the gap to ~2.8x. Making one spelling faster widened the spread — which is why the fix is
   * to lift the OTHER spelling rather than to unwind anything.
   *
   * THE FLIP IS EXACT, by the same argument `asNullTest`'s note makes for its own case and item
   * 1288's `negated` field makes for this carrier: membership is `not3` of the test, and `not3` of
   * UNKNOWN is UNKNOWN, so a filter drops the row under both spellings. The NaN hazard that makes
   * `NOT (x >= 2)` unequal to `x < 2` cannot arise, because there is no ordering comparison here.
   *
   * Recursing rather than matching `e.expr.kind === 'in'` directly also takes
   * `NOT (n.k = 1 OR n.k = 2)` through `membershipFromEqChain`, the `=`-OR-chain spelling of the
   * same question — one of the four canonical seeding bugs CLAUDE.md names.
   */
  if (e.kind === 'not') {
    const inner = asMembershipNode(e.expr);

    return inner?.kind === 'in' ? { ...inner, negated: !inner.negated } : null;
  }

  return e.kind === 'or' ? membershipFromEqChain(e) : null;
};
/**
 * A conjunct as a null test, or `null` — `isNull` as itself, `NOT (… IS NULL)` with the flag
 * FLIPPED (item 1270).
 *
 * The flip is exact, and that is worth stating because the sibling rewrite on ordering comparisons
 * is NOT: a null test is two-valued — `null IS NULL` is TRUE, never UNKNOWN — so `NOT` of it is its
 * exact complement. The NaN hazard that makes `NOT (x >= 2)` unequal to `x < 2` cannot arise here,
 * because there is no comparison to be unordered. (`opt::normalize_pred` canonicalizes the same
 * pair in the Rust engine for the same reason — item 1262.)
 */
export const asNullTest = (e: Expr): { expr: Expr; negated: boolean } | null => {
  if (e.kind === 'isNull') {
    return { expr: e.expr, negated: e.negated };
  }

  if (e.kind === 'not' && e.expr.kind === 'isNull') {
    return { expr: e.expr.expr, negated: !e.expr.negated };
  }

  return null;
};
/**
 * `NOT (<prop> = <v>)` / `NOT (<prop> <> <v>)` as the equivalent compare with the operator flipped,
 * or `null` for anything else (item 1272).
 *
 * ONLY `=` and `<>` are in the table, and that is a correctness boundary rather than laziness: an
 * ordering operator has a NaN hole. `NOT (x >= 2)` is TRUE for a NaN `x` (every ordering comparison
 * against NaN is FALSE here, so its negation is TRUE) where `x < 2` is FALSE. Equality has no such
 * hole — it is FALSE for NaN and its negation is TRUE, which is what `<>` answers too.
 */
export const NEGATED_COMPARE: Partial<Record<CompareOp, CompareOp>> = { '=': '<>', '<>': '=' };
export const asNegatedCompare = (
  e: Expr,
): { kind: 'compare'; op: CompareOp; left: Expr; right: Expr } | null => {
  if (e.kind !== 'not' || e.expr.kind !== 'compare') {
    return null;
  }

  const flipped = NEGATED_COMPARE[e.expr.op];

  return flipped === undefined ? null : { ...e.expr, op: flipped };
};
/**
 * Flatten an `and` tree into its conjuncts, depth-first and left to right (item 1271).
 *
 * `a AND b AND c` already arrives as one flat `items` list; this exists for the PARENTHESISED
 * spellings, which arrive nested and which `directEqProps` used to decline outright.
 */
export const flattenAnd = (e: Expr, out: Expr[]): void => {
  if (e.kind === 'and') {
    for (const item of e.items) {
      flattenAnd(item, out);
    }

    return;
  }

  out.push(e);
};
/**
 * `<ownVar>.<key> IS [NOT] TRUE|FALSE|UNKNOWN` as a liftable conjunct, or null (item 1286).
 *
 * `NOT (x IS TRUE)` is folded by FLIPPING `negated`, the same way `asNullTest` folds
 * `NOT (… IS NULL)` — the native engine needed two passes for its two null spellings (items 1261
 * then 1262) because the second was not noticed until the first shipped, and the cheap way not to
 * repeat that is to handle both the moment the arm is written.
 */
export const asTruthTest = (
  e: Expr,
): { expr: Expr; truth: boolean | null; negated: boolean } | null => {
  if (e.kind === 'isTruth') {
    return { expr: e.expr, truth: e.truth, negated: e.negated };
  }

  if (e.kind === 'not' && e.expr.kind === 'isTruth') {
    const inner = e.expr;

    return { expr: inner.expr, truth: inner.truth, negated: !inner.negated };
  }

  return null;
};
/**
 * File one lifted `IS [NOT] TRUE|FALSE|UNKNOWN` conjunct into the list its ORDERING requires.
 *
 * ⚠️ `IS UNKNOWN` GOES INTO `nulls`, NOT INTO `truthTests`, and the split is measured rather than
 * reasoned. `case 'isTruth'` routes `truth === null` through `isNullish` — the very function
 * `case 'isNull'` uses — so the two are one question; and the NATIVE engine agrees, by hoisting
 * `IS UNKNOWN` past a faulting sibling exactly as it hoists `IS NULL`, while refusing to hoist
 * `IS TRUE`/`IS FALSE`. The two lists are applied in different places for that reason, so putting
 * a conjunct in the wrong one is a cross-engine divergence, not a style question. The table is
 * above the `truthTestProps` block in `satisfies`.
 *
 * Returns whether it claimed the conjunct, so the caller carries ONE branch for this family:
 * the match test is in here too, because `directEqProps` sits at the complexity cap.
 */
/**
 * File one lifted `IS [NOT] NULL` conjunct, returning whether it claimed the conjunct.
 *
 * The same shape as `liftTruthTest` — and extracted for the same reason, that `directEqProps` sits
 * at its complexity cap. The two families end up in the SAME list, since `IS UNKNOWN` is `IS NULL`.
 */
export const liftNullTest = (conjunct: Expr, ownVar: string, nulls: CNullProp[]): boolean => {
  const test = asNullTest(conjunct);

  if (test?.expr.kind !== 'prop' || test.expr.variable !== ownVar) {
    return false;
  }

  nulls.push({ key: test.expr.key, negated: test.negated });

  return true;
};
/**
 * `<ownVar>.<key> IS [NOT] TYPED <type>` as a liftable conjunct, or null (item 1298).
 *
 * `NOT (x IS TYPED T)` folds by FLIPPING `negated`, as `asNullTest`, `asTruthTest` and
 * `asLabelTest` all do — both of this file's two-pass mistakes (items 1261 then 1262) came from
 * handling one spelling and noticing the other later.
 */
export const asTypedTest = (
  e: Expr,
): { expr: Expr; ty: TypeTest; notNull: boolean; negated: boolean } | null => {
  if (e.kind === 'isTyped') {
    return { expr: e.expr, ty: e.ty, notNull: e.notNull, negated: e.negated };
  }

  if (e.kind === 'not' && e.expr.kind === 'isTyped') {
    const inner = e.expr;

    return { expr: inner.expr, ty: inner.ty, notNull: inner.notNull, negated: !inner.negated };
  }

  return null;
};
/**
 * File one lifted `IS [NOT] TYPED` conjunct, returning whether it claimed the conjunct.
 *
 * The fifth arm extracted because `directEqProps` sits at its complexity cap (items 1284-1290).
 */
export const liftTypedTest = (conjunct: Expr, ownVar: string, out: CTypedTestProp[]): boolean => {
  const test = asTypedTest(conjunct);

  if (test?.expr.kind !== 'prop' || test.expr.variable !== ownVar) {
    return false;
  }

  out.push({ key: test.expr.key, ty: test.ty, notNull: test.notNull, negated: test.negated });

  return true;
};
export const liftTruthTest = (
  conjunct: Expr,
  ownVar: string,
  nulls: CNullProp[],
  truthTests: CTruthTestProp[],
): boolean => {
  const test = asTruthTest(conjunct);

  if (test?.expr.kind !== 'prop' || test.expr.variable !== ownVar) {
    return false;
  }

  if (test.truth === null) {
    nulls.push({ key: test.expr.key, negated: test.negated });

    return true;
  }

  truthTests.push({ key: test.expr.key, truth: test.truth, negated: test.negated });

  return true;
};
export const liftLabelTest = (conjunct: Expr, ownVar: string, out: CLabelTest[]): boolean => {
  const test = asLabelTest(conjunct);

  if (test?.expr.kind !== 'var' || test.expr.name !== ownVar) {
    return false;
  }

  out.push({ label: test.label, negated: test.negated });

  return true;
};
export const asLabelTest = (e: Expr): { expr: Expr; label: LabelExpr; negated: boolean } | null => {
  if (e.kind === 'isLabeled') {
    return { expr: e.expr, label: e.label, negated: e.negated };
  }

  if (e.kind === 'not' && e.expr.kind === 'isLabeled') {
    const inner = e.expr;

    return { expr: inner.expr, label: inner.label, negated: !inner.negated };
  }

  return null;
};
/** A value usable as a seek key without binding the node's own variable. */
export const isConstExpr = (e: Expr): boolean => e.kind === 'lit' || e.kind === 'param';
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
export const closedList = (e: Expr): boolean =>
  e.kind === 'param' || (e.kind === 'list' && e.items.every(isConstExpr));
/** Mirror a comparison operator when its operands are swapped (`30 < a.age`). */
export const FLIP: Record<CompareOp, CompareOp> = {
  '=': '=',
  '<>': '<>',
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
};
/**
 * `<var>.a.b[.c…] <op> <const>` in EITHER operand order, or null (item 900).
 *
 * Both orders for the reason `asPropCompare` gives: accepting one spelling and scanning for the
 * other is the equivalent-spelling cliff this engine is named for.
 *
 * At least TWO segments — a single one is `asPropCompare`'s case.
 */
export const fieldChain = (expr: Expr): { variable: string; path: string[] } | null => {
  if (expr.kind === 'prop') {
    return { variable: expr.variable, path: [expr.key] };
  }

  if (expr.kind === 'field') {
    const base = fieldChain(expr.base);

    return base === null ? null : { variable: base.variable, path: [...base.path, expr.key] };
  }

  // A CONSTANT STRING SUBSCRIPT IS THE SAME SEGMENT AS A DOT (item 954). `base['y']` and `base.y`
  // are one operation under ISO — a string index on a record/map IS field access — and the two
  // arms agree on every base kind a path segment can meet, verified rather than read off the
  // code: record `"hit"`/`"hit"`, scalar null/null, absent null/null, number null/null, list
  // null/null. Only `fieldChain` disagreed, so the bracket spelling could not lift and measured
  // **1.18x** the dotted one for the same rows (92.3 against 109.3 ns/row, `route-vs-expr-probe`
  // arms D and D'). That is the equivalent-spelling cliff this engine is named for, in the
  // narrowest possible form: one `kind` the chain walker did not accept.
  //
  // A NUMERIC subscript is deliberately NOT accepted. `p.lst.0` is not valid syntax, so it has no
  // dotted twin and no spelling gap — and admitting it would need `pathOf` to carry list
  // semantics (integer-ness, bounds, `Array.isArray`) that a dotted segment never has. Lifting it
  // is a separate, optional ~17 ns question, not this one.
  if (expr.kind === 'index' && expr.index.kind === 'lit' && typeof expr.index.value === 'string') {
    const base = fieldChain(expr.base);

    return base === null
      ? null
      : { variable: base.variable, path: [...base.path, expr.index.value] };
  }

  return null;
};
export const asPathCompare = (
  expr: Extract<Expr, { kind: 'compare' }>,
): { variable: string; path: string[]; op: CompareOp; value: Expr } | null => {
  // `index` joins `field` here for the reason item 954 gives at `fieldChain`: a constant string
  // subscript is the same segment as a dot, so gating on `field` alone would leave the chain
  // walker unreachable for the spelling it was just taught to accept.
  if ((expr.left.kind === 'field' || expr.left.kind === 'index') && isConstExpr(expr.right)) {
    const chain = fieldChain(expr.left);

    return chain === null || chain.path.length < 2
      ? null
      : { ...chain, op: expr.op, value: expr.right };
  }

  if ((expr.right.kind === 'field' || expr.right.kind === 'index') && isConstExpr(expr.left)) {
    const chain = fieldChain(expr.right);

    return chain === null || chain.path.length < 2
      ? null
      : { ...chain, op: FLIP[expr.op], value: expr.left };
  }

  return null;
};
// A DOTTED path lifts into `pathProps` (item 903), and the four items it took are worth one note.
//
// `asPropCompare` below matches a plain `prop` only, so before this a dotted conjunct made
// `directEqProps` decline and took THE WHOLE PREDICATE to the generic evaluator — the route item
// 874 priced at 2.02x for a flat property. Lifting it measures 1.31x (98.7 -> 75.4 ns/row,
// disjoint, both controls flat).
//
// IT MEASURED NOTHING FOR THREE ITEMS FIRST, and the cause was one missing term in the "did
// anything lift" guard after `directEqProps`' loop: a LONE dotted conjunct accumulated into `path`
// and was then discarded because the other three lists were empty, so it lifted only when some
// OTHER conjunct lifted beside it — and the benchmark predicate is a lone dotted compare. Items
// 900, 901 and 902 each attributed that null to something else (a missing `ownVar`, an unwired
// consumer, an unexplained engine asymmetry), all plausible readings of real code. A new list has
// to be added to every place that asks "did anything lift", not just to the return type.
//
// SAFETY, because a lift is NOT additive: `compilePredicate` computes
// `generic = direct === null ? where : direct.residual` and `residual` is always `undefined`, so a
// successful lift EMPTIES `where` and the list becomes the ONLY carrier of that conjunct. Deleting
// the application loop is therefore a silent SUPERSET, and `dotted-predicate-routes.test.ts` catches
// it with 9 of its 12 cases. Any further list added here needs that fixture widened first.
export const asPropCompare = (
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
/**
 * `element_id(<var>) = <const>` in EITHER operand order, or null.
 *
 * Both orders, because accepting one would leave the other spelling scanning — the
 * equivalent-spelling cliff `CLAUDE.md` opens with, and the native twin
 * (`opt::id_seek_target`) takes both for the same reason.
 *
 * `=` only: a seed is a set of ids, and a range over an id has nothing to seek.
 *
 * Unlike the native rewrite, this one does NOT have to reject a non-string literal.
 * A hint here only narrows the SEED, and `matchNode` plus the residual `WHERE` re-validate
 * every seeded row, so a hint may yield a SUPERSET of the true matches but never a subset.
 * It is still restricted to a string at the point of use, to stay aligned with the native
 * engine rather than because correctness needs it — see `indexCandidates`.
 */
/**
 * The variable `element_id(<var>)` reads, or null. Hoisted to module scope rather than
 * closed over `asIdCompare` — it captures nothing, and oxlint's
 * `consistent-function-scoping` is right that rebuilding it per call is waste.
 *
 * ## Item 619's TS half does NOT reproduce, and this seed is why (item 650)
 *
 * 619 recorded TS **28,888 us** for `WHERE element_id(r) = $x` against 2,449 us for
 * `WHERE r.w = $w`, an 11.8x it attributed to materializing the id per row. Re-measured,
 * 20,000 nodes / 20,000 edges, ONE CASE PER PROCESS (item 274's contamination), min of 9:
 *
 * Every `=` spelling measured **~0.00 ms** — an id equality against a missing id seeds to an
 * EMPTY set and the query never walks. So the `=` numbers price the seed, not the per-row
 * read, and this engine seeds BOTH endpoints where native seeds only slot 0 and the edge.
 *
 * `<>` cannot seed (a seed is a set of ids; the complement of one is not), so it walks in
 * full and isolates the per-row cost. Three ALTERNATED rounds:
 *
 * | predicate, far side of a hop | ns/row |
 * | --- | --- |
 * | `element_id(b) <> 'nope'` | 100.92 / 87.38 / 93.31 |
 * | `b.s <> 'nope'` (string column, same shape) | 66.76 / 59.74 / 59.41 |
 * | `element_id(r) <> 'nope'` (the EDGE) | 59.64 / 52.91 / 54.55 |
 *
 * So a far-side NODE id read is a consistent **~1.5x** its string-property twin, and the EDGE
 * id — 619's actual subject — is at parity or cheaper. Nothing like 11.8x, and the mechanism
 * 619 named cannot exist here: `callScalar`'s `element_id` arm is `a.id`, a property read
 * returning a string REFERENCE, so there is no clone to remove (the same reason item 648's
 * native list-materialization had no TS twin).
 *
 * The ~1.5x on the node spelling is real, small, and on a shape — an id INEQUALITY — that is
 * rare to write. Priced here so it is not re-derived from 619's headline number.
 */
export const idArgVariable = (e: Expr): string | null =>
  e.kind === 'func' && e.name === 'element_id' && e.args.length === 1 && e.args[0]?.kind === 'var'
    ? e.args[0].name
    : null;
export const asIdCompare = (
  expr: Extract<Expr, { kind: 'compare' }>,
): { variable: string; value: Expr } | null => {
  if (expr.op !== '=') {
    return null;
  }

  const left = idArgVariable(expr.left);

  if (left !== null && isConstExpr(expr.right)) {
    return { variable: left, value: expr.right };
  }

  const right = idArgVariable(expr.right);

  if (right !== null && isConstExpr(expr.left)) {
    return { variable: right, value: expr.left };
  }

  return null;
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
/**
 * `element_id(n) = a OR element_id(n) = b` as one id list (item 1315) — the ID twin of
 * {@link uniformEqChain}, which matches a property key and so cannot see this shape.
 *
 * Every branch must be an id equality on the SAME variable. A branch on another variable is a
 * disjunction across bindings and not a membership; anything that is not an id `=` declines.
 */
export const uniformIdEqChain = (e: Expr): { variable: string; values: Expr[] } | undefined => {
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
  const values: Expr[] = [];

  for (const branch of branches) {
    if (branch.kind !== 'compare') {
      return undefined;
    }

    const ic = asIdCompare(branch);

    if (ic === null) {
      return undefined;
    }

    if (variable === undefined) {
      ({ variable } = ic);
    } else if (ic.variable !== variable) {
      return undefined;
    }

    values.push(ic.value);
  }

  return variable === undefined ? undefined : { variable, values };
};
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
export const SUBQUERY_KINDS: ReadonlySet<string> = new Set([
  'exists',
  'countSubquery',
  'valueSubquery',
]);
/**
 * Does this expression run a correlated subquery anywhere inside it?
 *
 * A GENERIC structural walk rather than a per-variant match, and deliberately so:
 * `Expr` is a wide union, and a walk that enumerated its arms would silently answer
 * "no subquery" for any arm added later — the failure direction that costs
 * `pushWhereIntoNode` below its whole reason to be careful. Object traversal cannot
 * miss one. It runs 2-4 times per query compile, on 2-4 DISTINCT nodes — measured at item 1500
 * by instrumenting it, which also means there is no redundancy left to memoize: item 919
 * already removed the double-walk this function used to do per conjunct.
 */
export const hasSubquery = (node: unknown): boolean => {
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

  // ⚠️ `for...in`, not `Object.values(...).some(...)` (item 1500). The walk visits 10-34 nodes per
  // compile (measured by instrumenting it), and the array form allocated one array PER VISITED
  // NODE to then throw away. `for...in` enumerates the same own+inherited string keys an AST node
  // has — these are plain object literals from the parser, so there is no prototype chain to widen
  // the set — and allocates nothing.
  for (const k in rec) {
    if (hasSubquery(rec[k])) {
      return true;
    }
  }

  return false;
};
/** `a AND b AND …` for two or more, the expression itself for one, nothing for none. */
export const conjoin = (items: readonly Expr[]): Expr | undefined => {
  if (items.length === 0) {
    return undefined;
  }

  if (items.length === 1) {
    return items[0];
  }

  return { kind: 'and', items };
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
export const flattenConjuncts = (e: Expr): readonly Expr[] =>
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
export const conjunctMix = (e: Expr): number => {
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
export const valueCannotRaise = (e: Expr): boolean =>
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
  (e.kind === 'neg' && e.expr.kind === 'lit' && typeof e.expr.value === 'number') ||
  // A DOTTED FIELD ACCESS (`n.m.k`), unconditionally and WITHOUT recursing into the base, because
  // that is exactly what the engine does: `can_raise` lists `Arith | Call | Cast` as raising and
  // recurses through `And`/`Or`/`Not`/`Compare`/`In`, so `Expr::Field` falls into its `_ => false`
  // however its base is built. The ordering key has to be the SAME key on both sides — the lesson
  // the `compare` and `isTruth` arms above were each billed for — and a narrower key here is not
  // caution, it is disagreement.
  //
  // MEASURED, not reasoned: a field access on a record, on a NUMBER, on a STRING, on an absent
  // key and three levels deep on a number all answer `null` in BOTH engines and raise in neither,
  // so classifying it non-raising is also true of this engine on its own terms.
  //
  // WHAT IT COST (item 1168): CI's differential fuzzer at `FUZZ_SEED=1433311152` hit
  // `WHERE ((CAST(n.nan AS BOOLEAN) IS UNKNOWN) AND (n.m.k = 3))` — TS raised E_INVALID_VALUE
  // where the engine answered `[{"x":5}]`. The CAST conjunct is correctly raising in both; the
  // divergence was that the engine could hoist `n.m.k = 3` ahead of it and filter the NaN-bearing
  // rows out first, while this engine could not, because a field access was not in this list.
  // Two further shapes diverged the same way (`WHERE n.s AND n.m.k = 99`, and the reversed
  // spelling), both TS raising against the engine's `ok []`.
  e.kind === 'field';
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
export const truthCannotRaise = (e: Expr): boolean => {
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
export const cheapPureExpr = (e: Expr): boolean =>
  e.kind === 'prop' || e.kind === 'var' || e.kind === 'lit' || e.kind === 'param';
/**
 * The correlated-subquery expression kinds. `boundExprs` admits one as a `LET` binding, and
 * {@link inlineTrailingLet} then requires the projection to read the name EXACTLY ONCE before
 * substituting it (item 565).
 */
export const SUBQUERY_EXPRS: ReadonlySet<string> = new Set([
  'exists',
  'countSubquery',
  'valueSubquery',
]);
/**
 * One conjunct as itself, several as an `and` — the inverse of {@link flattenConjuncts}.
 *
 * `hop-projection.ts` carries its own two-line copy of this. Deliberately not shared: that module
 * and this one already import from each other, and reaching across a two-way cycle to save two
 * lines buys a load-order hazard for nothing.
 */
export const andExprOf = (items: readonly Expr[]): Expr =>
  items.length === 1 ? items[0] : { kind: 'and', items: [...items] };
/**
 * Fold a trailing page STATEMENT into the `RETURN` that follows it (item 969).
 *
 * `MATCH … ORDER BY k LIMIT n RETURN items` and `MATCH … RETURN items ORDER BY k LIMIT n` are the
 * same question when the projection is row-wise: sorting the working table and then projecting
 * yields the same ordered rows as projecting and then sorting by the same keys, because a
 * row-wise projection preserves row identity. Only the second spelling is two clauses, and the
 * shortcut family opens with `clauses.length !== 2` — so the first paid for the extra clause AND
 * sorted `Binding` maps instead of projected columns.
 *
 * Measured at 200,000 nodes, one process, median of 5 alternated rounds (items 967, 968):
 *
 * ```text
 *   MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c    38.01 ms   3.87x
 *   MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 10    10.22      1.04x   <- what this produces
 *   MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10       9.83      1.00x
 * ```
 *
 * **3.72x**, and it collects both halves of item 967's decomposition at once: the third clause
 * (1.43x) and the sort position (3.09x). A projection's `ORDER BY` CAN key on an input variable —
 * verified rather than assumed, on every base shape (item 968) — which is what makes the fold
 * expressible at all.
 *
 * WHAT IT REFUSES, and each of these changes an ANSWER rather than a cost:
 *
 *   - **An aggregating / grouping / DISTINCT projection.** `ORDER BY k LIMIT 10 RETURN count(*)`
 *     takes ten rows and counts them; folded, it would count everything and page the one row.
 *     `DISTINCT`, `GROUP BY` and `HAVING` all change the row set the `LIMIT` applies to.
 *   - **A projection that already pages.** Two `LIMIT`s compose; merging them does not.
 *   - **A sort key naming something the projection ALIASES.** After folding, `ORDER BY k` would
 *     resolve to the output column `k` rather than to whatever `k` meant before the `RETURN`.
 *     This is the quiet one: it is the only refusal whose absence would produce a wrong ORDER
 *     rather than a wrong row count.
 *   - **`RETURN *`**, where the projected names are not written down here to compare against.
 *   - **A page clause that is not immediately before the final `RETURN`**, since anything between
 *     them observes the paged table.
 */
/**
 * Can evaluating `e` RAISE? Only a literal, a bare variable and a property read cannot (item 1056).
 *
 * Deliberately a WHITELIST of three kinds rather than a blacklist of the faulting ones: a new
 * expression kind added later is then assumed to fault, which refuses a fold that might have been
 * sound instead of admitting one that is not.
 */
export const cannotFault = (e: Expr): boolean =>
  e.kind === 'lit' || e.kind === 'var' || e.kind === 'prop';
