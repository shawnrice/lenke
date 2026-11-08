/**
 * EVALUATING A COMPILED PREDICATE against an element: does this vertex or edge satisfy it?
 *
 * `satisfies` is the single hot gate every matcher and every rung passes an element through, which
 * is why four separate modules reached back into `core.ts` for it. It lives below all of them now.
 *
 * ⚠️ IT CAME DOWN TO BREAK `core <-> matching` (item 1666), AND THE CHAIN IS WORTH RECORDING because
 * it is how a one-symbol cycle turns into a five-module question. `core.ts` needed exactly
 * `matchNode` from `matching.ts`; `matchNode` belongs with the other binding-extension functions, so
 * it moved to `bindings.ts`; but it calls `satisfies`, which was in `core.ts`, so `bindings.ts`
 * would then have imported `core.ts` and simply relocated the cycle. Moving `satisfies` down is what
 * makes the first move legal rather than cosmetic.
 *
 * ⚠️ `compareTruth` KEEPS THREE-VALUED LOGIC, AND THAT IS NOT THE SAME AS SORTING. A predicate's
 * comparison yields TRUE, FALSE or UNKNOWN, and NaN is JS-unordered here on purpose; the total order
 * used by sort/min/max lives in `values.ts` as `compareSort`, which puts NaN last and treats
 * `NaN === NaN`. A filter keeps only clean TRUE, so UNKNOWN settles the same way whichever order the
 * conjuncts run in (item 259) — which is what licenses reordering them for speed at all.
 */

import {
  Duration,
  LenkeRecord,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZonedDateTime,
  ZonedTime,
  isTemporal,
  temporalRelCmp,
} from '@lenke/core';
import type { Edge, Graph, Vertex } from '@lenke/core';

import type { CompareOp, TypeTest } from '../ast.js';
import { labelsMatch } from '../graph-queries.js';
import type {
  Binding,
  Bound,
  CLabelTest,
  CPredicate,
  CTypedTestProp,
  EvalEnv,
  Params,
} from './core.js';
import { COMPARE, asTruth, not3, recordGet, structuralEq } from './scalars.js';
import type { Truth } from './scalars.js';
import { propOf } from './values.js';
import { isNullish } from './values.js';

// Does a NON-null value match a scalar type category? Numeric split: `integer` =
// a whole-valued number, `float` = any number (one f64 numeric type; boundary
// inference). The open record (`ANY RECORD`) is a `TypeTest`, not a category —
// handled in `valueIsTypedTy`. Mirrors the Rust `category_matches`.
export const categoryMatches = (v: unknown, category: string): boolean => {
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
export const valueIsTypedTy = (v: unknown, ty: TypeTest, notNull: boolean): boolean => {
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
/**
 * `lv <op> rv` as a three-valued answer — the ONE definition of comparison semantics.
 *
 * Extracted from the `compare` arm so the element-local `cmpProps` loop can apply the SAME
 * rules to a property it read directly. Reimplementing them there would be the mistake
 * `patternCountOf`'s doc warns about ("a shortcut that half-applies a predicate is a wrong
 * answer"): the type handling below IS the semantics, not a detail around it.
 *
 * REJECTED LEVER — a two-number ORDERING fast path at the top of this function (audit item 802).
 *
 * `if (op !== '=' && op !== '<>' && typeof lv === 'number' && typeof rv === 'number') return
 * fn(lv, rv)` is byte-identical, NaN included: `isNullish` is `null`/`undefined` only so a NaN is
 * not nullish, a number is not a temporal, and `typeof lv === typeof rv === 'number'` IS the
 * `orderable` test below. It skips two `isNullish` calls, two `op` comparisons and two
 * `isTemporal` calls per row. It was written and measured and it moved NOTHING.
 *
 * Five real query shapes that reach it, 200,000 vertices, one shape per process, three
 * alternated rounds each, twice over: a filtered count 4.70/4.75/4.86 against 4.74/5.13/4.32 and
 * 4.69/5.50/5.08 against 4.41/4.65/4.22; a two-bound count 6.31/5.97/5.78 against 5.55/6.17/5.46;
 * a 156,000-row projection 10.54/11.22/10.30 against 10.37/10.09/14.11; a non-lifting
 * `n.k * 1 > 10` (this function's general arm) 13.24/12.21/11.04 against 10.30/11.61/11.24; a
 * per-edge hop 48.1/48.8/48.9 against 48.0/48.6/47.8. Every range overlaps, and the one reading
 * that looked disjoint in the first run reversed in the second.
 *
 * The per-row cost here is the PROPERTY READ, not the dispatch around it: a hand-written ladder
 * over the same 200,000 vertices measured the loop floor at 1.4 ns a vertex, a property read and
 * compare at 9.6-11.1, and the whole engine query at 21-27 — so a handful of branches was never
 * going to be visible. Do not re-derive it.
 */
export const compareTruth = (
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
/**
 * Do the lifted `IS [NOT] LABELED` conjuncts hold for this element (item 1289)?
 *
 * ⚠️ READS THE ELEMENT'S LABELS, not a property — the one lifted family with no key. `labelsMatch`
 * is the SAME function `case 'isLabeled'` goes through, so the lift cannot change what `IS LABELED`
 * means; and `satisfies` is only ever handed an element, so the `isElement` guard that arm needs
 * for an arbitrary expression is not a question here.
 *
 * Extracted because `satisfies` is at its complexity cap, and because this family's loop is the
 * only one that does not read `propOf`.
 */
/**
 * Do the lifted `IS [NOT] TYPED` conjuncts hold for this element (item 1298)?
 *
 * Extracted because `satisfies` is at its complexity cap — the same reason `labelTestsHold` below
 * was, one item earlier.
 */
export const typedTestsHold = (
  element: Vertex | Edge,
  tests: readonly CTypedTestProp[] | undefined,
): boolean => {
  if (tests === undefined) {
    return true;
  }

  for (const { key, ty, notNull, negated } of tests) {
    const m = valueIsTypedTy(propOf(element, key), ty, notNull);

    if (!(negated ? !m : m)) {
      return false;
    }
  }

  return true;
};
export const labelTestsHold = (
  element: Vertex | Edge,
  tests: readonly CLabelTest[] | undefined,
): boolean => {
  if (tests === undefined) {
    return true;
  }

  for (const { label, negated } of tests) {
    if (labelsMatch(element.labels, label) === negated) {
      return false;
    }
  }

  return true;
};
/** A `prop <op> const` comparison, normalized so the property is on the left. */
/**
 * Read a dotted path off an element: `path[0]` as a property, every later segment as a record
 * field (item 900).
 *
 * The same chain the compiled `'field'` closures walk — `recordGet` for a `LenkeRecord`, `propOf`
 * otherwise — so a lifted path reads what the generic evaluator read. At MODULE SCOPE deliberately:
 * the audit records that putting a walk INLINE in a returned closure gave unrelated queries a new
 * slow mode (4x), and this is called from inside the per-element predicate loop.
 */
export const pathOf = (element: unknown, path: readonly string[]): unknown => {
  let v: unknown = propOf(element, path[0]);

  for (let i = 1; i < path.length; i += 1) {
    v = v instanceof LenkeRecord ? recordGet(v, path[i]) : propOf(v, path[i]);
  }

  return v;
};
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

  // A DOTTED path, read straight off the element (item 900). `compareTruth` is the generic
  // `compare` arm's own function — the same one `cmpProps` uses — so UNKNOWN (a null operand, a
  // cross-type ordering, an absent segment) drops the row here exactly as it does there, and an
  // `=` means the EXPRESSION reading rather than the inline one.
  //
  // BEFORE `truthProps`, NOT after it, and the position is load-bearing (item 1169). These blocks
  // are ordered NON-RAISING FIRST: `eqProps` and `cmpProps` settle a row by reading a value and
  // comparing it, while `truthProps`/`notTruthProps` COERCE one and so RAISE on a non-boolean.
  // Item 900 appended this block at the end, which broke that invariant — and the engine's
  // `can_raise` treats a `Compare` over a `Field` and a `Lit` as NON-raising (`Expr::Field` falls
  // into its `_ => false`), so the engine hoists such a conjunct past a faulting sibling and this
  // engine did not:
  //
  //     MATCH (n:P) WHERE n.m.k = 99 AND n.s   ->   ts raised, engine answered []
  //
  // `n.s` lifts into `truthProps` and the dotted conjunct into `pathProps`, so running the former
  // first coerced a string before the latter could drop the row. Moving the block up is the whole
  // fix; nothing about either block's own semantics changes.
  if (pred.pathProps !== undefined) {
    for (const { path, op, value } of pred.pathProps) {
      if (compareTruth(op, COMPARE[op], pathOf(element, path), value(env)) !== true) {
        return false;
      }
    }
  }

  // ⚠️ THE NON-RAISING FAMILIES RUN **BEFORE** `truthProps`, AND ITEMS 1269/1270 HAD THIS BACKWARDS.
  // Both placed their family LAST on an explicit argument: "running the non-raising family first
  // would let a FALSE membership return before a sibling conjunct that the generic path would have
  // raised on, changing WHICH queries error. Running it last cannot: every family that can raise
  // has already run."
  //
  // The second sentence is false, and it was a TS-vs-native divergence for as long as those items
  // have been in. The generic route does NOT raise when a sibling settles the row — FALSE dominates
  // — so running a non-raising family LAST is what exposes a raise the whole-chain route suppresses.
  // Measured on both arms of item 1286's diff, so it pre-dates that item:
  //
  //     WHERE n.s AND false              ts ok []  native ok []   AGREE
  //     WHERE n.s AND n.z IS NOT NULL    ts ERR    native ok []   DIVERGE  (nullProps, item 1270)
  //     WHERE n.s AND n.n IN [99]        ts ERR    native ok []   DIVERGE  (memberProps, item 1269)
  //     WHERE n.s AND n.n = 99           ts ok []  native ok []   AGREE    (eqProps — runs FIRST)
  //     WHERE n.s AND n.n > 99           ts ok []  native ok []   AGREE    (cmpProps — runs FIRST)
  //
  // The two that agree are exactly the two already in this group, which item 1169 put here for the
  // same reason under a different shape ("ordered NON-RAISING FIRST"). So the file held two opposite
  // conventions and the evidence picks 1169's: a family that cannot raise settles the row before one
  // that can, which is what FALSE dominance does on the generic route.
  if (pred.memberProps !== undefined) {
    for (const { key, test, negated } of pred.memberProps) {
      const r = test(propOf(element, key), env);

      if ((negated ? not3(r) : r) !== true) {
        return false;
      }
    }
  }

  if (pred.nullProps !== undefined) {
    for (const { key, negated } of pred.nullProps) {
      if (isNullish(propOf(element, key)) === negated) {
        return false;
      }
    }
  }

  if (!labelTestsHold(element, pred.labelTests)) {
    return false;
  }

  // A bare property standing alone as a boolean predicate (item 875). `asTruth` is the SAME
  // function the generic `where` below goes through, so this is a cheaper route to an identical
  // answer — including the RAISE on a non-boolean, which is the reason these are not lifted as
  // an equality against `true`. A null or absent cell is UNKNOWN and a filter keeps only TRUE,
  // so it drops here exactly as it does there.
  if (pred.truthProps !== undefined) {
    for (const key of pred.truthProps) {
      if (asTruth(propOf(element, key)) !== true) {
        return false;
      }
    }
  }

  // The NEGATED twin (item 984). A row survives iff the cell is cleanly FALSE: `NOT UNKNOWN` is
  // UNKNOWN and a filter keeps only TRUE, so a null or absent cell drops here exactly as it does
  // on the generic path. `asTruth` is that same function, so a non-boolean RAISES identically —
  // the lift changes the route, not the answer and not which queries throw.
  if (pred.notTruthProps !== undefined) {
    for (const key of pred.notTruthProps) {
      if (asTruth(propOf(element, key)) !== false) {
        return false;
      }
    }
  }

  // ⚠️ `IS TRUE`/`IS FALSE` RUN **AFTER** `truthProps`, UNLIKE EVERY OTHER NON-RAISING FAMILY, and
  // the reason is measured rather than reasoned. This test cannot raise, so the argument above
  // would put it in the hoisted group — but the NATIVE engine does not hoist it, and byte-identity
  // is the contract. `n.s` is a string, so coercing it is a data exception; each tail below is
  // FALSE for every row unless noted:
  //
  //     WHERE n.s AND n.n IS TRUE        native ERR    FALSE and STILL raises: not hoisted
  //     WHERE n.s AND n.n IS FALSE       native ERR    likewise
  //     WHERE n.s AND n.n IS UNKNOWN     native ok []  hoisted — which is why it folds into
  //                                                    `nulls` above instead of living here
  //     WHERE n.s AND n.z IS NOT NULL    native ok []  hoisted
  //     WHERE n.s AND n.n IN [99]        native ok []  hoisted
  //     WHERE n.s AND n.n = 99           native ok []  hoisted
  //     WHERE n.s AND n.n IS NOT TRUE    native ERR    tail is TRUE here, so uninformative
  //
  // So the split is `truth === null` (hoisted, folded into `nulls`) against `truth !== null` (not
  // hoisted, here). Running this block any earlier makes TS answer `ok []` where native raises.
  //
  // The arithmetic is `case 'isTruth'`'s own: an EXACT three-valued comparison, so a non-boolean is
  // simply "no" rather than a fault, and `IS UNKNOWN` tests nullishness.
  // BESIDE `truthTestProps` AND FOR THE SAME MEASURED REASON (item 1298): the engine hoists no
  // form of `IS TYPED`, so this may not run before `truthProps` however total it is. `valueIsTypedTy`
  // is the SAME function `case 'isTyped'` goes through, so the lift cannot change what the test
  // means.
  if (!typedTestsHold(element, pred.typedTests)) {
    return false;
  }

  if (pred.truthTestProps !== undefined) {
    for (const { key, truth, negated } of pred.truthTestProps) {
      const v = propOf(element, key);
      const matches = truth === null ? isNullish(v) : v === truth;

      if (!(negated ? !matches : matches)) {
        return false;
      }
    }
  }

  return pred.where === undefined || asTruth(pred.where(env)) === true;
};
/**
 * Whether `pred`'s ELEMENT-DIRECT conjuncts already reject `element`, judged WITHOUT a binding
 * for the variable about to be bound (item 631). `false` means "not decided — carry on".
 *
 * Sound because `eqProps` and `cmpProps` read the property off the ELEMENT, and both reach
 * `CPredicate` only through `directEqProps`, which routes through `asPropCompare` and therefore
 * requires a CLOSED value side: neither can read the variable the caller is about to bind.
 *
 * DELIBERATELY A SECOND COPY OF THOSE TWO LOOPS RATHER THAN A HELPER `satisfies` ALSO CALLS.
 * Extracting them was tried first and cost the READ path 0.88x — `satisfies` is called per
 * candidate from the hop-projection fast paths too, and splitting it moved the loops behind a
 * call there. Measured against the pre-change dist alternated in one process, with a null
 * control (the same dist both sides) at 1.02x to prove the instrument. The repo's own note
 * says it: in this engine the SHAPE of a hot function is load-bearing.
 *
 * The copy is safe in one direction only, and that is the direction that matters: this is a
 * PRE-FILTER, with the full `satisfies` still run afterwards, so being too LENIENT merely
 * forgoes a saving while being too STRICT would lose rows. `the_element_direct_pre_filter_
 * never_rejects_a_row_satisfies_keeps` pins the strict direction.
 */
export const rejectedByElementDirect = (
  element: Bound,
  pred: CPredicate,
  binding: Binding,
  params: Params,
  graph: Graph,
): boolean => {
  // 🛑 EXTENDING THIS TO INLINE `props` WAS TRIED AND REVERTED (item 644). It is NOT a tuning
  // question: it changes WHICH QUERIES RAISE.
  //
  // The gap is real and large. `MATCH (a:S), (b:P {k: 7})` evaluates its node predicate once
  // per VERTEX while the clause and inline-`WHERE` spellings of the same question evaluate it
  // once per SURVIVOR, because only `eqProps`/`cmpProps` reach this pre-filter. Counted at
  // 20,000 vertices:
  //
  //   prod clause    satisfies=404    sat.eqProps=400
  //   prod props     satisfies=20004  sat.props=20000    <- 50x the evaluations
  //   prod inWHERE   satisfies=404    sat.eqProps=400
  //
  // Worth 1.89x at 1,000,000 vertices (222.99ms against 422.19), with the clause spelling and a
  // null control both flat at 1.00x. A single-pattern clause is UNAFFECTED (0.97x) because
  // neither spelling gets the pre-filter there.
  //
  // The candidate added a `closedProps` list — the props whose value expression has no free
  // variables, since a property value may be CORRELATED (`(b {w: a.k})`) where
  // `eqProps`/`cmpProps` are closed by construction via `directEqProps` — and tested it here
  // with `structuralEq` ONLY, no `rhs === null` rejection, so `{k: null}` kept its IS-NULL
  // reading and item 210's "route two" divergence could not recur.
  //
  // WHAT KILLED IT: this pre-filter runs BEFORE the binding is built, so rejecting a candidate
  // here skips a binding that would otherwise RAISE. `MATCH p = (a:P {k: 1}), (p:P {k: 2})
  // RETURN count(*)` — `p` as a path variable and a node variable — raises on the general path
  // and ANSWERED 0 with the change. `product-count.test.ts` pins that, and its comment states
  // the rule: "WHICH queries raise is part of the cross-engine invariant."
  //
  // So the lift is only sound where no binding on the rejected path can raise, which is not a
  // property this function can see. Narrowing it to dodge that one query would be guessing at
  // whether binding has other raise sources — the same guess that produced the IS-NULL
  // divergence historically. The gap stays OPEN with this as its reason.
  if (pred.eqProps === undefined && pred.cmpProps === undefined) {
    return false;
  }

  const env: EvalEnv = { binding, params, graph };

  if (pred.eqProps !== undefined) {
    for (const { key, value } of pred.eqProps) {
      const rhs = value(env);

      if (rhs === null || rhs === undefined) {
        return true;
      }

      if (!structuralEq(propOf(element, key), rhs)) {
        return true;
      }
    }
  }

  if (pred.cmpProps !== undefined) {
    for (const { key, op, value } of pred.cmpProps) {
      if (compareTruth(op, COMPARE[op], propOf(element, key), value(env)) !== true) {
        return true;
      }
    }
  }

  return false;
};

// Pattern matching (see executor/matching.ts).
