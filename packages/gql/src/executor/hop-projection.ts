import type { Graph, Vertex } from '@lenke/core';

import type { Clause, CountValue, Expr, LabelExpr, Projection, RelPattern } from '../ast.js';
import type {
  AggFold,
  CClause,
  CNode,
  CompiledExpr,
  CPredicate,
  CProjection,
  CReturnItem,
  EvalEnv,
  Params,
  Row,
} from '../executor.js';
import {
  aggregateOverValues,
  compileExpr,
  edgesOfTypes,
  compilePredicate,
  foldFor,
  percentileFraction,
  compareSort,
  freePredicateVars,
  projectRow,
  propOf,
  relTypeNames,
  satisfies,
  sortsOnOutputOnly,
} from '../executor.js';
import { candidateCount, candidateVertexSource, expand, matchesLabel } from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { indexCandidates } from './matching.js';
import { outputColumnSorts, sortedRows } from './ordered-rows.js';
import { asTruth, isNullish } from './scalars.js';
import {
  hopSeek,
  pageGroups,
  pageIsEmpty,
  plainNode,
  plainRel,
  rowLocal,
  sameGroupingExpr,
  vacuousLabel,
  valueSet,
} from './shortcuts.js';

/** Rows for a whole `MATCH … RETURN` query, or `null` if the shape does not fit. */
/**
 * A fast-path row producer, or `null` to DECLINE at execution time and let the general clause
 * loop answer instead. The decline is graph-dependent — whether an index seek exists is not
 * knowable when the closure is built — which is why it lives here rather than in the detector.
 */
export type RowsFn = (graph: Graph, params: Params) => Row[] | null;

/**
 * A fast path that always answers. Kept separate from {@link RowsFn} so the DISTINCT detector
 * carries no decline branch: it has no end to seek and never hands the query back, and a
 * defensive `?? []` at its call site would be an untestable branch — a mutant replacing it is
 * equivalent code, which is how a test suite comes to look like it has teeth it does not.
 */
export type AlwaysRowsFn = (graph: Graph, params: Params) => Row[];

/**
 * `MATCH (a:L)-[:T]->(x) RETURN <expressions over x>` — walk the hop and build each row
 * directly, with no binding copy and no generator stack.
 *
 * ### Why this shape
 *
 * `traverse 1-hop project` is the largest absolute cost in the cross-engine bench for the
 * TypeScript engine: 807.9ms for 1,000,000 rows (806ns a row) against native's 75.7ms. The
 * split says the cost is the ROW PIPELINE, not the data:
 *
 *     RETURN x.name AS n          861ns a row
 *     RETURN 1 AS n               662ns a row   — no property read at all
 *     RETURN x.name, x.age        771ns a row   — two reads, no dearer than one
 *
 * So 77% of it is machinery that a constant projection pays in full. A CPU profile of the
 * same query puts 50.4% in generator/closure bodies, 14.4% in `generatorResume`, **7.2% in
 * the `Map` constructor** and 4.8% in `withBinding` — `withBinding` does `new Map(binding)`,
 * so a 1-hop allocates two binding maps per row before anything is projected.
 *
 * This path removes all of it: ONE binding `Map`, mutated per edge, and a direct `push`.
 * `projectRow` builds a fresh `Row` and never retains the binding, which is what makes
 * reusing one safe.
 *
 * Mirrors native's `try_fused_hop_project`, including its central restriction — there, every
 * projected item must satisfy `refs_only_slot(e, 1)`; here, every item may read only the far
 * variable. That is what lets the binding hold exactly one entry.
 *
 * ### Row ORDER is preserved, not merely permitted
 *
 * Unordered row order is unspecified in this engine (as in SQL without `ORDER BY`), so a
 * different order would not be a bug. It is matched anyway, because a gratuitous reordering
 * would churn every caller and test for nothing: the walk is `candidateVertices(startLabel)`
 * and then the per-vertex type bucket, which is exactly what the general path's
 * `candidateVertices` → `expand` does for a directed single-type hop.
 */
/**
 * Do the projected items read NOTHING but the pattern's two endpoints, and does any read the
 * start?
 *
 * `null` declines. A name that is neither endpoint cannot be served by a walk that binds only
 * those two, and `freePredicateVars` cannot tell a name it does not recognize from one it does —
 * so anything else is refused rather than guessed at. The REL variable is already refused by the
 * caller.
 */
const projectedEndsOnly = (
  items: readonly CReturnItem[] | readonly { expr: Expr }[],
  farVar: string,
  startVar: string | undefined,
  relVar: string | undefined,
): { readsStart: boolean; readsRel: boolean } | null => {
  let readsStart = false;
  let readsRel = false;

  for (const item of items) {
    for (const name of freePredicateVars((item as { expr: Expr }).expr)) {
      if (name === startVar) {
        readsStart = true;
        continue;
      }

      // The REL variable is a third legal name (audit item 446). It is served by binding the
      // edge the walk is already holding — `expand`'s bucket loop has it — which costs one
      // `set` per edge. Reading it was previously a decline worth 646 against 192 ns/row.
      if (relVar !== undefined && name === relVar) {
        readsRel = true;
        continue;
      }

      if (name !== farVar) {
        return null;
      }
    }
  }

  return { readsStart, readsRel };
};

/**
 * Can this clause `WHERE` be carried into the fused walk, and does it need the start bound?
 *
 * `null` declines. It is carried only when it reads nothing but the pattern's two endpoints —
 * which are what the walk binds — AND reads the FAR one. A predicate on the START ALONE belongs
 * to item 154's seed pre-filter, which evaluates it once per start VERTEX and skips the
 * expansion entirely; carrying it here would evaluate it once per EDGE. Measured: intercepting
 * that shape cost 4.047 -> 5.228ms, so this is a measured boundary between two fast paths
 * rather than a conservative one.
 */
const carriedWhere = (
  where: Expr | undefined,
  farVar: string,
  startVar: string | undefined,
  relVar: string | undefined,
): { needsStart: boolean; startOnly: boolean; needsRel: boolean } | null => {
  if (where === undefined) {
    return { needsStart: false, startOnly: false, needsRel: false };
  }

  const vars = [...freePredicateVars(where)];

  for (const name of vars) {
    if (name !== farVar && name !== startVar && name !== relVar) {
      return null;
    }
  }

  // A clause `WHERE` reading the REL variable is carried (audit item 447), which needs the edge
  // bound BEFORE the gate is evaluated — `relBoundFilteredHopWalk` is the only walk here that
  // does that. Refusing it cost `WHERE r.w < 100 RETURN b` 772 ns/row against the ~250 the
  // rel-bound walk reaches.
  const needsRel = relVar !== undefined && vars.includes(relVar);

  const readsStart = startVar !== undefined && vars.includes(startVar);

  // A predicate reading ONLY the start used to be refused here, so it declined to the general
  // path. That was not arbitrary: this walk did not SEED, so taking an anchored filter meant
  // scanning a whole label while the general path went straight to the index — item 177
  // measured the walk at 3966us against the general path's 49.6, and refusing it was the fix.
  //
  // The walk seeds now (`hopSeek`, below), which is the same answer items 176 and 206 reached
  // for the one- and two-hop COUNTS: a walking fast path should not decline an indexed filter,
  // it should seed from the index and keep walking. So a start-only predicate is accepted and
  // gets its own closure, which applies it PER START VERTEX instead of per row — the whole point
  // of carrying it, since the general path cannot reject a start before expanding it either.
  if (!vars.includes(farVar) && !readsStart && !needsRel) {
    return null;
  }

  // A start-only predicate is taken ONLY when it is row-local. `rowLocal` is item 204's
  // allowlist and what it refuses here is the subquery arms: item 175 gave the seed gate a
  // CHEAP-CONJUNCT-FIRST order precisely so `WHERE u.k = 'nope' AND <faulting subquery>` never
  // reaches the subquery, and a walk that evaluates the whole predicate at once loses that. Five
  // of its tests caught this, as raises rather than wrong rows.
  if (!vars.includes(farVar) && !needsRel && !rowLocal(where)) {
    return null;
  }

  // The start is bound only when the predicate actually reads it: the single mutated binding is
  // the allocation this path exists to avoid, so an extra `set` per vertex is not free.
  return {
    needsStart: readsStart,
    // A predicate reading the REL is not start-only however little else it reads: the start-only
    // walk gates a vertex BEFORE touching its adjacency, and there is no edge bound at that
    // point for it to read.
    startOnly: readsStart && !vars.includes(farVar) && !needsRel,
    needsRel,
  };
};

/**
 * The far node's own inline constraint, compiled — `undefined` when the node is plain, `null`
 * when it must not be carried.
 *
 * CLOSED constraints only, the same rule `inlineOf` applies: every property VALUE must have no
 * free variables and an inline `WHERE` may read nothing but the node's own variable.
 * `(v {k: u.k})` is correlated and would need the start bound per edge — the correlation problem
 * of items 121-123, not this one.
 */
/**
 * The REL mirror of {@link closedFarPred}: the inline constraint a hop PROJECTION can apply
 * per edge, `undefined` for a plain rel, or `null` to decline (item 638).
 *
 * `closedFarPred`'s own comment is this function's argument. Carrying the FAR NODE's inline
 * constraint rather than refusing it was worth 5x there — *"the two spellings of ONE question
 * differ by 5x once the clause form became fast"* — and the RELATIONSHIP was left in exactly
 * the state the far node had been in: `plainRel` refused the whole route, so
 * `-[r:E {w: $w}]->` fell to the general path at **4.34x** the clause spelling that means the
 * same thing.
 *
 * Same rule as its twin, plus a QUANTIFIER decline: a quantified rel is a walk, and this path
 * serves one hop. An inline `WHERE` needs the rel's own variable to be bound, so it requires
 * one; closed PROPERTIES do not, since `satisfies` reads them off the edge.
 */
const closedRelPred = (rel: RelPattern): CPredicate | undefined | null => {
  if (plainRel(rel)) {
    return undefined;
  }

  if (rel.quantifier !== undefined) {
    return null;
  }

  for (const c of rel.properties ?? []) {
    if (freePredicateVars(c.value).size > 0) {
      return null;
    }
  }

  if (rel.where !== undefined) {
    if (rel.variable === undefined) {
      return null;
    }

    for (const name of freePredicateVars(rel.where)) {
      if (name !== rel.variable) {
        return null;
      }
    }
  }

  // `rel.variable` AS `ownVar`, which this omitted. The loop above has just PROVED the `WHERE`
  // reads nothing but the rel's own variable — and that proof is exactly `compilePredicate`'s
  // precondition for lifting a conjunct into `eqProps`/`cmpProps`, read straight off the element
  // instead of through the binding `Map`. Not passing it meant the proof was computed, used to
  // admit the fast path, and then discarded (item 780).
  return compilePredicate(rel.properties, rel.where, rel.variable);
};

const closedFarPred = (
  node: { properties?: readonly { value: Expr }[]; where?: Expr; variable?: string },
  farVar: string,
): CPredicate | undefined | null => {
  if (plainNode(node as never)) {
    return undefined;
  }

  for (const c of node.properties ?? []) {
    if (freePredicateVars(c.value).size > 0) {
      return null;
    }
  }

  if (node.where !== undefined) {
    for (const name of freePredicateVars(node.where)) {
      if (name !== farVar) {
        return null;
      }
    }
  }

  // `farVar` AS `ownVar` — the same omission as in `closedRelPred`, and the one that was
  // MEASURED. The loop above refuses any free variable other than `farVar`, so the precondition
  // holds; without the argument `directEqProps` declines outright and an inline node `WHERE`
  // lands on the generic evaluator. Three spellings of one question, 40,000 nodes at degree 5,
  // one shape per process, min of three order-alternated rounds (item 780):
  //
  //   `->(b {age: 5})`              13.83 ms   inline props, read off the element
  //   `->(b) WHERE b.age = 5`       19.31      the clause form, a per-edge gate
  //   `->(b WHERE b.age = 5)`       20.55      THIS — admitted, then evaluated generically
  //
  // The inline node `WHERE` was the SLOWEST of the three despite being the most specific, which
  // is this repo's named defect class pointing at its own fast path. With the argument passed it
  // is 14.14 (1.45x), and `> 45` — the `cmpProps` lift of item 276 — is 22.96 to 16.34 (1.41x).
  //
  // THE NULL BOUNDARY MOVES WITH IT, which is why this is not purely a route choice: an inline
  // node `WHERE b.k = null` now settles in `satisfies`'s `eqProps` loop rather than the generic
  // evaluator. Both give the EXPRESSION reading (no rows) — `=` yields UNKNOWN, and the loop
  // rejects a null right-hand side for exactly this reason — but the two readings differ for
  // `{k: null}`, so the guard is load-bearing and now load-bearing HERE. See the test named for
  // this item.
  return compilePredicate(node.properties as never, node.where, farVar);
};

/**
 * The far predicate and the per-edge gate, deciding between them (item 781).
 *
 * Its own function for the reason `carriedWhere` and `closedFarPred` are: `detectHopProjection`
 * sits at this file's complexity gate, and writing this inline put it at 42 against a limit of 35.
 *
 * When the clause lifts, the gate is GONE rather than merely cheaper — which also means a rung
 * keyed on `gate === undefined` can now admit a filtered query it previously refused. That is the
 * intent, and item 778's lesson is why it is said out loud: opening one gate can disqualify
 * another rung, and nothing about the gate being opened reveals it.
 */
const farPredAndGate = (
  clauseWhere: Expr | undefined,
  compiledWhere: CompiledExpr | undefined,
  closedFar: CPredicate | undefined,
  farVar: string,
): { farPred: CPredicate | undefined; gate: CompiledExpr | undefined } => {
  if (clauseWhere === undefined || compiledWhere === undefined || closedFar?.where !== undefined) {
    return { farPred: closedFar, gate: compiledWhere };
  }

  const lifted = liftFarOnlyClause(clauseWhere, farVar);

  if (lifted === undefined) {
    return { farPred: closedFar, gate: compiledWhere };
  }

  return {
    farPred: closedFar === undefined ? lifted : mergeFarPreds(closedFar, lifted),
    gate: undefined,
  };
};

/**
 * A clause `WHERE` that reads NOTHING but the far variable, compiled as a far predicate that
 * lifts entirely — or `undefined` when any part of that is untrue (item 781).
 *
 * `compilePredicate`'s `ownVar` contract is a PROOF that the expression is element-local, and this
 * establishes it the same way `closedFarPred` does for an inline constraint: every free variable
 * is the far one. The extra condition is that the result carry no generic `where`, because a
 * conjunct `directEqProps` declined gains nothing from being moved out of the gate.
 */
const liftFarOnlyClause = (where: Expr, farVar: string): CPredicate | undefined => {
  for (const name of freePredicateVars(where)) {
    if (name !== farVar) {
      return undefined;
    }
  }

  const lifted = compilePredicate(undefined, where, farVar);

  // `where` present means NOTHING lifted — `directEqProps` declines the whole chain on its first
  // unliftable conjunct — so this is the "no gain" arm rather than a partial one. The second test
  // catches a predicate that compiled to no constraint at all.
  if (lifted.where !== undefined) {
    return undefined;
  }

  return (lifted.eqProps?.length ?? 0) > 0 || (lifted.cmpProps?.length ?? 0) > 0
    ? lifted
    : undefined;
};

/**
 * The far node's inline predicate followed by a lifted clause predicate, in that order.
 *
 * The order is the query's: an inline constraint is written before the clause `WHERE`, and
 * `satisfies` walks `props`, then `eqProps`, then `cmpProps`, so appending preserves it.
 *
 * `where` is deliberately NOT carried, and that is why the caller refuses an inline constraint
 * that has one: `satisfies` evaluates `where` LAST, so there is no way to keep it ahead of a
 * lifted clause conjunct. Dropping it silently would answer a different question.
 */
const mergeFarPreds = (inline: CPredicate, clause: CPredicate): CPredicate => ({
  props: inline.props,
  ...(inline.eqProps === undefined && clause.eqProps === undefined
    ? {}
    : { eqProps: [...(inline.eqProps ?? []), ...(clause.eqProps ?? [])] }),
  ...(inline.cmpProps === undefined && clause.cmpProps === undefined
    ? {}
    : { cmpProps: [...(inline.cmpProps ?? []), ...(clause.cmpProps ?? [])] }),
});

/**
 * Does `name` appear ANYWHERE in this AST fragment, in any position?
 *
 * A GENERIC structural walk rather than a per-variant match, for the reason `hasSubquery` in
 * the executor is written the same way: `Expr` is a wide union, and a walk enumerating its arms
 * would answer "not mentioned" for any arm added later — the unsafe direction here, since the
 * caller admits a fast path on a negative answer.
 *
 * It compares every string in the fragment against `name`, which makes it DELIBERATELY
 * over-broad: a projected string literal `'e'`, or an unrelated property key `e`, reports
 * mentioned for the rel variable `e`. The cost of a false positive is a declined fast path and
 * nothing else, while the cost of a false negative is a wrong answer — see item 444 on the
 * correlated rel variable a free-variable check could not see.
 */
const mentionsName = (node: unknown, name: string): boolean => {
  if (typeof node === 'string') {
    return node === name;
  }

  if (node === null || typeof node !== 'object') {
    return false;
  }

  // The array arm is REDUNDANT — `Object.values` on an array returns its elements, so the
  // object arm below already covers one, and mutation confirms removing this arm changes no
  // answer. It stays because it matches `hasSubquery`'s shape and avoids the `Object.values`
  // allocation on the common case; its redundancy is a property of JavaScript rather than of
  // another function here, so unlike the `m.where` clause above it cannot quietly rot.
  if (Array.isArray(node)) {
    return node.some((child) => mentionsName(child, name));
  }

  return Object.values(node as Record<string, unknown>).some((child) => mentionsName(child, name));
};

const SUBQUERY_KINDS: ReadonlySet<string> = new Set(['exists', 'countSubquery', 'valueSubquery']);

/** Does a subquery appear anywhere in this AST fragment? A generic walk, like `mentionsName`. */
const containsSubquery = (node: unknown): boolean => {
  if (node === null || typeof node !== 'object') {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some(containsSubquery);
  }

  const rec = node as Record<string, unknown>;

  if (typeof rec.kind === 'string' && SUBQUERY_KINDS.has(rec.kind)) {
    return true;
  }

  return Object.values(rec).some(containsSubquery);
};

/**
 * Can this projection be emitted row by row as the walk produces them?
 *
 * The five conditions `projectedRows` fast-paths, plus `star`: anything that sorts, dedups,
 * pages or aggregates needs the whole set in hand. Extracted from `detectHopProjection` only to
 * keep it under the complexity gate — seven clauses in one `if` is seven of the budget, and item
 * 446's one extra branch put the function at 37 against a limit of 35.
 */
/**
 * The binding name a hop's ANONYMOUS end node is given (item 776). A NUL is not a valid
 * identifier character in the GQL lexer — `MATCH (a)-[:E]->(\u0000anon_far)` is rejected as an
 * unexpected character — so no query can reference this, which is what makes binding to it
 * invisible to a projection, a `WHERE`, or a correlated subquery.
 */
const ANON_FAR_VAR = '\u0000anon_far';

/**
 * The hop's endpoints and edge type, or `null` to decline — the three validations
 * `detectHopProjection` opened with, extracted to keep it under the complexity cap for the same
 * reason `projectionIsStreamable` was.
 */
const hopEnds = (
  rel: RelPattern,
  node: { variable?: string },
  start: { label?: LabelExpr; variable?: string },
): {
  typeName: string;
  farVar: string;
  startLabel: LabelExpr | undefined;
  startVarName: string | undefined;
} | null => {
  // ONE concrete edge type, so the per-vertex bucket is exact. `relTypeNames` returns `undefined`
  // for an untyped hop and `null` for a shape with no single bucket.
  const types = relTypeNames(rel.label);
  // An ANONYMOUS end node gets a synthesized name rather than a refusal (item 776).
  //
  // This returned `null` for `node.variable === undefined`, so `MATCH (:P)-[r:E]->() RETURN r.k`
  // fell to the general row pipeline while `->(b)` took this fast path: **83.51 ms against 19.03
  // over the same 200,000 rows, 4.4x**, both answers correct — an equivalent-spelling gap of the
  // kind item 444 closed for `-[e:E]->` against `-[:E]->` (3.7x) and item 505 for a split `MATCH`
  // (747.9 ms against 0.0). Three in this one file, all the same shape: a gate on whether a name
  // is PRESENT rather than on whether it is USED.
  //
  // Synthesizing beats threading `string | undefined` through fifty-odd uses — six walk
  // implementations do `binding.set(farVar, far)` and would each need a branch. The sentinel
  // cannot collide with a user variable because the PARSER cannot produce it: a NUL is not a
  // valid identifier character, checked rather than assumed. Nothing can read it either, so
  // `vars.includes(farVar)` is false exactly as it should be and `startOnly` resolves the same
  // way it does for a named-but-unread end.
  const farVar = node.variable ?? ANON_FAR_VAR;
  const startLabel = start.label;

  // `candidateVertices` seeds from the label bucket ONLY for a simple label; for anything else it
  // yields every vertex and leaves the filtering to its caller. Requiring a simple (or absent)
  // label keeps the seed exact without re-deriving that filtering here.
  if (types?.length !== 1 || (startLabel !== undefined && startLabel.kind !== 'label')) {
    return null;
  }

  return { typeName: types[0], farVar, startLabel, startVarName: start.variable };
};

/**
 * How a hop projection handles an `ORDER BY`: the wrapper that sorts its rows, and whether the
 * sort forces the START-DRIVEN walk. `null` declines the query.
 *
 * A SORT IS AN ORDER-SENSITIVE CONSUMER, so it rides the start-driven walk — through the flag the
 * detector already takes for exactly that reason. `forceStartDriven`'s own doc establishes the
 * premise: with a non-vacuous start label both engines read the same row sequence, "which is what
 * says the start-driven walk's order is the general path's. So an order-sensitive fold may ride
 * THIS walk, and only this one."
 *
 * The far-driven walk reorders rows deliberately (its header says so, and that it is sound only
 * because an unordered result's order is unspecified). A sort pins the SORTED order but leaves
 * TIES on arrival order, and tie order IS observable between the engines — item 605 measured TS
 * and native agreeing exactly over a fixture with 20 ties per group, on every hop spelling. So
 * sorting rows produced in the far-driven order would reorder ties away from native: a divergence
 * no timing shows, and one a differential fuzzer comparing multisets cannot see.
 */
const hopOrderPlan = (
  ret: Extract<Clause, { kind: 'return' }>,
  proj: CProjection,
  forceStartDriven: boolean,
): { sorted: (inner: RowsFn | null) => RowsFn | null; startDriven: boolean } | null => {
  // The COMPILED projection's item names, not a re-derivation from the AST: `proj.items[i].name`
  // is what `sortsOnOutputOnly` reads for the aggregate rungs, so both callers resolve a key
  // against the same names.
  const sorts = outputColumnSorts(
    ret,
    proj.items.map((it) => it.name),
  );

  if (sorts === null) {
    return null;
  }

  // 🛑 `sorts !== undefined` FORCING THE START-DRIVEN WALK IS THE SORTED-HOP COST, and it is
  // REFUTED as a target at item 698 (re-priced at 697) — do not re-derive it. The far-driven walk
  // is cheaper and cannot be used here: it REORDERS rows deliberately, and
  // `Array.prototype.sort` is stable, so tie order would change — which is observable between the
  // engines (item 605 measured both agreeing over a fixture with 20 ties per group).
  // `ordered-rows.ts` states the rule.
  //
  // WHAT THE COST IS, measured against the HONEST floor (the unordered query PLUS a bare sort of
  // its own rows, not the unordered query alone): 0.86x of that floor at degree 1 — the engine
  // sorts more cheaply than materialising and sorting separately — and 1.58x at degree 3.
  // Comparing against the unordered row alone overstates it ~1.9x, which is items 659/660's
  // lesson and the mistake item 727 walked into from the other direction: the bench's
  // `+ order by` row looks 2.6x worse than `traverse 1-hop project` and most of that is the floor.
  return {
    sorted: (inner) => sortedRows(inner, sorts ?? undefined),
    startDriven: forceStartDriven || sorts !== undefined,
  };
};

const projectionIsStreamable = (proj: CProjection): boolean =>
  !proj.star &&
  !proj.aggregating &&
  !proj.distinct &&
  proj.items.length > 0 &&
  // An `ORDER BY` is no longer refused here (item 607): `outputColumnSorts` admits it when every
  // key names an output column and there is NO WINDOW, and the rows are sorted on the way out.
  // A window still goes to the general path, and with no sort it must — that path is LAZY, so a
  // `LIMIT 5` short-circuits where a materializing rung scans everything (`sortOf` records that
  // as ~280x for the DISTINCT walk). The two clauses are one rule, which is why they are one
  // condition rather than two.
  (proj.orderBy.length > 0 || (proj.skip === undefined && proj.limit === undefined));

/**
 * The REL-BOUND hop projection: the start-driven walk, binding the edge as well as the far end.
 *
 * A BUILDER returning a per-compile closure, which is the shape `farDrivenHopWalk` and
 * `filteredHopWalk` already have here — and the shape item 159 measured as the right one. A
 * shared module-scope walk called with every compile's shapes goes polymorphic at its call
 * sites and cost 1.29x; a closure built per compile keeps its own. It is also not a branch
 * inside the existing start-driven walk, because item 159 measured that adding even a branch to
 * that inner loop costs the hot unfiltered shape 1.6x.
 *
 * The only difference from that walk is one `set` per edge. The edge is already in hand: the
 * bucket loop is iterating edges and resolving a far vertex from each, so binding it costs a
 * `Map.set` on a binding that was going to be mutated anyway. That one line is worth 3.0x on
 * `RETURN r` and 3.1x on `RETURN r.w`, because the alternative was the general path.
 *
 * It must NOT be given the far-driven treatment. That walk's 2.3x comes from hoisting
 * `projectRow` to once per far VERTEX (item 167), valid only because every item it admits is a
 * pure function of the far end; an item reading the edge is not, since a far vertex's incident
 * edges differ. Hoisting here is a wrong answer, not a faster one, and the mutant that does it
 * is caught.
 */

/**
 * The walk for an UNDIRECTED hop projection, admitted only for the simplest shape:
 * far-end-only projection, no carried `WHERE`, no far predicate, no edge variable.
 *
 * ITS OWN CLOSURE, not a branch in the walks below it: each of those captures `out: boolean`
 * and indexes one of `edgesFromByLabel` / `edgesToByLabel`, and item 159 measured a branch in
 * that inner loop at 1.6x on the hot directed shape. Nothing here is reachable from a directed
 * hop — `detectHopProjection` returns `null` for `both` the moment this declines, which is what
 * the old blanket `rel.direction === 'both'` guard did for every shape.
 *
 * ORDER is the difficulty. `expand` emits, PER START VERTEX, the out-steps then the in-steps,
 * skipping a self-loop in the in-pass because a loop is indexed under BOTH maps. Row order is
 * observable for a projection, so this walk does exactly that — and that is also why item 478's
 * two-pass trick (all out-rows, then all in-rows) is confined to aggregates, where the fold
 * cannot see order.
 *
 * Measured at 200,000 nodes / 1,000,000 edges: 754 -> 357-395 ns a row. The honest comparison
 * is the START-DRIVEN directed walk at 321-330 ns a row, not the far-driven one at 116-145: an
 * undirected walk cannot be far-driven, because a far end's rows come from two buckets.
 */
const undirectedHopWalk = (w: {
  startLabel: LabelExpr | undefined;
  typeName: string;
  farVar: string;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
  farPred: CPredicate | undefined;
  gate: CompiledExpr | undefined;
  needsStart: boolean;
}): RowsFn | null => {
  const { startLabel, typeName, farVar, farLabel, proj } = w;

  // The admission test lives HERE rather than at the call site, which keeps three conditions
  // out of `detectHopProjection` — it sits one branch under the complexity cap, and the cap is
  // right that the detector is already doing enough.
  if (w.farPred !== undefined || w.gate !== undefined || w.needsStart) {
    return null;
  }

  return (graph, params) => {
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();

    for (const v of candidateVertexSource(graph, startLabel)) {
      const outBucket = v.adjFrom?.get(typeName);

      if (outBucket !== undefined) {
        for (const edge of outBucket) {
          const far = edge.to;

          if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
            continue;
          }

          binding.set(farVar, far);
          rows.push(projectRow(proj, binding, params, graph));
        }
      }

      const inBucket = v.adjTo?.get(typeName);

      if (inBucket === undefined) {
        continue;
      }

      for (const edge of inBucket) {
        // The self-loop the out-pass already emitted — `expand` skips it here and so must this,
        // or an undirected hop over a loop yields two rows where the general path yields one.
        if (edge.from === edge.to) {
          continue;
        }

        const far = edge.from;

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        binding.set(farVar, far);
        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

const relBoundHopWalk = (spec: {
  startLabel: LabelExpr | undefined;
  typeName: string;
  out: boolean;
  farVar: string;
  relVar: string | undefined;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
  /** No far predicate, no carried clause `WHERE`, and no item reading the start. */
  unfiltered: boolean;
}): RowsFn | null => {
  const { startLabel, typeName, out, farVar, relVar, farLabel, proj, unfiltered } = spec;

  // The DECLINE lives here rather than at the call site, which keeps `detectHopProjection` under
  // the complexity gate — the inline form put it at 39 against a limit of 35. `filteredHopWalk`
  // binds no edge, so a far predicate, a carried clause `WHERE` or a start-reading item must
  // decline rather than be served by a walk that applies none of them; the mutant dropping this
  // is caught by one test. An anonymous rel cannot have been read in the first place.
  if (relVar === undefined || !unfiltered) {
    return null;
  }

  return (graph, params) => {
    const rows: Row[] = [];
    // ONE binding, mutated per edge, now holding TWO entries instead of one.
    const binding = new Map<string, unknown>();

    for (const v of candidateVertexSource(graph, startLabel)) {
      const bucket = (out ? v.adjFrom : v.adjTo)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        const far: Vertex = out ? edge.to : edge.from;

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        binding.set(farVar, far);
        binding.set(relVar, edge);
        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

/**
 * The REL-BOUND FILTERED hop projection: the start-driven filtered walk, binding the edge.
 *
 * Item 446 bound the edge for the UNFILTERED shape only, so a far predicate, a carried clause
 * `WHERE` or a start-reading item still declined when the rel was read. `WHERE r.w < 100 RETURN
 * b` stayed at 772 ns/row and the `spelling-probe` group added there reported it at 2.7x. This
 * closes that half.
 *
 * Three things it deliberately does NOT do, each for a reason already measured here:
 *
 *   - **No far-driven variant.** That walk hoists `projectRow` to once per far VERTEX (item
 *     167), which an item reading the edge invalidates — a far vertex's incident edges differ.
 *     Hoisting is a wrong answer here, not a faster one.
 *   - **No start-only gating.** The start-only walk evaluates the gate BEFORE touching a
 *     vertex's adjacency (item 164's order, worth 52ns against 34 a vertex), and at that point
 *     there is no edge bound for the gate to read. A start-only predicate therefore keeps
 *     `startOnly` false whenever it reads the rel, and the combination of a start-only `WHERE`
 *     with a rel-reading ITEM declines outright rather than being gated per edge.
 *   - **It keeps the far-seek decline.** `cfar` narrower than the start source by `SEEK_MARGIN`
 *     means the general path can seek the far end, and item 177 measured 89x for declining in
 *     that region. The check is per call, so the inner loop pays nothing for it.
 */
const relBoundFilteredHopWalk = (w: {
  startLabel: LabelExpr | undefined;
  typeName: string;
  out: boolean;
  farVar: string;
  relVar: string | undefined;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
  farPred: CPredicate | undefined;
  /** The rel's own inline constraint, applied per EDGE through `satisfies` (item 638). */
  relPred: CPredicate | undefined;
  gate: CompiledExpr | undefined;
  startVar: string | undefined;
  startOnly: boolean;
  cfar: CNode | undefined;
}): RowsFn | null => {
  const { startLabel, typeName, out, farVar, relVar, farLabel, proj } = w;
  const { farPred, relPred, gate, startVar, startOnly, cfar } = w;

  if (startOnly) {
    return null;
  }

  // AN ANONYMOUS REL IS ADMITTED since item 639 — `-[:E {w: $w}]->` carries a constraint with
  // no variable to bind it to, and refusing it left that spelling at 3.77x the clause form
  // (item 638 measured it and recorded it open).
  //
  // Nothing that needs the edge BOUND can reach here without a name: `itemsReadRel` and
  // `carried.needsRel` are both decided from `rel.variable`, so when it is absent neither the
  // projection nor the gate can read the edge, and only `relPred` — which `satisfies` applies
  // to the edge OBJECT — remains.
  //
  // The key is hoisted rather than branched on per edge. A `!== undefined` test inside this
  // loop is exactly what item 159 measured at 1.6x on the hot shape, and the empty string
  // cannot collide with a real binding because a GQL identifier is never empty.
  const relKey = relVar ?? '';

  return (graph, params) => {
    if (cfar !== undefined) {
      const env: EvalEnv = { binding: new Map<string, unknown>(), params, graph };
      let narrowest = Infinity;

      for (const candidate of indexCandidates(graph, cfar, env)) {
        narrowest = Math.min(narrowest, candidate.count);
      }

      if (narrowest * SEEK_MARGIN < candidateCount(graph, startLabel)) {
        return null;
      }
    }

    const rows: Row[] = [];
    const binding = new Map<string, unknown>();

    for (const v of candidateVertexSource(graph, startLabel)) {
      const bucket = (out ? v.adjFrom : v.adjTo)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      if (startVar !== undefined) {
        binding.set(startVar, v);
      }

      for (const edge of bucket) {
        const far: Vertex = out ? edge.to : edge.from;

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        binding.set(farVar, far);
        // BEFORE the gate, which is the whole point: the gate may read the rel variable.
        binding.set(relKey, edge);

        // The REL gate first: it needs neither endpoint, and in the shape this was built for
        // it is the selective one. Same ordering choice as the tally's (item 637).
        if (relPred !== undefined && !satisfies(edge, relPred, binding, params, graph)) {
          continue;
        }

        if (farPred !== undefined && !satisfies(far, farPred, binding, params, graph)) {
          continue;
        }

        if (gate !== undefined && asTruth(gate({ binding, params, graph })) !== true) {
          continue;
        }

        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

/**
 * Is the hop's relationship variable mentioned somewhere this path cannot SEE?
 *
 * Item 444 declined every mention of the rel variable. Item 446 serves a mention instead, by
 * binding the edge — but only a mention `freePredicateVars` can report, because that is what
 * `projectedEndsOnly` and `carriedWhere` decide with. The one construct it cannot report is a
 * SUBQUERY: it adds an inner pattern's own binding names to its bound set, so an inner
 * `-[r:T]->` CORRELATING on an already-bound `r` is indistinguishable from one binding `r`
 * freshly, and neither is reported free. That is the wrong answer item 444 found —
 * `MATCH (p:U)-[r:T]->(q) RETURN COUNT { MATCH (p)-[r:T]->(z) }` must be 1 per row, not `p`'s
 * degree.
 *
 * So a mention is HIDDEN when a subquery is present, and the pair of checks is deliberately
 * asymmetric: `mentionsName` is over-broad (it compares every string, so a literal `'r'`
 * counts) and `containsSubquery` is over-broad too, and both err toward declining. With no
 * subquery anywhere, `freePredicateVars` is complete over this fragment and every read of the
 * rel variable is visible, which is the condition item 446's binding relies on.
 *
 * Split out of `detectHopProjection` to keep it under the complexity gate, which the inline
 * form pushed to 36 against a limit of 35 — the same split several other guards in this file
 * have, and for the same reason.
 */
const relVariableHidden = (
  relVar: string | undefined,
  projection: Projection,
  where: Expr | undefined,
): boolean =>
  relVar !== undefined &&
  (mentionsName(projection, relVar) || mentionsName(where, relVar)) &&
  (containsSubquery(projection) || containsSubquery(where));

/**
 * `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(x) RETURN …` — the left-outer hop's PROJECTION.
 *
 * One row per match, or ONE null-filled row for an anchor with none. Item 510 gave the count
 * its rung; the projection had none either, and every detector refuses `optional` on its first
 * check, so it fell to the general row pipeline at 848ns a row against the non-optional
 * two-clause spelling's 169 once item 507 fused that one (audit item 511). Native pays ~1.15x
 * for the same shape, so the gap is entirely the missing rung.
 *
 * The walk is start-driven by construction — the null-fill is per ANCHOR, so the anchors have
 * to be the outer loop — which also means the row ORDER is the anchor bucket's, exactly as the
 * non-optional rung's is. Row order without `ORDER BY` is unspecified.
 *
 * Narrow on purpose, and each refusal is a position this walk cannot answer:
 *
 *   - an aggregate, `DISTINCT`, `GROUP BY`, `HAVING` or `ORDER BY` in the projection — this
 *     emits rows, it does not fold or reorder them;
 *   - `SKIP`/`LIMIT`, which the general path pages correctly and this would have to re-derive;
 *   - a clause `WHERE` on either side, a rel VARIABLE, `both`, inline properties, or a
 *     constrained anchor — the same list item 510's count rung refuses, for the same reasons.
 */
/** The anchor-and-optional-hop shape `detectOptionalHopProjection` walks, or `null`. */
const optionalHopShape = (
  m: Clause,
  om: Clause,
): {
  startVar: string;
  startLabel: LabelExpr | undefined;
  farVar: string;
  farLabel: LabelExpr | undefined;
  types: string[] | undefined;
  out: boolean;
} | null => {
  if (
    m.kind !== 'match' ||
    m.optional ||
    m.where !== undefined ||
    m.patterns.length !== 1 ||
    om.kind !== 'match' ||
    !om.optional ||
    om.where !== undefined ||
    om.patterns.length !== 1
  ) {
    return null;
  }

  const [anchor] = m.patterns;
  const startVar = anchor.start.variable;

  if (
    anchor.segments.length !== 0 ||
    anchor.pathVar !== undefined ||
    startVar === undefined ||
    (anchor.start.properties !== undefined && anchor.start.properties.length > 0) ||
    anchor.start.where !== undefined
  ) {
    return null;
  }

  const [hop] = om.patterns;
  const [far] = hop.segments;

  if (hop.pathVar !== undefined || hop.segments.length !== 1 || far === undefined) {
    return null;
  }

  const { rel, node } = far;
  const farVar = node.variable;
  const types = relTypeNames(rel.label);

  if (
    hop.start.variable !== startVar ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    rel.properties !== undefined ||
    rel.where !== undefined ||
    rel.quantifier !== undefined ||
    farVar === undefined ||
    farVar === startVar ||
    (node.properties !== undefined && node.properties.length > 0) ||
    node.where !== undefined ||
    types === null
  ) {
    return null;
  }

  return {
    startVar,
    startLabel: anchor.start.label,
    farVar,
    farLabel: node.label,
    types,
    out: rel.direction === 'out',
  };
};

/** A projection that emits one row per binding: no folding, deduping, grouping or paging. */
/**
 * A projection with nothing but items: no `*`, no DISTINCT, no grouping, no ORDER BY, no paging.
 * Exported because item 528's `FOR` projection asks exactly the same question, and two copies of
 * this list is how one of them falls behind the other.
 */
export const plainRowProjection = (proj: Projection): boolean =>
  !proj.star &&
  !proj.distinct &&
  proj.groupBy === undefined &&
  proj.having === undefined &&
  (proj.orderBy?.length ?? 0) === 0 &&
  proj.skip === undefined &&
  proj.limit === undefined;

export const detectOptionalHopProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m, om, ret] = clauses;
  const [, , cret] = compiled;

  if (cret?.kind !== 'return' || cret.projection.aggregating || ret.kind !== 'return') {
    return null;
  }

  const shape = optionalHopShape(m, om);

  if (shape === null || !plainRowProjection(ret.projection)) {
    return null;
  }

  const { startVar, startLabel, farVar, farLabel, types, out } = shape;

  return (graph, params) => {
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();

    for (const v of candidateVertexSource(graph, startLabel)) {
      binding.set(startVar, v);

      let matched = false;

      for (const edge of edgesOfTypes(out ? v.adjFrom : v.adjTo, types)) {
        const landed = out ? edge.to : edge.from;

        if (farLabel !== undefined && !matchesLabel(landed, farLabel)) {
          continue;
        }

        matched = true;
        binding.set(farVar, landed);
        rows.push(projectRow(cret.projection, binding, params, graph));
      }

      if (!matched) {
        // The whole difference from the non-optional rung: the anchor survives with the
        // landing variable NULL.
        binding.set(farVar, null);
        rows.push(projectRow(cret.projection, binding, params, graph));
      }
    }

    return rows;
  };
};

export const detectHopProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
  /**
   * Force the START-driven walk even where the far-driven one would be chosen (item 551).
   *
   * The two walks visit rows in DIFFERENT orders, which item 419 records as the reason only an
   * order-independent aggregate may ride this walk. Measured on an 8-edge fixture with crossed
   * edges and NO start label, so the far-driven walk fits:
   *
   * ```text
   *   MATCH (a)-[:K]->(b) RETURN b.age AS k   ts [0,0,1,2,2,3,4,5]   native [5,2,3,4,0,0,2,1]
   * ```
   *
   * Row order without an `ORDER BY` is unspecified (item 198), so that is legal for a PROJECTION
   * — but a `collect` folds in that order and the order IS its answer. With a non-vacuous start
   * label the same query reads `[5,2,3,4,0,0,2,1]` in both engines, which is what says the
   * start-driven walk's order is the general path's. So an order-sensitive fold may ride THIS
   * walk, and only this one.
   */
  forceStartDriven = false,
): RowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  const [cm] = compiled;

  if (cm.kind !== 'match') {
    return null;
  }

  const [pattern] = m.patterns;

  // No path variable: `p = (a)-[:T]->(x)` has to build a Path per row.
  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node } = seg;

  // `both` would visit a self-loop from both ends, and a quantifier needs the general
  // matcher.
  //
  // A NAMED but UNMENTIONED relationship is admitted (audit item 444). This check was here and
  // documented as "defensive, not load-bearing" — and defensive cost 3.7x: `MATCH (a:P)-[e:E]->(b)
  // RETURN count(b.k)` measured 4.6ms against 1.25ms for the identical query spelled `-[:E]->`,
  // over 20,000 nodes and 40,000 edges, isolated one case per process. `-[e:E]->` and `-[:E]->`
  // are the SAME question when `e` is unread, which makes that an equivalent-spelling gap of the
  // exact kind this repo exists to close.
  //
  // But the guard WAS load-bearing, and not for the reason its own comment gave. Removing it
  // outright broke `a REL VARIABLE bound OUTSIDE correlates on that edge, not the degree`:
  // `MATCH (p:U)-[r:T]->(q) RETURN COUNT { MATCH (p)-[r:T]->(z) }` must answer 1 — that one
  // edge — and answered 2, `p`'s degree. The claim that "the projection guard rejects any item
  // that reads a name other than the far variable" is false for a SUBQUERY: `freePredicateVars`
  // descends into one, but it adds the inner pattern's own binding names to its bound set first,
  // so an inner `-[r:T]->` that CORRELATES on an already-bound `r` is indistinguishable from one
  // that binds `r` freshly, and neither is reported free. So `projectedEndsOnly` saw an item
  // reading neither endpoint and admitted it. That is the second comment in this file to be
  // refuted by running the thing it described (item 420 was the first).
  //
  // So the rel variable's name must not be MENTIONED anywhere in the two places that could
  // observe it — the RETURN projection and the clause `WHERE`. Of those two, mutation shows
  // only the PROJECTION half has teeth: dropping it fails two tests, while dropping the
  // `m.where` half changes no answer, and still changes none with `carriedWhere`'s
  // neither-endpoint refusal ALSO removed. What actually refuses a subquery `WHERE` on this
  // path is `rowLocal`, whose own comment says the arms it exists to refuse are the subquery
  // ones. The clause stays anyway, and this paragraph is the reason: the projection half proves
  // a free-variable analysis cannot see this correlation, so a later relaxation of `rowLocal`
  // — wanting subquery `WHERE`s on the fast path is a reasonable thing to want — would reopen
  // exactly the hole this item found. Defence in depth, named as such instead of described as
  // the guard, which is the mistake the paragraph above is about.
  //
  // `mentionsName` is a generic
  // structural walk for exactly the reason `hasSubquery` in the executor is one: `Expr` is a
  // wide union and a walk enumerating its arms would answer "not mentioned" for any arm added
  // later, which is the unsafe direction. It compares every string in the AST, so an unrelated
  // string literal `'e'` also declines — a false decline costs a fast path and nothing else.
  //
  // What remains inert about an unmentioned `e` is that every OTHER way of reading it is refused
  // by name already: `plainRel` rejects a rel with inline properties, an inline `WHERE` or a
  // quantifier; `projectedEndsOnly` rejects a projected item naming anything but the two
  // endpoints; `carriedWhere` rejects a clause `WHERE` that does. So `count(e.w)` still declines
  // — correctly, since the walk never binds an edge. The path VARIABLE check above stays: a
  // `pathVar` has to build a `Path` per row whether or not it is projected.
  //
  // A path MODE (`SIMPLE`/`ACYCLIC`/`WALK`/`TRAIL`) is deliberately NOT rejected: this
  // engine applies those restrictors per repetition, so on a single non-quantified hop they
  // are no-ops — measured against the general path including the `ACYCLIC`-with-a-self-loop
  // case, which is the one that could have differed. A path SELECTOR (`ANY SHORTEST`) raises
  // on a non-var-length pattern in both paths.
  // `both` is admitted ONLY by `undirectedHopWalk` below, and only for the simplest shape. It
  // is refused here for every other path because each of them indexes ONE of
  // `edgesFromByLabel` / `edgesToByLabel` through a captured `out: boolean`.
  // A rel's inline constraint is CARRIED (item 638), not refused — see `closedRelPred`. Only
  // the edge-bound walk can apply it, which is forced below; every other walk here refuses it.
  const relPred = closedRelPred(rel);

  if (relPred === null) {
    return null;
  }

  if (relVariableHidden(rel.variable, ret.projection, m.where)) {
    return null;
  }

  if (!plainNode(start)) {
    return null;
  }

  const ends = hopEnds(rel, node, start);

  if (ends === null) {
    return null;
  }

  const { typeName, farVar, startLabel, startVarName } = ends;
  const proj: CProjection = cret.projection;

  if (!projectionIsStreamable(proj)) {
    return null;
  }

  // A projected item may read EITHER endpoint. Reading the far end alone keeps the binding at
  // one entry; reading the start has it bound once per outer vertex, which is what that guard's
  // own comment said would be needed and cheap. A name that is neither still declines, which is
  // the safety that matters — `freePredicateVars` cannot tell a name it does not recognize from
  // one it does, and the REL variable is already refused above.
  //
  // Refusing the start cost 3.5-4.7x on four shapes, including the very ordinary unfiltered
  // `MATCH (u:L)-[:E]->(v) RETURN u.name`: 20.0ms against 5.7ms for the same query projecting
  // `v.name` instead, with no semantic difference between them (audit item 160).
  const projected = projectedEndsOnly(ret.projection.items, farVar, startVarName, rel.variable);

  // THE ORDER DECISION is extracted into `hopOrderPlan` — `detectHopProjection` sits at the
  // complexity cap and this file's own precedent is to extract rather than grow it
  // (`projectionIsStreamable` says the same). Its decline shares this return with `projected`'s
  // for the same reason: one statement instead of two.
  const order = hopOrderPlan(ret, proj, forceStartDriven);

  if (projected === null || order === null) {
    return null;
  }

  const { sorted, startDriven: startDrivenForOrder } = order;

  const itemsReadStart = projected.readsStart;
  const itemsReadRel = projected.readsRel;

  // A clause `WHERE` is CARRIED rather than refused, as long as it reads nothing but the
  // pattern's two endpoints — which are exactly what the walk binds. Refusing it sent the
  // query to the general path, making a FILTERED hop 3x the cost of the same hop UNFILTERED
  // (24.3ms against 8.1ms over 20,000 edges) even though the filter cut 20,000 rows to 207.
  // A filter that makes a query slower is a declined fast path, not the cost of filtering
  // (audit item 159).
  //
  // The predicate is the COMPILED clause `WHERE` the general path uses, not a re-derivation,
  // and it is applied at the same point: once per row, after both endpoints are bound. So the
  // evaluation count and the elements evaluated are unchanged — which is what items 139/142
  // require of a fast path.
  const startVar = startVarName;
  const carried = carriedWhere(m.where, farVar, startVar, rel.variable);

  if (carried === null) {
    return null;
  }

  // The FAR node's own inline constraint — `(v {score: 5})` or `(v WHERE v.score = 5)` — is
  // carried rather than refused. Leaving it out made the two spellings of ONE question differ
  // by 5x once the clause form became fast (2.5ms against 13ms), which is the gap this repo is
  // named after. `satisfies` is the general path's own node check and needs no allocation,
  // because the single mutated binding already holds the far end.
  //
  // CLOSED constraints only, the same rule `inlineOf` applies: every property VALUE must have
  // no free variables and an inline `WHERE` may read nothing but the node's own variable.
  // `(v {score: u.score})` is correlated and would need the start bound per edge — that is the
  // correlation problem of items 121-123, not this one.
  const closedFar = closedFarPred(node, farVar);

  if (closedFar === null) {
    return null;
  }

  // THE CLAUSE SPELLING TAKES THE SAME ROUTE AS THE INLINE ONE (item 781).
  //
  // Item 780 made an inline `->(b WHERE b.k = 5)` lift into `eqProps`, read straight off the
  // element, and that left the CLAUSE twin as the slow spelling of the three — 21.07 ms against
  // 14.24 for the inline `WHERE` and 13.83 for `->(b {k: 5})`. The clause form compiles to `gate`,
  // a general `CompiledExpr` evaluated per edge through the binding `Map`, which is exactly the
  // cost item 780 removed from the other spelling.
  //
  // So when the whole clause `WHERE` reads nothing but the far variable, compile it as a far
  // PREDICATE instead and drop the gate. `compilePredicate` already takes the proof as `ownVar`;
  // the only new thing here is noticing that a clause `WHERE` can satisfy it too. Measured
  // 21.07 -> 13.90 (1.52x), and an AND of two far-local conjuncts 22.49 -> 14.93 (1.51x), both
  // converging with the inline spellings.
  //
  // THE SECOND REFUSAL IS THE LOAD-BEARING ONE. `mergeFarPreds` carries `props`, `eqProps` and
  // `cmpProps` and NOT `where`, because there is no position left in `satisfies` that would keep
  // a generic inline predicate ahead of a lifted clause one. So an inline constraint that did not
  // lift must block the whole lift — merging would DROP it and answer a different question. The
  // other two are weaker than they look and the comments say which is which, so a later reader
  // does not spend a tick re-deriving it:
  //
  //   - `liftFarOnlyClause` refusing a clause that does not lift ENTIRELY is a NO-GAIN refusal,
  //     not a correctness one. `directEqProps` is all-or-nothing, so "did not lift entirely"
  //     means nothing lifted at all, and the predicate would land in `farPred.where` — the same
  //     generic evaluator the gate already is. Every walk here sets `binding.set(farVar, far)`
  //     BEFORE its `farPred` check, so it would still answer correctly; it would just not be
  //     faster.
  //   - a clause reading the START or the REL is left to `carried`, which has the walks that bind
  //     them. That refusal is structural: this predicate is handed only the far element.
  const { farPred, gate } = farPredAndGate(m.where, cm.where, closedFar, farVar);
  // The start is bound when the carried predicate reads it OR a projected item does.
  const needsStart = carried.needsStart || itemsReadStart;

  const out = rel.direction === 'out';
  const farLabel: LabelExpr | undefined = node.label;

  // TWO closures, chosen once at compile time, and the unfiltered one is byte-for-byte what
  // this path was before any filter was carried. The shape of this split was measured three
  // ways, because the hot UNFILTERED hop notices all of them (2.5ms over 20,000 edges):
  //
  //   filter checks folded into the single existing loop   1.6x slower
  //   two MODULE-SCOPE walks taking a spec object          1.29x slower
  //   two closures built per compile (this)                flat
  //
  // The middle one is the interesting failure: `ts-closure-size-is-load-bearing` says to keep a
  // walk at module scope, and that is right about closure SIZE — but a shared module-scope walk
  // is called with every compile's shapes, so its call sites go polymorphic, while a closure
  // built per compile keeps its own. Destructuring the spec into locals did not recover it.
  // Here each returned closure holds ONE loop and its own captured constants, which is what
  // both effects want (audit item 159).
  // The PLAIN walk is for the far-end-only case and is byte-for-byte what it was before any of
  // this; item 159 measured that adding even a branch to its inner loop costs the hot shape
  // 1.6x. A start-reading projection goes to the FILTERED walk instead, which already binds the
  // start per vertex — it pays two always-false predicate checks per edge, which is nothing
  // against the 3.5x it gains.
  // A projected item reading the REL variable needs the edge BOUND, which only the walk below
  // does (audit item 446). Two consequences, and the first is a correctness one:
  //
  //   - The FAR-DRIVEN walk is unusable. Its 2.3x comes from hoisting `projectRow` to once per
  //     far VERTEX, valid only because every admitted item is a pure function of the far end
  //     (item 167). An item reading the edge is not: a far vertex's incident edges differ, so
  //     hoisting would emit one edge's values for all of them. It is not a slower option here,
  //     it is a wrong one.
  //   - `filteredHopWalk` does not bind the edge either, so a far predicate, a carried clause
  //     `WHERE` or a start-reading item still DECLINES when the rel is read. That is the other
  //     half of this target and it is not built: `WHERE r.w < 100 RETURN b` measured 814 ns/row
  //     and stays there.
  //
  // So the rel-bound walk is start-driven, and it is its own closure rather than a branch in
  // the existing one, because item 159 measured that adding even a branch to that inner loop
  // costs the hot unfiltered shape 1.6x.
  // A rel read from EITHER the projected items or the carried clause `WHERE` needs the edge
  // bound. The unfiltered walk is preferred because it is the cheaper one; the filtered walk
  // takes everything else and declines the shapes neither can serve.
  // AN UNDIRECTED HOP (item 480): its own walk, and nothing below can see `both` — every
  // walk there captures ONE direction through `out: boolean`. See `undirectedHopWalk`.
  if (rel.direction === 'both') {
    // `undirectedHopWalk` has no rel-bound form, so a carried rel constraint must decline here
    // rather than be dropped — a dropped predicate is a wrong answer, not a slow one.
    if (relPred !== undefined) {
      return null;
    }

    return sorted(
      undirectedHopWalk({
        startLabel,
        typeName,
        farVar,
        farLabel,
        proj,
        farPred,
        gate,
        needsStart,
      }),
    );
  }

  if (itemsReadRel || carried.needsRel || relPred !== undefined) {
    const unfiltered =
      farPred === undefined && gate === undefined && !needsStart && relPred === undefined;

    return (
      relBoundHopWalk({
        startLabel,
        typeName,
        out,
        farVar,
        relVar: rel.variable,
        farLabel,
        proj,
        unfiltered,
      }) ??
      relBoundFilteredHopWalk({
        startLabel,
        typeName,
        out,
        farVar,
        relVar: rel.variable,
        farLabel,
        proj,
        farPred,
        relPred,
        gate,
        startVar: needsStart ? startVar : undefined,
        startOnly: carried.startOnly,
        cfar: compiledFarNode(cm),
      })
    );
  }

  if (farPred === undefined && gate === undefined && !needsStart) {
    // The START-driven walk, byte-for-byte what it was: item 159 measured that adding even a
    // branch to this inner loop costs the hot shape 1.6x.
    const startDriven = (graph: Graph, params: Params): Row[] => {
      const rows: Row[] = [];
      // ONE binding, mutated per edge. This is the allocation the profile found.
      const binding = new Map<string, unknown>();

      for (const v of candidateVertexSource(graph, startLabel)) {
        const bucket = (out ? v.adjFrom : v.adjTo)?.get(typeName);

        if (bucket === undefined) {
          continue;
        }

        for (const edge of bucket) {
          const far: Vertex = out ? edge.to : edge.from;

          if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
            continue;
          }

          binding.set(farVar, far);
          rows.push(projectRow(proj, binding, params, graph));
        }
      }

      return rows;
    };

    const farDriven = farDrivenHopWalk({ typeName, out, farVar, farLabel, proj });

    // Which walk is chosen is a PER-CALL decision, not a per-row one, so the branch costs the
    // inner loop nothing. The far-driven walk cannot apply a START label — it iterates the far
    // end — so it runs only where no vertex could fail that label.
    return sorted((graph, params) =>
      !startDrivenForOrder && (startLabel === undefined || vacuousLabel(graph, startLabel))
        ? farDriven(graph, params)
        : startDriven(graph, params),
    );
  }

  return sorted(
    filteredHopWalk({
      forceStartDriven: startDrivenForOrder,
      startLabel,
      typeName,
      out,
      farVar,
      farLabel,
      proj,
      farPred,
      gate,
      startOnly: carried.startOnly,
      cstart: cm.patterns[0].start,
      startVar: needsStart ? startVar : undefined,
      // The COMPILED far node carries both the inline equalities and the seed hints lifted from
      // the clause `WHERE`, which are the two things `indexCandidates` reads — so one value
      // answers "could the far end seek?" for both spellings.
      cfar: compiledFarNode(cm),
    }),
  );
};

/**
 * The FAR-driven hop projection: iterate the far endpoints and emit one row per incident edge,
 * instead of iterating the start endpoints and resolving a far vertex per edge.
 *
 * Two things make it 2.3x (audit item 167), and the second is the larger:
 *
 *   LOCALITY — the start-driven walk reads a far vertex per EDGE, in edge order, which is random
 *   with respect to how vertices sit in memory. Over a 1,000,000-edge fixture that lookup and
 *   its pointer chase cost ~180ns, which is most of the 266ns a row took. Here the far vertices
 *   are walked in creation order.
 *
 *   HOISTING — every item this path admits is a pure function of the far end (the guard refuses
 *   a name that is neither endpoint, and `!needsStart` means no item reads the start), so all of
 *   a far vertex's edges project the SAME cell values. `projectRow` therefore runs once per
 *   VERTEX rather than once per edge — 200,000 times instead of 1,000,000 on that fixture — and
 *   a wider projection costs almost nothing extra.
 *
 * Row ORDER changes, which is why this is allowed at all: an unordered result's order is
 * unspecified in this engine, as in SQL without ORDER BY. A shape with ORDER BY or DISTINCT
 * never reaches here.
 *
 * The rows are built FRESH per edge rather than pushing one shared object N times: callers may
 * treat a row as their own, and aliasing a million of them would be a bug that no measurement
 * would show. Measured over 1,000,000 rows: a shared-object push would be 91ns, a spread copy
 * 126ns, and this key-loop form 116ns.
 */
const farDrivenHopWalk = (w: {
  typeName: string;
  out: boolean;
  farVar: string;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
}): ((graph: Graph, params: Params) => Row[]) => {
  const { typeName, out, farVar, farLabel, proj } = w;

  return (graph, params) => {
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();
    // The OPPOSITE index from the start-driven walk: for an `out` hop the far end is the edge's
    // TARGET, so the far endpoints are the keys of the reverse index.
    let keys: string[] | undefined;

    for (const far of candidateVertexSource(graph, farLabel)) {
      const bucket = (out ? far.adjTo : far.adjFrom)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
        continue;
      }

      binding.set(farVar, far);

      const template = projectRow(proj, binding, params, graph);

      // The column ORDER is observable (it is bytes), and `projectRow` fixes it; taking the keys
      // from its own output and rebuilding in that order is what preserves it.
      keys ??= Object.keys(template);

      const vals = keys.map((k) => template[k]);

      // The edges are never read — only counted — because the projection cannot reach them.
      for (let n = bucket.size; n > 0; n -= 1) {
        const row: Row = {};

        for (let c = 0; c < keys.length; c += 1) {
          row[keys[c]] = vals[c];
        }

        rows.push(row);
      }
    }

    return rows;
  };
};

/**
 * Build the FILTERED hop walk — the far end's own inline predicate and/or the carried clause
 * `WHERE`, applied in that order, which is the order the general path applies them (matching,
 * then filtering), so the rows and the faults are the general path's.
 *
 * A FACTORY at module scope rather than a closure inside `detectHopProjection`, and the
 * distinction is measured. The hot UNFILTERED hop (2.4ms over 20,000 edges) notices all four
 * arrangements tried:
 *
 *   filter checks folded into the one existing loop      1.6x slower
 *   two module-scope walks taking a spec object          1.29x slower
 *   two closures built inside the detect function        1.25x slower
 *   this: unfiltered inline, filtered behind a factory   flat
 *
 * Two effects pull opposite ways and this is where they meet. `ts-closure-size-is-load-bearing`
 * is right that a second hot loop inside the detect function costs the first one — but a SHARED
 * module-scope walk is called with every compile's shapes, so its call sites go polymorphic
 * (destructuring the spec into locals did not recover that). A factory gives each compile its
 * own closure AND keeps the detect function small (audit item 159).
 */
/**
 * How much narrower than the start source a far-end seek must be before this path hands the
 * query to the general one. Measured; see the table in `filteredHopWalk`.
 */
const SEEK_MARGIN = 8;

/**
 * The COMPILED far node of a single-hop pattern. Its own function because the optional chaining
 * counts against `detectHopProjection`'s complexity gate, which it was already at the edge of.
 */
const compiledFarNode = (cm: CClause): CNode | undefined =>
  cm.kind === 'match' ? cm.patterns[0]?.segments[0]?.node : undefined;

/**
 * Would any far end of this bucket have produced a row? Used ONLY from the fault path of the
 * start-gated walk, to decide whether a predicate that threw would have been evaluated by the
 * general path at all. Cold by construction, so it is shared rather than inlined per compile.
 */
const anyFarMatches = (
  graph: Graph,
  params: Params,
  binding: Map<string, unknown>,
  bucket: Iterable<{ to: Vertex; from: Vertex }>,
  w: {
    out: boolean;
    farVar: string;
    farLabel: LabelExpr | undefined;
    farPred: CPredicate | undefined;
  },
): boolean => {
  const { out, farVar, farLabel, farPred } = w;

  for (const edge of bucket) {
    const far: Vertex = out ? edge.to : edge.from;

    if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
      continue;
    }

    binding.set(farVar, far);

    if (farPred !== undefined && !satisfies(far, farPred, binding, params, graph)) {
      continue;
    }

    return true;
  }

  return false;
};

/**
 * Which END of a one-hop pattern is cheaper to DRIVE — and why it is a provable win rather than an
 * estimate.
 *
 * Both walks visit the same qualifying edges, so the EDGE term is the same; they differ only in how
 * many vertices they enumerate to find them. So driving the side with the smaller candidate set is
 * strictly cheaper by the difference, with no selectivity to guess at. (It is usually better than
 * that: driving the LABELLED side walks only the edges incident to that label, where driving the
 * unlabelled side walks every edge of the type and then tests the label per edge.)
 *
 * That is the bar item 223 set for firing at all — "fire only on a provable win; the speculative
 * case needs a cardinality estimate" — and it is why this is not the reversal that item declined.
 * That one trades a seed PRE-filter for a post-filter on the strength of an unindexed predicate's
 * guessed selectivity. This reads two bucket sizes, both O(1), and no predicate enters into it.
 *
 * STRICTLY smaller, so a tie keeps the current side: the two walks meet rows in different orders,
 * and reordering an un-ordered projection for no gain is churn. `candidateCount` already returns
 * the whole graph for a label it cannot seed from, so the strict comparison ALSO establishes that
 * the far label is seedable — a non-simple far label scores the whole graph, which can never be
 * strictly less than the start's own count.
 *
 * What it fixed (200,000 vertices, one edge each, `:A` on a tenth of them, audit item 232):
 *
 *     MATCH (a:A)-[:E]->(f) RETURN f.t     7.5ms    drives the 20,000-vertex `:A` bucket
 *     MATCH (f)<-[:E]-(a:A) RETURN f.t   130.2ms    drove all 200,000, same 20,000 rows
 *
 * 17.4x for one question written two ways, with no predicate anywhere in it. The second spelling
 * reads the START, which routes it to `filteredHopWalk` (`needsStart`), and that walk had no
 * far-driven option — where the first spelling reads the FAR end and takes the plain pair, whose
 * own dispatch happens to drive the labelled side.
 */
export const hopDrivesFar = (
  graph: Graph,
  startLabel: LabelExpr | undefined,
  farLabel: LabelExpr | undefined,
): boolean => candidateCount(graph, farLabel) < candidateCount(graph, startLabel);

/**
 * The mirror of `filteredHopWalk`'s general closure: it enumerates the FAR candidates and resolves
 * the START endpoint per edge, instead of the other way round.
 *
 * Its own closure, not a branch inside the other one, for the reason item 159 recorded about this
 * very function: a branch added to a hot inner loop cost the unfiltered shape 1.6x, and a SHARED
 * module-scope walk cost 1.29x because its call sites go polymorphic across compiles. This is
 * built per compile and holds one loop, which is what both effects want.
 *
 * `farPred` is checked INSIDE the edge loop even though `far` is fixed for the whole loop and the
 * predicate is element-local, so hoisting it would be free. It is not free in RAISES: a far vertex
 * reachable only from vertices that fail the START label is never reached by the start-driven walk,
 * so a `farPred` that faults on it must not fault here either. Checking it after the start-label
 * test keeps the set of evaluated (start, far) pairs identical to the walk this replaces.
 */
const farDrivenFilteredHopWalk = (w: {
  startLabel: LabelExpr | undefined;
  typeName: string;
  out: boolean;
  farVar: string;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
  farPred: CPredicate | undefined;
  gate: CompiledExpr | undefined;
  startVar: string | undefined;
}): ((graph: Graph, params: Params) => Row[]) => {
  const { startLabel, typeName, out, farVar, farLabel, proj, farPred, gate, startVar } = w;

  return (graph, params) => {
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();
    // The OPPOSITE index from the start-driven walk: for an `out` hop the far end is the edge's
    // TARGET, so the far endpoints are the keys of the reverse index.

    for (const far of candidateVertexSource(graph, farLabel)) {
      const bucket = (out ? far.adjTo : far.adjFrom)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      // `hopDrivesFar` only fires when the far count is STRICTLY smaller, which already implies a
      // seekable far label (`candidateCount` scores a non-simple one as the whole graph, and that
      // cannot be strictly less than the start's own count) — so this test should never fail. It
      // stays because the alternative is a silent wrong answer resting on that argument holding
      // somewhere else, and it is one comparison per far VERTEX.
      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
        continue;
      }

      binding.set(farVar, far);

      for (const edge of bucket) {
        const v: Vertex = out ? edge.from : edge.to;

        if (startLabel !== undefined && !matchesLabel(v, startLabel)) {
          continue;
        }

        if (startVar !== undefined) {
          binding.set(startVar, v);
        }

        if (farPred !== undefined && !satisfies(far, farPred, binding, params, graph)) {
          continue;
        }

        if (gate !== undefined && asTruth(gate({ binding, params, graph })) !== true) {
          continue;
        }

        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

const filteredHopWalk = (w: {
  /** See {@link detectHopProjection}'s own parameter — the order-sensitive fold's requirement. */
  forceStartDriven: boolean;
  startLabel: LabelExpr | undefined;
  typeName: string;
  out: boolean;
  farVar: string;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
  farPred: CPredicate | undefined;
  gate: CompiledExpr | undefined;
  startOnly: boolean;
  cstart: CNode | undefined;
  startVar: string | undefined;
  cfar: CNode | undefined;
}): RowsFn => {
  const { startLabel, typeName, out, farVar, farLabel, proj, farPred, gate, startVar, cfar } = w;
  const { startOnly, cstart, forceStartDriven } = w;
  // Built per compile, like the two walks below it, and consulted only by the general closure —
  // the START-ONLY walk already gates a vertex before reading its adjacency and seeds the start
  // through `hopSeek`, which is the good case this is for.
  const farDriven = farDrivenFilteredHopWalk({
    startLabel,
    typeName,
    out,
    farVar,
    farLabel,
    proj,
    farPred,
    gate,
    startVar,
  });

  // A START-ONLY predicate gets its own walk, which gates a vertex BEFORE reading its adjacency.
  // Its own closure rather than a branch in the loop below, for the reason item 159 recorded
  // about this very function: adding even a branch to a hot inner loop cost the unfiltered shape
  // 1.6x, and a shared module-scope walk cost 1.29x because its call sites go polymorphic across
  // compiles. A closure per compile is what both effects want.
  if (startOnly && gate !== undefined && startVar !== undefined) {
    return (graph, params) => {
      const rows: Row[] = [];
      const binding = new Map<string, unknown>();
      const env: EvalEnv = { binding, params, graph };
      // SEED, do not decline. This is what lets the start-only filter be carried at all: without
      // it the walk scans a whole label while the general path seeks (item 177's 3966us against
      // 49.6). `hopSeek` hands back a candidate set only when it is strictly narrower than the
      // label bucket, so an unindexed graph walks and pays nothing for asking.
      const seeded = hopSeek(graph, cstart, startLabel, env);

      for (const v of seeded ?? candidateVertexSource(graph, startLabel)) {
        // A seeded set is a SUPERSET — an index hint is a necessary condition, not a sufficient
        // one — so the label is re-checked, guarded on `seeded` so the bucket walk pays nothing.
        if (seeded !== undefined && !matchesLabel(v, startLabel)) {
          continue;
        }

        binding.set(startVar, v);

        // The PREDICATE FIRST, then the adjacency — which is the whole point of gating per
        // vertex. Reading the bucket first was the obvious order and it costs every rejected
        // vertex an `index.get(id)?.get(type)`: on 20,000 users with a selective filter that is
        // 19,999 adjacency lookups for one surviving start, and it measured 52ns a vertex
        // against 34ns for the bare node scan the same filter drives. `startOnlyHopCount` had
        // this right since item 164 — "the degree is now summed only for vertices the predicate
        // KEEPS" — and this is the same order with the same fault handling.
        try {
          if (asTruth(gate(env)) !== true) {
            continue;
          }
        } catch (e) {
          // Raise parity (items 139, 142, 144, 145): the general path evaluates a clause `WHERE`
          // once per COMPLETE match, so a start that yields no row never has it evaluated at
          // all. On a fault, decide whether the general path would have reached this vertex —
          // a non-empty bucket is necessary but not sufficient, since every far end may still
          // fail the far label or the far predicate. The happy path never enters this branch.
          const bucket = (out ? v.adjFrom : v.adjTo)?.get(typeName);

          if (
            bucket !== undefined &&
            anyFarMatches(graph, params, binding, bucket, { out, farVar, farLabel, farPred })
          ) {
            throw e;
          }

          continue;
        }

        const bucket = (out ? v.adjFrom : v.adjTo)?.get(typeName);

        if (bucket === undefined) {
          continue;
        }

        for (const edge of bucket) {
          const far: Vertex = out ? edge.to : edge.from;

          if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
            continue;
          }

          binding.set(farVar, far);

          if (farPred !== undefined && !satisfies(far, farPred, binding, params, graph)) {
            continue;
          }

          rows.push(projectRow(proj, binding, params, graph));
        }
      }

      return rows;
    };
  }

  return (graph, params) => {
    // DECLINE when the FAR end can seek an index, and let the general path answer.
    //
    // `carriedWhere` accepts a clause `WHERE` only if it reads the far variable, so this walk
    // takes precisely the filters it is worst at: a far-reading filter cannot reject a start
    // vertex before expanding it, and the end it constrains — the seekable one — is not the end
    // this walk drives. A filter reading only the START already declines here and reaches the
    // general path's seed, which is why that spelling was fast all along. Measured on 20,000
    // users, `name` indexed (audit item 177):
    //
    //   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name     3966.1us  <- this walk
    //   (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN u.name            3531.5us  <- this walk
    //   (x:User {name: $n})<-[:FOLLOWS]-(u) RETURN u.name              35.3us  <- general path
    //   (x:User) WHERE x.name = $n MATCH (u)-[:FOLLOWS]->(x) …         40.7us  <- general path
    //   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN x.name       49.6us  <- general path
    //
    // 97x between a query and the SAME query with its arrow flipped. Adding `LIMIT 1` also made
    // it fast (43.3us) for the same reason: the projection guard rejects a paged projection, so
    // the query fell through to the path that seeds.
    //
    // NARROWER BY A MARGIN, and the margin is measured rather than assumed. "Narrower than the
    // source" is the guard `hopSeek` and `buildNodeCount` use, and it is WRONG here: those
    // choose between two walks with the same per-element cost, while this chooses between a walk
    // that builds no rows and a path that builds one per match. The fused walk is FLAT in the
    // filter's selectivity (it visits every edge of the start source either way); the general
    // path costs about 1.2us per matched far vertex. 20,000 users, 40,000 edges, each spelling
    // forced both ways:
    //
    //   far matches   declining   fused walk
    //             2        43.4      3871.8   decline, 89x
    //            10        60.3      3897.0   decline, 65x
    //           100       187.4      3827.5   decline, 20x
    //          1000      1092.7      3970.4   decline, 3.6x
    //         10000     13998.5      4527.5   FUSED, 3.1x
    //
    // So the crossover is near 3,250 of 20,000 and a plain `narrowest < source` guard sends the
    // last row the wrong way — it was written that way first and measured 13430us against the
    // 4272 it replaced, a 3.1x REGRESSION on an indexed-but-unselective filter. Dividing by 8
    // puts the threshold at 2,500 for this source: inside the region where declining still wins
    // by 3.6x, and clear of the one where it loses.
    if (cfar !== undefined) {
      const env: EvalEnv = { binding: new Map<string, unknown>(), params, graph };
      let narrowest = Infinity;

      for (const candidate of indexCandidates(graph, cfar, env)) {
        narrowest = Math.min(narrowest, candidate.count);
      }

      if (narrowest * SEEK_MARGIN < candidateCount(graph, startLabel)) {
        return null;
      }
    }

    // Drive whichever end enumerates fewer vertices — a PER-CALL decision, since bucket sizes are
    // a runtime property of the graph, so the inner loop below pays nothing for the choice. One
    // early return rather than a restructuring, which keeps that loop byte-for-byte: item 159
    // measured 1.6x on the hot shape from adding even a branch inside it. See `hopDrivesFar`.
    if (!forceStartDriven && hopDrivesFar(graph, startLabel, farLabel)) {
      return farDriven(graph, params);
    }

    const rows: Row[] = [];
    const binding = new Map<string, unknown>();

    for (const v of candidateVertexSource(graph, startLabel)) {
      const bucket = (out ? v.adjFrom : v.adjTo)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      if (startVar !== undefined) {
        binding.set(startVar, v);
      }

      for (const edge of bucket) {
        const far: Vertex = out ? edge.to : edge.from;

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        binding.set(farVar, far);

        if (farPred !== undefined && !satisfies(far, farPred, binding, params, graph)) {
          continue;
        }

        if (gate !== undefined && asTruth(gate({ binding, params, graph })) !== true) {
          continue;
        }

        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

/**
 * Exactly one DISTINCT item, and nothing that needs the whole set in hand.
 *
 * ONE item is the load-bearing condition: the dedup key is then `valueKey` of that single
 * value, so a duplicate costs neither a row object nor a `rowKey`. With two items the row
 * itself is the key and there is nothing to save.
 */
/**
 * One projected item. Neither `ORDER BY` nor paging is refused here — both are decided together
 * in `sortOf`, which needs the projected expression to judge them, and paging is allowed ONLY
 * alongside an accepted sort (see the note there).
 */
const oneItemProjection = (proj: CProjection): boolean => !proj.star && proj.items.length === 1;

const distinctOneItem = (proj: CProjection): boolean =>
  proj.distinct && !proj.aggregating && oneItemProjection(proj);

/** Is a window present at all? Paging is only ever taken alongside an accepted sort. */
const hasWindow = (proj: CProjection): boolean =>
  proj.skip !== undefined || proj.limit !== undefined;

/**
 * The single `ORDER BY` key this walk can honour, or `'decline'`.
 *
 * Sorting a dedup by its OWN projected value is a sort of the ANSWER — at most as many rows as
 * the walk returns — so doing it afterwards is free, and the general path charged a full
 * materialize-and-sort of every input row for it:
 *
 *     MATCH (n:P) RETURN DISTINCT n.age AS a                 13.90ms
 *     MATCH (n:P) RETURN DISTINCT n.age AS a ORDER BY a     142.64ms   10.3x to sort 90 rows
 *
 * The two orders agree, and that is the whole argument for doing this: when the sort key IS the
 * projected value, every row in a dedup group shares the key, so the general path's
 * sort-then-dedup keeps the same representative (they are identical rows) and emits the groups in
 * key order — which is what dedup-then-sort gives. A sort key the projection does NOT carry is a
 * different question and declines: `RETURN DISTINCT n.age AS x ORDER BY n.name` sorts the INPUT
 * rows by name and dedupes after, which no post-sort of the output can reproduce.
 *
 * The key is accepted when it is the output column by name — which also covers an alias that
 * SHADOWS a pattern variable, since the output column wins there (`MATCH (a:P) RETURN DISTINCT
 * a.age AS a ORDER BY a` sorts by the age) — or when it is structurally the projected expression,
 * the `ORDER BY n.age` spelling of the same thing.
 *
 * Refused, each for its own measured reason:
 *
 *   - **more than one key.** The order cannot differ — the output rows are already distinct in
 *     the first key, so no tie exists for a later key to break — but a later key is still
 *     EVALUATED per row and can RAISE (`ORDER BY a, 1/0` throws), and a walk that never
 *     evaluates it would swallow that. The bound is raise parity.
 *   - **`SKIP`/`LIMIT` WITHOUT an `ORDER BY`.** The general path is LAZY there, and a `LIMIT`
 *     stops it after the first few distinct values: `RETURN DISTINCT n.age AS a LIMIT 5` is
 *     0.05ms against the walk's 13.90ms, because the walk scans the whole bucket. Taking that
 *     would be a ~280x REGRESSION, so an un-ordered window stays with the general path.
 *
 * With an accepted sort, paging IS taken (item 191): neither path can exit early once a sort is
 * in the way, and the general path charged a full materialize-and-sort of every input row for it
 * — `RETURN DISTINCT n.age AS a ORDER BY a LIMIT 5` was 138.83ms against the 14.11ms the same
 * query without the `LIMIT` already costs. The window is applied AFTER the sort, by the tally's
 * own `pageGroups`, and `pageIsEmpty` guards `LIMIT 0`: the general path returns `[]` from
 * `applyProjection` BEFORE projecting anything, so a walk that ran first and sliced after would
 * raise where the query does not — `LET a = 1/(n.n - 10) … LIMIT 0` is `[]` while the same query
 * at `LIMIT 1` raises.
 */
const sortOf = (
  proj: CProjection,
  projection: Projection,
  source: Expr,
): { descending: boolean; nullsFirst: boolean | undefined } | 'decline' | undefined => {
  const keys = projection.orderBy;

  if (keys === undefined || keys.length === 0) {
    // No sort, so no window either — an un-ordered page stays with the lazy general path for
    // the raise-parity reason above. The two decisions live together because they are one rule.
    return hasWindow(proj) ? 'decline' : undefined;
  }

  if (keys.length !== 1) {
    return 'decline';
  }

  const [key] = keys;
  const outName = proj.items[0].name;
  const isOutputColumn = key.expr.kind === 'var' && key.expr.name === outName;

  if (!isOutputColumn && !sameGroupingExpr(key.expr, source)) {
    return 'decline';
  }

  return { descending: key.descending, nullsFirst: key.nullsFirst };
};

/**
 * `RETURN count(DISTINCT <e>)` asks for the SIZE of the dedup the walk already builds, so it is
 * the same question with the rows thrown away — and it went through the general pipeline instead:
 *
 *     MATCH (n:P) RETURN DISTINCT n.age AS x            5.1ms
 *     MATCH (n:P) RETURN count(DISTINCT n.age) AS c    65.8ms     13x
 *     MATCH (a:P)-[:KNOWS]->(f) RETURN count(DISTINCT f.age)   847ms against the walk's 88ms
 *
 * The cost is the PIPELINE, not the aggregate: `count(*)` forced down the same path is 84.3ms
 * with no `map`, no `filter` and no dedup in it at all, which is MORE than the DISTINCT version.
 * So optimizing the fold would have bought nothing and the walk is the whole answer (item 196).
 *
 * Returns the ARGUMENT expression, which is what the walk evaluates — the item's own compiled
 * closure is the aggregate, and folds over a group this path never builds.
 */
const countDistinctArg = (proj: CProjection, projection: Projection): Expr | undefined => {
  if (
    proj.star ||
    proj.distinct ||
    proj.having !== undefined ||
    projection.groupBy !== undefined ||
    proj.items.length !== 1 ||
    proj.orderBy.length !== 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return undefined;
  }

  const e = projection.items[0].expr;

  // `count(DISTINCT e)` exactly: one argument, DISTINCT set, and not the `count(*)` star form —
  // which has its own shortcut and a different answer (it counts rows, not distinct values).
  if (e.kind !== 'func' || e.name !== 'count' || !e.distinct || e.star || e.args.length !== 1) {
    return undefined;
  }

  return e.args[0];
};

/**
 * `RETURN <k> GROUP BY <k>` with no aggregate IS `RETURN DISTINCT <k>` — one row per distinct
 * value of `k`, projecting `k`, in first-seen group order, which is the same first-seen order
 * `DISTINCT` keeps. So it can take the same walk, and it was not:
 *
 *     MATCH (n:P) RETURN DISTINCT n.k AS a               1.12ms
 *     MATCH (n:P) LET a = n.k RETURN a GROUP BY a        6.55ms
 *
 * 5.8x for the spelling ISO pushes you toward, since `GROUP BY` takes a BOUND NAME and a `LET`
 * is the only way to give the key one (audit item 188).
 *
 * Three conditions are load-bearing, not conservative:
 *
 *   - **exactly ONE grouping element.** `RETURN a GROUP BY a, b` yields one row per `(a, b)`
 *     pair, so the projected `a` REPEATS — that is not distinct and must not be rewritten.
 *   - **the projected item IS that element.** `RETURN b GROUP BY a` projects a representative
 *     row's `b`, which is not a dedup of anything.
 *   - **no `HAVING`.** It filters whole groups after aggregation, and the walk has no groups to
 *     filter. (`having` also forces `aggregating` on with no `GROUP BY` at all, which the
 *     one-element requirement already excludes.)
 */
const groupingIsDistinct = (proj: CProjection, projection: Projection): boolean => {
  if (!proj.aggregating || proj.distinct || proj.having !== undefined || !oneItemProjection(proj)) {
    return false;
  }

  const keys = projection.groupBy;

  if (keys?.length !== 1 || proj.items[0].isAgg) {
    return false;
  }

  return sameGroupingExpr(keys[0], projection.items[0].expr);
};

/** The far end named, and the relationship plain and unnamed (nothing to bind per edge). */
/**
 * The REL is plain, and its variable — if it has one — is read NOWHERE this shape covers.
 *
 * It used to demand that the far NODE be named too, and `distinctShape` demanded a named start,
 * which made two spellings of one question cost 17x apart: `MATCH (:Person)-[:KNOWS]->(b)
 * RETURN DISTINCT b.age` fell to the general path at 964 ms where the `(a:Person)` spelling took
 * the walk at 56 (item 485). Nothing can REFERENCE an unnamed end, so the name was never needed
 * for the end the projection does not read — the keyed end is named by the expression itself,
 * which `onStart`/`onFar` below already require.
 */
const plainUnnamedRel = (
  hop: { rel: { variable?: string } } | undefined,
  // Everything the walk would have to evaluate: the projection, the clause `WHERE`, and the
  // `LET` of the three-clause form. A mention in ANY of them declines.
  mentions: readonly (Projection | Expr | undefined)[],
): boolean => {
  if (hop === undefined) {
    return true;
  }

  if (!plainRel(hop.rel as never)) {
    return false;
  }

  const relVar = hop.rel.variable;

  // A rel VARIABLE nothing reads is servable: this walk never binds the edge, so the variable's
  // only effect would be through a read, and there is none. Refusing it outright made
  // `MATCH (:Person)-[r:KNOWS]->(b) RETURN DISTINCT b.age` cost 1050 ms where the same query
  // without the `r:` cost 55 — 19x for a name nobody uses (item 486). Item 485's mutation run
  // is what identified the guard as conservative: its mutant answered correctly everywhere.
  //
  // BELT-AND-BRACES, and measured as such. The check FIRES on five shapes (a projection,
  // `WHERE` or `LET` reading `r.w`, …) but every one of them is ALSO refused by the rules
  // below — `reads` must be exactly one end's variable, `whereReadsOnly` refuses a `WHERE`
  // naming anything else, and `sourceFor` refuses a `LET` the projection does not use. Dropping
  // this line passed all 72 DISTINCT tests, so it earns no test of its own; it stays because
  // this walk CANNOT bind an edge, and the cost of being wrong here is a silent wrong answer
  // rather than a slow one.
  //
  // It does NOT close item 444's subquery hole, and an earlier version of this comment claimed
  // it did: `mentionsName` does not look inside a subquery expression, which a probe showed
  // directly — `RETURN DISTINCT COUNT { MATCH (a)-[r:T]->(z) }` does not fire this check at all
  // and is refused somewhere else. Recording that rather than leaving a false reassurance.
  return relVar === undefined || mentions.every((m) => m === undefined || !mentionsName(m, relVar));
};

/** Does `where` read nothing but `only`? A name it does not recognize counts against it. */
const whereReadsOnly = (where: Expr | undefined, only: string): boolean => {
  if (where === undefined) {
    return true;
  }

  for (const name of freePredicateVars(where)) {
    if (name !== only) {
      return false;
    }
  }

  return true;
};

/**
 * The pieces `detectDistinctProjection` needs, or `null` if the shape does not fit. Split out
 * so the detector stays under the complexity gate — the same split `groupedClauses` has from
 * its own detector, and for the same reason.
 */
type DistinctShape = {
  /** Evaluates the projected value against the walked element. */
  evalFn: CReturnItem['fn'];
  /** The output column, which stays the RETURN item's name even when `evalFn` came from a `LET`. */
  outName: string;
  /** The expression `evalFn` was compiled from — what decides which end the walk visits. */
  source: Expr;
  keyedVar: string;
  onStart: boolean;
  startLabel: LabelExpr | undefined;
  farLabel: LabelExpr | undefined;
  adjacency: Adjacency | undefined;
  gatePred: CPredicate | undefined;
  /** A single `ORDER BY` over the projected value, applied to the walk's own output. */
  sort: { descending: boolean; nullsFirst: boolean | undefined } | undefined;
  /** `SKIP`/`LIMIT`, present only alongside a sort, applied AFTER it. */
  skip: CountValue | undefined;
  limit: CountValue | undefined;
};

/**
 * The lone `LET` of the three-clause form, resolved against its compiled twin — or `null` when
 * the shape is not `MATCH / LET / RETURN` with exactly one bound name.
 */
const soleLet = (
  mid: Clause | undefined,
  cmid: CClause | undefined,
): { var: string; expr: Expr; fn: CReturnItem['fn'] } | null => {
  // ONE item, and that bound is load-bearing rather than merely conservative: a `LET` may bind
  // the SAME name twice (`LET a = n.k, a = 1` is accepted and the LAST definition wins), so
  // resolving a projected name against `items[0]` would evaluate a definition that has been
  // overwritten. Relaxing this returns `n.k`'s values where the answer is `1` — and all 1098
  // gql tests pass while it does, which is why the bound carries this note (audit item 187).
  if (mid?.kind !== 'let' || mid.items.length !== 1 || cmid?.kind !== 'let') {
    return null;
  }

  const [item] = mid.items;
  const [citem] = cmid.items;

  return citem === undefined ? null : { var: item.var, expr: item.expr, fn: citem.expr };
};

/**
 * `MATCH [LET] RETURN` resolved to its three pieces, or `null`. Split out for the same reason
 * `distinctShape` itself was split from its detector: the complexity gate.
 *
 * Two clauses, or three with a single `LET`. `groupedClauses` already accepts both, for the
 * same reason: `GROUP BY` takes a BOUND NAME, so a `LET` is the only way ISO lets you name the
 * key, and a reader who has written one naturally writes the DISTINCT spelling the same way.
 * Measured, 200,000 nodes and 90 distinct values, spellings of ONE question:
 *
 *     RETURN DISTINCT n.age AS a                             11.91ms
 *     LET a = n.age RETURN a, count(*) AS c GROUP BY a        8.61ms
 *     LET a = n.age RETURN DISTINCT a                       108.17ms   <- this one
 *
 * 9.1x across spellings that must cost the same (audit item 187).
 */
const distinctHead = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
  mode: 'rows' | 'count',
): {
  m: Extract<Clause, { kind: 'match' }>;
  proj: CProjection;
  ret: Extract<Clause, { kind: 'return' }>;
  bound: ReturnType<typeof soleLet>;
  countArg: Expr | undefined;
} | null => {
  if (clauses.length !== 2 && clauses.length !== 3) {
    return null;
  }

  const three = clauses.length === 3;
  const [m, mid, last] = clauses;
  const ret = three ? last : mid;
  const cret = compiled[three ? 2 : 1];
  const bound = three ? soleLet(mid, compiled[1]) : null;

  if (three && bound === null) {
    return null;
  }

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return null;
  }

  if (cret?.kind !== 'return') {
    return null;
  }

  // `count` mode has its own single acceptor; `rows` mode takes either spelling of the same
  // question — an explicit `DISTINCT` over one item, or a `GROUP BY` with no aggregate whose one
  // projected item IS the grouping element.
  const countArg = mode === 'count' ? countDistinctArg(cret.projection, ret.projection) : undefined;

  if (mode === 'count') {
    if (countArg === undefined) {
      return null;
    }
  } else if (
    !(distinctOneItem(cret.projection) || groupingIsDistinct(cret.projection, ret.projection))
  ) {
    return null;
  }

  return { m, proj: cret.projection, ret, bound, countArg };
};

/**
 * What the walk evaluates per element.
 *
 * Under a `LET` it is the bound expression, already compiled. In `count` mode it is the
 * aggregate's ARGUMENT — `item.fn` there is the aggregate closure, which folds over a group this
 * path never builds. Otherwise it is the projected item itself.
 *
 * Its own function because `distinctShape` is at the complexity gate; the three cases are one
 * decision and belong together rather than spread through that function.
 */
/**
 * The expression the walk evaluates against each element, or `null` to decline.
 *
 * In `count` mode the projected item is the AGGREGATE; what reads the element is its argument,
 * and every rule from here on — which end is visited, the gate, the sort — applies to that
 * argument exactly as it would to a bare projection.
 *
 * Under a `LET` the projected item must be EXACTLY the bound name, and then the `LET`'s own
 * expression is the one that reads the element. Anything else declines: a projection mixing the
 * bound name with another read (`RETURN DISTINCT a + n.age`) is not one expression over one end,
 * and a projection that ignores the `LET` entirely keeps going to the general path — which is
 * also what `distinct-projection.test.ts` relies on, since its `viaGeneral` helper forces that
 * path by inserting a dead `LET _z = 1`.
 */
const sourceFor = (
  ret: Extract<Clause, { kind: 'return' }>,
  bound: ReturnType<typeof soleLet>,
  countArg: Expr | undefined,
): Expr | null => {
  const projExpr = countArg ?? ret.projection.items[0].expr;

  if (bound === null) {
    return projExpr;
  }

  return projExpr.kind === 'var' && projExpr.name === bound.var ? bound.expr : null;
};

/**
 * The property key when the walked expression is exactly `<keyedVar>.<key>`, else undefined.
 *
 * `evalFn` is the GENERIC compiled expression, so it reads its element back out of the binding:
 * `(env) => propOf(env.binding.get(variable), key)`. The walk has the element in hand, so that
 * costs a `Map.set` here and a `Map.get` inside the evaluator per vertex, purely to hand the
 * element over. For `RETURN DISTINCT n.age` — the overwhelmingly common shape, and the whole
 * `count distinct` / `top distinct values` / `distinct + order by` bench family — the value is
 * one property read and the binding is not otherwise wanted.
 *
 * Sound because `sourceFor` and `evaluatorFor` are exactly parallel: `source` IS the AST that
 * `evalFn` was compiled from, in all three of their cases (a bare projection, a `LET`-bound
 * expression, and a `count` argument). So for a `prop` over the keyed variable, `propOf(el, key)`
 * is the same call the generic path makes, with the same undefined-to-null coalescing.
 */
const directPropKey = (source: Expr, keyedVar: string): string | undefined =>
  source.kind === 'prop' && source.variable === keyedVar ? source.key : undefined;

const evaluatorFor = (
  item: CReturnItem,
  bound: ReturnType<typeof soleLet>,
  countArg: Expr | undefined,
): CReturnItem['fn'] => {
  if (bound !== null) {
    return bound.fn;
  }

  return countArg === undefined ? item.fn : compileExpr(countArg);
};

const distinctShape = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
  mode: 'rows' | 'count' = 'rows',
): DistinctShape | null => {
  const head = distinctHead(clauses, compiled, mode);

  if (head === null) {
    return null;
  }

  const { m, proj, ret, bound, countArg } = head;
  const [pattern] = m.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length > 1) {
    return null;
  }

  const { start } = pattern;
  const hop = pattern.segments.length === 1 ? pattern.segments[0] : undefined;
  const far = hop?.node;

  if (!plainUnnamedRel(hop, [ret.projection, m.where, bound?.expr])) {
    return null;
  }

  // May be `undefined` for an anonymous start: `onStart` below then cannot hold, so the shape
  // has to be keyed on the far end or decline.
  const startVar = start.variable;

  // In `count` mode the projected item is the AGGREGATE; what the walk evaluates is its
  // argument, and every rule below — the `LET` substitution, which end is read, the gate — then
  // applies to that argument exactly as it applies to a bare projection.
  const source = sourceFor(ret, bound, countArg);

  if (source === null) {
    return null;
  }

  const sort = sortOf(proj, ret.projection, source);

  if (sort === 'decline') {
    return null;
  }

  // The projected expression must read exactly ONE end, which is the element the walk
  // evaluates it against. A CONSTANT projection (no reads) dedupes to a single row and is
  // left to the general path rather than reasoned about with an empty binding.
  const reads = freePredicateVars(source);
  const onStart = startVar !== undefined && reads.size === 1 && reads.has(startVar);
  const onFar =
    hop !== undefined && reads.size === 1 && far?.variable !== undefined && reads.has(far.variable);

  if (!onStart && !onFar) {
    return null;
  }

  const keyedVar = onStart ? startVar : (far?.variable as string);
  const keyed = onStart ? start : (far as NonNullable<typeof far>);
  const other = onStart ? far : start;

  // The NON-keyed end is not visited by the evaluation, so it may carry nothing but a label.
  if (other !== undefined && !plainNode(other)) {
    return null;
  }

  if (!plainNode(keyed)) {
    return null;
  }

  // A clause `WHERE` reading only the keyed end is carried; anything else declines.
  const { where } = m;

  if (!whereReadsOnly(where, keyedVar)) {
    return null;
  }

  const gatePred = where === undefined ? undefined : compilePredicate(undefined, where);
  const startLabel = start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const [item] = proj.items;
  const evalFn = evaluatorFor(item, bound, countArg);

  const adjacency: Adjacency | undefined =
    hop === undefined
      ? undefined
      : { direction: hop.rel.direction, ...(hop.rel.label ? { label: hop.rel.label } : {}) };
  const farLabel = far?.label;

  // The column name comes from the RETURN item either way — the `LET` names a binding, not an
  // output column, so `LET a = n.age RETURN DISTINCT a` yields a column `a` and not `n.age`.
  return {
    evalFn,
    outName: item.name,
    source,
    keyedVar,
    onStart,
    startLabel,
    farLabel,
    adjacency,
    gatePred,
    sort,
    skip: proj.skip,
    limit: proj.limit,
  };
};

/**
 * `MATCH <node or 1-hop> RETURN DISTINCT <one expression over one end>` — dedupe by the
 * projected VALUE while walking, building a row only for each new one.
 *
 * ### Why
 *
 * `DISTINCT` is applied in `applyProjection` AFTER projection: every row is built, then
 * `rowKey`'d, then filtered. So a hop that yields 1,000,000 rows and 90 distinct values built
 * a million row objects and a million row keys to return ninety. Priced against native, which
 * this pass had never compared on the dedup family:
 *
 *     MATCH (a:Person)-[:KNOWS]->(x) RETURN DISTINCT x.age    ts 1153.3ms   native   7.4ms
 *     MATCH (n:Person) RETURN DISTINCT n.age                  ts  215.0ms   native   0.4ms
 *
 * A single projected item is the condition that makes this possible: the dedup key can then be
 * `valueKey` of the one value, so neither the row object nor `rowKey` is needed for a
 * duplicate. With two items the row itself is the key and nothing is saved, so it declines.
 *
 * Order is FIRST-SEEN in both paths — the general one keeps the first occurrence in stream
 * order, and a `Map`'s insertion order gives the same thing provided the walk meets elements
 * in the general path's order, which is `candidateVertices` then `expand` (item 142 had to
 * learn that the hard way, with a 7.4x given back for getting the order wrong).
 *
 * The filter is carried in the same change, per item 141's lesson, when it reads only the same
 * end as the projection.
 */
/** A simple directed single-type hop, resolved once per query. */
type DirectHop = { forward: boolean; type: string };

/**
 * The FAR-driven walk, and when it is allowed.
 *
 * `MATCH (a)-[:T]->(f) RETURN DISTINCT f.k` asks for the distinct `f.k` over every far vertex
 * REACHED. Walking edges costs one endpoint resolution each — ~180ns, measured as the whole of
 * the far-keyed dedup's remaining 284.5ms over a million edges (item 194). Asked from the far
 * end instead, a far vertex is reached exactly when it has at least one in-edge of the type, so
 * the question is one adjacency lookup per FAR VERTEX: 200,000 instead of 1,000,000, with the
 * property read and the dedup once per vertex rather than once per edge.
 *
 * Two conditions, and they are `farWalkFits`'s own (see `shortcuts.ts`), for the same reasons:
 *
 *   - **the START side must be unconstrained.** An in-edge says a far vertex is reached from
 *     SOME source; it cannot say the source matched a label. A vacuous start label — one every
 *     vertex carries — is the case where that distinction does not exist, and it is a RUNTIME
 *     property of the graph, so this is chosen per call exactly as the count walks are.
 * Item 195 ALSO required a sort, because the two walks meet elements in different orders and an
 * un-ordered query's row order was being treated as a contract. **That requirement is gone (item
 * 198), by decision**: row order without an `ORDER BY` is UNSPECIFIED in this engine, the same as
 * SQL without one — so the far walk may reorder an un-ordered dedup, and the tests that pinned
 * that order now compare as multisets and say why. A query WITH a sort is unaffected either way,
 * since the sort determines the order and ties are rows with the same single projected value.
 *
 * What this does NOT touch: the grouped count's FIRST-SEEN group order, which the code calls a
 * pinned contract both engines keep, and a sorted query's order. Only the row order of an
 * explicitly un-ordered dedup moved.
 *
 * What it does NOT need, unlike the counting twin: single-type edges. That twin sums bucket
 * SIZES, so an edge in two buckets would be counted twice; this one only asks whether a bucket
 * exists (audit item 195).
 */
const farDrivenFits = (
  graph: Graph,
  direct: DirectHop | undefined,
  onStart: boolean,
  startLabel: LabelExpr | undefined,
): boolean =>
  direct !== undefined && !onStart && (startLabel === undefined || vacuousLabel(graph, startLabel));

/**
 * Module scope, not inline in the returned closure, which is the hot one: this file has
 * measured a 1.17x cost on an UNRELATED shape from growing that closure (item 119). The
 * closure dispatches; the walks live out here.
 */
/**
 * Everything the two walks read off the SHAPE, bundled: it is computed once per query, and one
 * object beats threading eight arguments through both of them.
 */
type WalkPlan = {
  startLabel: LabelExpr | undefined;
  farLabel: LabelExpr | undefined;
  adjacency: Adjacency | undefined;
  direct: DirectHop | undefined;
  needsFar: boolean;
  onStart: boolean;
};

const walkFarSide = (graph: Graph, plan: WalkPlan, take: (el: Vertex) => void): void => {
  const { farLabel } = plan;
  const direct = plan.direct as DirectHop;
  // The MIRROR index of the start-driven walk's: an out-hop's edges arrive at the far vertex,
  // so they are in its IN-adjacency.

  for (const far of candidateVertexSource(graph, farLabel)) {
    const bucket = (direct.forward ? far.adjTo : far.adjFrom)?.get(direct.type);

    // A present bucket should never be empty — `deIndexEdgeLabel` drops the entry when its set
    // empties — but the size test keeps this path from depending on that invariant holding
    // somewhere else, and it is one property read per vertex.
    if (bucket === undefined || bucket.size === 0) {
      continue;
    }

    take(far);
  }
};

/**
 * The walk plan for ONE call, with `needsFar` decided against this graph.
 *
 * `needsFar` says whether the walk must RESOLVE the far endpoint — a string-keyed `Map.get`, ~190ns
 * (item 194). When the dedup is keyed on the START the far end is wanted for one reason only: to
 * test its LABEL. So a VACUOUS far label — one every vertex carries — makes the resolve pure waste,
 * and whether a label is vacuous is a RUNTIME property of the graph, which is why this is decided
 * per call exactly as the far-driven choice is (items 195, 198).
 *
 * Measured on 200,000 vertices at degree 5, `MATCH (f)<-[:KNOWS]-(a:Person) RETURN DISTINCT f.age`
 * against the FORWARD spelling of the same question, which takes the far-driven walk (item 215):
 *
 *     compile-time `needsFar`, no break        304ns an edge
 *     + break at the first qualifying edge     123ns
 *     + a vacuous far label skips the resolve   see the audit entry
 *     the forward spelling, for comparison      66ns an edge
 */
const planFor = (
  graph: Graph,
  w: {
    startLabel: LabelExpr | undefined;
    farLabel: LabelExpr | undefined;
    adjacency: Adjacency | undefined;
    direct: DirectHop | undefined;
    onStart: boolean;
  },
): WalkPlan => ({
  ...w,
  needsFar: !w.onStart || (w.farLabel !== undefined && !vacuousLabel(graph, w.farLabel)),
});

/**
 * Whether a START-keyed dedup is cheaper driven from the FAR end — and why this one needs a COST
 * PROBE where item 232's twin needed only two bucket sizes.
 *
 * Item 232 could compare vertex counts alone because a plain projection emits one row per edge, so
 * both walks visit the same qualifying edges and the edge term CANCELS. A dedup keyed on the start
 * does not: `walkStartSide` BREAKS at the first qualifying edge, so its edge term is sublinear and
 * workload-dependent. The adversarial case is real — 100 far vertices of degree 10,000 (1,000,000
 * incident edges) against 200,000 starts whose break fires on edge one (200,000 edge visits) — and
 * a bucket comparison would switch into it and be 2.5x WORSE.
 *
 * So the cost is measured instead of guessed, which keeps this inside item 223's rule (fire only on
 * a provable win):
 *
 *   - `|S|` — `candidateCount(startLabel)` — is a LOWER BOUND on the start-driven walk: every start
 *     candidate costs a bucket lookup even when it has no edges.
 *   - `|F| + E_F` is EXACTLY the far-driven walk: one lookup per far candidate plus one visit per
 *     incident edge of the type. Each `E_F` term is an O(1) adjacency `size` read, and it is work
 *     the far-driven walk pays anyway.
 *
 * **The early exit is what makes the probe safe**, not just tidy: it abandons as soon as the running
 * cost reaches `|S|`, so the probe can never spend more than the walk it is deciding against. In the
 * adversarial case it gives up after 200,000 increments and keeps the start-driven walk.
 *
 * `needsFar` is required because a FALSE one means the start-driven walk already asks one
 * `bucket.size` per start and reads no edges at all — already optimal, nothing to win.
 *
 * Measured (200,000 vertices, one edge each, `:Few` on a tenth — audit item 233):
 *
 *     MATCH (a:Few)-[:E]->(f) RETURN DISTINCT f.t     8.9ms   dedup keyed on the FAR end
 *     MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.t   111.4ms   keyed on the START, drove 200,000
 *
 * and the same asymmetry is in the general path, so declining the shortcut does not help: forcing
 * both queries off the fast path leaves them at 111.1 and 8.9.
 */
export const dedupDrivesFar = (graph: Graph, plan: WalkPlan): boolean => {
  const { direct, startLabel, farLabel, onStart, needsFar } = plan;

  if (direct === undefined || !onStart || !needsFar) {
    return false;
  }

  const starts = candidateCount(graph, startLabel);

  // The cheap precondition first, so the probe below is never paid where it cannot pay off. As in
  // item 232, `candidateCount` scores a label it cannot seed from as the whole graph, so this also
  // establishes that the far label has a bucket to enumerate.
  if (candidateCount(graph, farLabel) >= starts) {
    return false;
  }

  let cost = 0;

  for (const far of candidateVertexSource(graph, farLabel)) {
    cost += 1 + ((direct.forward ? far.adjTo : far.adjFrom)?.get(direct.type)?.size ?? 0);

    if (cost >= starts) {
      return false;
    }
  }

  return true;
};

/**
 * The FAR-driven walk for a START-keyed dedup: enumerate the far candidates, resolve the START
 * endpoint per edge, and offer THAT to the dedup.
 *
 * Not `walkFarSide`, which offers the FAR element and only asks whether its bucket exists — that
 * answers "which far vertices are reached" and is the `!onStart` question. This one answers "which
 * START vertices reach a qualifying far vertex", so it has to read the edges.
 *
 * `take` is offered the same start vertex once per qualifying edge rather than once, where the
 * start-driven walk breaks after one. That is sound because `take` is IDEMPOTENT for a dedup — the
 * value set keeps one entry per value, and the counting twin increments only for a value it has not
 * seen — and the extra calls are counted in the `E_F` term `dedupDrivesFar` compares. A gate is
 * likewise evaluated per edge instead of per vertex; it is pure, so the only observable is a RAISE,
 * which happens on the first evaluation either way.
 */
const walkFarSideResolvingStart = (
  graph: Graph,
  plan: WalkPlan,
  take: (el: Vertex) => void,
): void => {
  const { startLabel, farLabel } = plan;
  const direct = plan.direct as DirectHop;

  for (const far of candidateVertexSource(graph, farLabel)) {
    const bucket = (direct.forward ? far.adjTo : far.adjFrom)?.get(direct.type);

    if (bucket === undefined) {
      continue;
    }

    // Defensive, exactly as in item 232's mirror: `dedupDrivesFar`'s strict comparison already
    // implies a seekable far label, and this keeps a wrong answer from resting on that argument
    // holding elsewhere. One comparison per far VERTEX.
    if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
      continue;
    }

    for (const edge of bucket) {
      const v: Vertex = direct.forward ? edge.from : edge.to;

      // The START label is implicit in the start-driven walk's enumeration, so it has to be
      // applied HERE — and before `take`, which is where the gate runs: the start-driven walk
      // never gates a vertex its enumeration excluded.
      if (startLabel !== undefined && !matchesLabel(v, startLabel)) {
        continue;
      }

      take(v);
    }
  }
};

const walkStartSide = (graph: Graph, plan: WalkPlan, take: (el: Vertex) => void): void => {
  const { startLabel, farLabel, adjacency, direct, needsFar, onStart } = plan;

  // `candidateVertexSource`, not `candidateVertices`: the latter is a GENERATOR whose body is
  // `yield* graph.verticesById.values()`, so a whole-graph scan pays a generator frame and a
  // `.next()` per vertex to hand back the elements of an iterator it already had. The far-driven
  // walk has always used the direct source; this one did not, and that alone was the 1.6x between
  // two spellings of one question (audit item 217). Same elements, same order, same liveness —
  // both are single-use views over the same underlying iterator.
  for (const v of candidateVertexSource(graph, startLabel)) {
    if (adjacency === undefined) {
      take(v);

      continue;
    }

    if (direct !== undefined) {
      const bucket = (direct.forward ? graph.edgesFromByLabel : graph.edgesToByLabel)
        .get(v.id)
        ?.get(direct.type);

      if (bucket === undefined) {
        continue;
      }

      // When the dedup is keyed on the START and the far end needs no resolve, this bucket's
      // EMPTINESS is the entire question — so ask it the way the far-driven walk does, with a
      // `size` read rather than an iterator.
      //
      // Why the loop has nothing left to do here: `needsFar` false means `far` stays `v` for
      // every edge, so neither the label test nor `take` reads the edge, and item 215's `break`
      // leaves after the first one regardless. What remained was therefore a `Set` iterator
      // allocated per vertex to look at one element whose identity did not matter — 514ns a
      // vertex against the forward spelling's 313ns for the SAME question (audit item 217).
      //
      // The far LABEL test goes too, and that is most of the win rather than a tidy-up: it was
      // 189ns a vertex (494 against 305 for the unlabelled spelling of the same question), the
      // random-order element lookup this engine pays everywhere.
      //
      // It is unnecessary here, not merely cheap to skip. Under `onStart`,
      // `needsFar === (farLabel !== undefined && !vacuousLabel(graph, farLabel))`, so a FALSE
      // `needsFar` says the far label is either ABSENT or VACUOUS — and a vacuous label is one
      // every vertex in the graph carries, so the test cannot fail for any `v`. Either way there
      // is nothing left to ask but whether this vertex is reached at all.
      if (onStart && !needsFar) {
        if (bucket.size > 0) {
          take(v);
        }

        continue;
      }

      for (const edge of bucket) {
        // `v` when nothing reads the far end: the endpoint getters are a string-keyed
        // `Map.get` each, which is the ~190ns a far-keyed dedup pays per edge.
        let far = v;

        if (needsFar) {
          far = direct.forward ? edge.to : edge.from;
        }

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        take(onStart ? v : far);

        // STOP at the first qualifying edge when the dedup is keyed on the START. `take(v)` is
        // idempotent — the dedup keeps one entry per value, and the count variant increments only
        // for a value it has not seen — so every later edge of this vertex re-offers the SAME
        // element and can only repeat work. The bucket is walked at all because the OTHER end may
        // carry a label, and one passing edge already settles that this `v` is reached.
        //
        // What it costs without the break: `needsFar` is true whenever the far end has a label,
        // so each edge pays an endpoint resolution — a string-keyed `Map.get`, ~190ns (item 194) —
        // across every edge in the graph rather than one per vertex. Measured on 200,000 vertices
        // at degree 5, `MATCH (f)<-[:KNOWS]-(a:Person) RETURN DISTINCT f.age`:
        //
        //     before   304ns an edge   (1520ns a vertex)
        //     after     see audit item 215
        //
        // The forward spelling of the same question, `(a:Person)-[:KNOWS]->(f)` deduped on `f`,
        // takes the FAR-driven walk and costs 344ns a VERTEX — so this was a 4.4x gap between two
        // spellings of one query, which is the bug class this engine is named after.
        if (onStart) {
          break;
        }
      }

      continue;
    }

    for (const step of expand(graph, v, adjacency)) {
      if (farLabel !== undefined && !matchesLabel(step.node, farLabel)) {
        continue;
      }

      take(onStart ? v : step.node);
    }
  }
};

/**
 * `MATCH <node or 1-hop> RETURN count(DISTINCT <one expression over one end>)` — the SIZE of the
 * dedup the walk already builds, counted while walking so no row is ever materialized.
 *
 * Its own closure rather than a flag inside `detectDistinctProjection`'s, which is the hot one
 * (`ts-closure-size-is-load-bearing`); the SHAPE RULE is shared, which is what matters, since
 * two copies of one rule is how the far endpoint ended up on a per-edge tally once before.
 *
 * Two things differ from the rows path and both are answers this engine already gives:
 *
 *   - **NULLs do not count.** `count(DISTINCT n.k)` over `1, null, absent, 2, 1` is 2, where
 *     `RETURN DISTINCT n.k` is three rows including the null. So nulls are dropped before the
 *     set, and `count(DISTINCT n.missing)` is 0 rather than 1.
 *   - **the FAR-driven walk needs no sort.** Item 195 gated it on one because first-seen order
 *     is observable; a count has no order to observe, so only the vacuous-start condition
 *     applies here.
 */
export const detectDistinctCount = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  const shape = distinctShape(clauses, compiled, 'count');

  if (shape === null) {
    return null;
  }

  const { evalFn, outName, keyedVar, onStart, startLabel, farLabel, adjacency, gatePred } = shape;
  const direct: DirectHop | undefined =
    adjacency !== undefined && adjacency.direction !== 'both' && adjacency.label?.kind === 'label'
      ? { forward: adjacency.direction === 'out', type: adjacency.label.name }
      : undefined;
  const planParts = { startLabel, farLabel, adjacency, direct, onStart };
  // Same once-per-query decision as the rows path — see `directPropKey`.
  const directKey = directPropKey(shape.source, keyedVar);
  const needsBinding = gatePred !== undefined || directKey === undefined;

  return (graph, params) => {
    const seen = valueSet();
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    let n = 0;
    const take = (el: Vertex): void => {
      if (needsBinding) {
        binding.set(keyedVar, el);
      }

      if (gatePred !== undefined && !satisfies(el, gatePred, binding, params, graph)) {
        return;
      }

      const value = directKey === undefined ? evalFn(env) : propOf(el, directKey);

      // A null never counts, and it must not enter the set either — otherwise a later non-null
      // would be the second distinct value where it is the first.
      if (isNullish(value)) {
        return;
      }

      if (seen.add(value)) {
        n += 1;
      }
    };

    // THREE walks, chosen per call because every input is a runtime property of the graph. The
    // plan is built once here rather than per branch.
    const plan = planFor(graph, planParts);

    if (farDrivenFits(graph, direct, onStart, startLabel)) {
      walkFarSide(graph, plan, take);
    } else if (dedupDrivesFar(graph, plan)) {
      walkFarSideResolvingStart(graph, plan, take);
    } else {
      walkStartSide(graph, plan, take);
    }

    return [{ [outName]: n }];
  };
};

export const detectDistinctProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  const shape = distinctShape(clauses, compiled);

  if (shape === null) {
    return null;
  }

  const { evalFn, outName, keyedVar, onStart, startLabel, farLabel, adjacency, gatePred, sort } =
    shape;
  const { skip, limit } = shape;
  // Both read the SHAPE only, so they are decided once per query. `binding` is wanted by the
  // gate (which `satisfies` takes) and by the generic evaluator; when the value is a direct
  // property read and there is no gate, nothing reads it and the Map round-trip goes away.
  const directKey = directPropKey(shape.source, keyedVar);
  const needsBinding = gatePred !== undefined || directKey === undefined;
  // Both decided ONCE per query, out here rather than per call and certainly not per row: they
  // read the shape only. `expand` is kept for `both`, a type disjunction and an untyped hop.
  const direct: DirectHop | undefined =
    adjacency !== undefined && adjacency.direction !== 'both' && adjacency.label?.kind === 'label'
      ? { forward: adjacency.direction === 'out', type: adjacency.label.name }
      : undefined;
  const planParts = { startLabel, farLabel, adjacency, direct, onStart };

  return (graph, params) => {
    // `LIMIT 0` emits nothing and must not EVALUATE: the general path returns `[]` from
    // `applyProjection` before projecting anything, and the projected expression can fault
    // (`LET a = 1/(n.n - 10) … LIMIT 0` is `[]` while the same query at `LIMIT 1` raises).
    // Resolved per execution because a bound may be a `$param` — the tally's own rule, and its
    // own helper.
    if (pageIsEmpty(params, limit)) {
      return [];
    }

    // A `valueSet` rather than a `Map<string, Row>`: keying each element's value as a STRING was
    // 40ns of a ~50ns-a-vertex walk — 200,000 strings to find the handful of distinct values the
    // query returns (audit items 192, 193). `add` answers true for a NEW value, so the row is
    // built only then and the output array IS the answer, which also drops the
    // `[...seen.values()]` copy the map needed.
    const seen = valueSet();
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const take = (el: Vertex): void => {
      if (needsBinding) {
        binding.set(keyedVar, el);
      }

      if (gatePred !== undefined && !satisfies(el, gatePred, binding, params, graph)) {
        return;
      }

      const value = directKey === undefined ? evalFn(env) : propOf(el, directKey);

      if (seen.add(value)) {
        rows.push({ [outName]: value });
      }
    };

    // Which walk answers this? All three live at module scope; the closure only dispatches, and
    // every input to the choice is a runtime property of the graph.
    //
    //   `walkFarSide`              the dedup is keyed on the FAR end, so reachability is one
    //                              adjacency lookup per far VERTEX — see `farDrivenFits`.
    //   `walkFarSideResolvingStart` keyed on the START, but the far end is narrow enough that
    //                              enumerating it and resolving starts beats scanning the start
    //                              side — see `dedupDrivesFar`, which MEASURES that rather than
    //                              guessing it (audit item 233).
    //   `walkStartSide`            otherwise.
    const plan = planFor(graph, planParts);

    if (farDrivenFits(graph, direct, onStart, startLabel)) {
      walkFarSide(graph, plan, take);
    } else if (dedupDrivesFar(graph, plan)) {
      walkFarSideResolvingStart(graph, plan, take);
    } else {
      walkStartSide(graph, plan, take);
    }

    if (sort !== undefined) {
      // `compareSort` is the engine's own comparator, the one the general path's `cmp` calls per
      // key — so DESC, the NULLS placement and the engine default all behave identically here.
      // The rows are the ANSWER, so this sorts at most as many rows as it returns.
      rows.sort((a, b) => compareSort(a[outName], b[outName], sort.descending, sort.nullsFirst));
    }

    // AFTER the sort, which is the whole reason an un-ordered window is refused: a page over
    // first-seen order would be a different answer.
    return pageGroups(rows, params, skip, limit);
  };
};

/**
 * The same `MATCH` with its single hop's DIRECTION rewritten, or `null` when the pattern is not
 * a single hop. Used to serve an UNDIRECTED hop aggregate as two directed walks (item 478).
 *
 * WHY TWO WALKS AND NOT A WIDER ONE. The hop walks are specialized on `out: boolean` and index
 * `edgesFromByLabel` or `edgesToByLabel` directly; item 159 measured that adding even a branch
 * to that inner loop costs the hot unfiltered shape 1.6x. Running the existing walk twice costs
 * nothing it does not already cost per edge, and the second pass is exactly the work the hop
 * has to do anyway.
 *
 * It is sound ONLY for an aggregate. Two passes emit all out-rows then all in-rows, where the
 * general path interleaves them per start vertex — a different ROW order, which an
 * order-independent fold cannot see and a PROJECTION would expose. `foldFor`'s admission set is
 * exactly the folds that cannot see it (item 419), which is why this is wired into the
 * aggregate rungs and not into `detectHopProjection`.
 *
 * A SELF-LOOP sits in `edgesFromByLabel` AND `edgesToByLabel`, so two passes meet it twice
 * where `expand` yields it once: both engines answer `count(*) = 1` for
 * `MATCH (:A)-[:E]-(x)` over one, and the first version of this change answered 2.
 *
 * WHICH FOLDS CARE. Only the counting ones. `min`/`max` are IDEMPOTENT — a duplicated row
 * cannot change them, because the extremum of a multiset does not depend on multiplicity — so
 * an all-extremum aggregate is correct over a graph with loops and the restriction is lifted
 * for it (item 479). `count(*)` and `count(arg)` are not, so those keep the run-time decline on
 * `graph.selfLoopCount`. The distinction is worth having: item 478's version refused every
 * undirected aggregate on a graph with ONE loop, and `route-cost-probe`'s own fixture has 50.
 */
const withHopDirection = (m: Clause, direction: 'out' | 'in'): Clause | null => {
  if (m.kind !== 'match' || m.patterns.length !== 1) {
    return null;
  }

  const [pattern] = m.patterns;

  if (pattern.segments.length !== 1) {
    return null;
  }

  const [seg] = pattern.segments;

  return {
    ...m,
    patterns: [{ ...pattern, segments: [{ ...seg, rel: { ...seg.rel, direction } }] }],
  };
};

/**
 * The row producers for one hop aggregate: one walk for a directed hop, TWO for an undirected
 * one. `null` when any of them declines the shape.
 */
const hopAggregateWalks = (
  m: Clause,
  synthRet: Clause,
  cm: CClause,
  synthCret: CClause,
  direction: string,
  opts: {
    // Is every admitted fold IDEMPOTENT (`min`/`max`)? Then a self-loop met twice changes
    // nothing and the two walks are safe on any graph.
    readonly idempotent: boolean;
    /** Force the start-driven walk, for an order-sensitive fold (item 551). */
    readonly forceStartDriven: boolean;
  },
): { walks: RowsFn[]; noSelfLoops: boolean; looped: RowsFn | undefined } | null => {
  const { idempotent, forceStartDriven } = opts;

  if (direction !== 'both') {
    const one = detectHopProjection([m, synthRet], [cm, synthCret], forceStartDriven);

    return one === null ? null : { walks: [one], noSelfLoops: false, looped: undefined };
  }

  // The SINGLE undirected walk item 480 added, which handles a self-loop itself. It is the
  // fallback rather than the default because the two turned walks can each be FAR-DRIVEN when
  // the start label is vacuous, and two far-driven passes beat one start-driven pass: measured
  // 118 ns a row against 375 at 200,000 nodes / 1,000,000 edges (item 481).
  const looped = detectHopProjection([m, synthRet], [cm, synthCret]) ?? undefined;
  const walks: RowsFn[] = [];

  for (const dir of ['out', 'in'] as const) {
    const turned = withHopDirection(m, dir);
    const walk = turned === null ? null : detectHopProjection([turned, synthRet], [cm, synthCret]);

    if (walk === null) {
      return looped === undefined ? null : { walks: [looped], noSelfLoops: false, looped };
    }

    walks.push(walk);
  }

  return { walks, noSelfLoops: !idempotent, looped };
};

/**
 * `MATCH (a:L)-[:T]->(b) RETURN max(b.k)` — a FOLDABLE aggregate over exactly the rows
 * `detectHopProjection` already walks, folded as they are produced instead of grouped.
 *
 * Why this is a separate detector and not a condition inside that one: the fused hop path
 * refuses `proj.aggregating` outright, and the general path then walks the hop with a `Binding`
 * Map per row. Measured at 200,000 vertices / 800,000 edges, min of 3 (audit item 418):
 *
 *     MATCH (a:P)-[:E]->(b) RETURN max(b.k)    718ms    the general grouping path
 *     MATCH (a:P)-[:E]->(b) RETURN min(b.k)    725ms    same, so it is per-ROW machinery
 *     MATCH (a:P)-[:E]->(b) RETURN b.k         115ms    the SAME rows, fused walk
 *
 * 6.3x for the same traversal, with the aggregate adding one `compareValues` per row to a path
 * that already streams (item 377's `foldedAggs` folds per row — the cost is upstream of it, in
 * producing the rows at all).
 *
 * It REUSES `detectHopProjection` rather than growing a fourth walk: the aggregate's argument
 * becomes a synthetic one-item projection, the proven walk produces those values as rows, and
 * the fold runs over them here. Item 159 measured that a branch added to one of those inner
 * loops costs the hot unfiltered shape 1.6x and that a shared module-scope walk costs 1.29x, so
 * a new walk is the expensive way to buy this; the row objects it leaves on the table are the
 * price of not paying that.
 *
 * The admission is narrow on purpose:
 *
 *   - ONE projection item, and it must BE the aggregate — not `max(b.k) + 1`, whose outer
 *     expression needs the folded value substituted back into a group view.
 *   - ONE foldable aggregate (`foldedAggs`, so `min`/`max`/`count(arg)`; `count(*)` has its own
 *     O(groups) path and `sum`/`avg` are not folds here — `temporalSum` and the numeric faults
 *     need the whole group).
 *   - No GROUP BY, no HAVING, no DISTINCT, no ORDER BY, no paging: every one of those wants the
 *     groups this path never builds.
 *
 * Two of those guards are REDUNDANT today and kept deliberately, which the mutation run made
 * explicit: removing `groupKeys.length !== 0` leaves every test green, because `groupKeys` holds
 * the NON-aggregate items and `items.length === 1` over an item that IS the aggregate already
 * forces it empty — and the explicit `GROUP BY` it would otherwise guard is refused on the AST
 * a few lines down. It stays because the implication runs through `compileProjection`, not
 * through anything local. A mutant that survives because it is equivalent is not a missing
 * test; a mutant that survives because nothing looks is, and the identity check below was one
 * until `abs(min(b.k) - 10)` was added to the refusal table.
 *
 * `fold.finish` over an untouched accumulator is what gives an EMPTY match its one row holding
 * null, which is what an ungrouped aggregate owes ISO — and it is the same `finish` the general
 * path calls, so the two cannot drift.
 */
/**
 * The single projected item as a well-formed PERCENTILE, or `null`.
 *
 * Deliberately narrow: `percentile_cont`/`percentile_disc` are the only aggregates with no
 * streaming fold that are ORDER-INDEPENDENT, which is what item 419's rule requires of anything
 * riding the hop walk. See `detectHopAggregate` for why the other four non-foldable names stay
 * refused, and item 532 for what they cost.
 *
 * THE NAME CHECK'S MUTANT SURVIVES, and the explanation is the point. Admitting `collect` here
 * changes no answer on a four-node fixture with crossed edges (`s1 -> t2`, `s2 -> t1`), because
 * the walk only goes FAR-DRIVEN under conditions a fixture that small does not meet — so the two
 * routes agree and the order hazard never shows. That is exactly why item 419 is a RULE and not
 * a test: the shape that would expose it depends on a planner choice, not on the query. The
 * `DISTINCT` check beside it does have teeth (item 533).
 */
/**
 * The aggregates with no streaming fold whose answer DOES depend on the row order (item 551).
 *
 * `sum`/`avg` and the two stddevs because float addition is not associative — a different order
 * is a different last ulp, against a hard byte-identity invariant. `collect`/`collect_list`
 * because the order IS the answer. Each may still ride the walk, but only the START-DRIVEN one,
 * whose order is the general path's — see {@link detectHopProjection}'s `forceStartDriven`.
 */
/** The two ordered-set aggregates, which sort their values and so read no row order. */
const PERCENTILES: ReadonlySet<string> = new Set(['percentile_cont', 'percentile_disc']);

const ORDER_SENSITIVE_AGGREGATES: ReadonlySet<string> = new Set([
  'sum',
  'avg',
  'collect',
  'collect_list',
  'stddev_pop',
  'stddev_samp',
]);

const hopPercentile = (
  ret: Clause,
): { name: string; frac: number; orderSensitive: boolean } | null => {
  if (ret.kind !== 'return' || ret.projection.items.length !== 1) {
    return null;
  }

  const [only] = ret.projection.items;
  const e = only.expr;

  if (e.kind !== 'func' || e.star || e.distinct) {
    return null;
  }

  if (ORDER_SENSITIVE_AGGREGATES.has(e.name)) {
    return e.args.length === 1 ? { name: e.name, frac: 0, orderSensitive: true } : null;
  }

  if (e.name !== 'percentile_cont' && e.name !== 'percentile_disc') {
    return null;
  }

  const frac = percentileFraction(e);

  return frac === null ? null : { name: e.name, frac, orderSensitive: false };
};

export const detectHopAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;
  const folded = proj.foldedAggs;
  // A PERCENTILE over the walk (item 533). `foldedAggs` carries nothing for an aggregate with no
  // streaming fold, so without this the shape fell to the general path, which materializes a
  // `Binding` per EDGE: `percentile_cont(b.age, 0.5)` cost 742.6 ms at 200,000 vertices /
  // 1,000,000 edges against the 155.8 this rung delivers for `max`.
  //
  // ONLY the percentiles, and the reason is item 419's rule rather than convenience: the walk
  // may be FAR-DRIVEN, so it can visit rows in a different order from the general path, and only
  // an ORDER-INDEPENDENT aggregate may ride it. `percentile_of` SORTS its values before using
  // them, so the order they arrived in cannot be observed. `sum`/`avg` and the two `stddev`s are
  // order-sensitive in the last ulp (float addition is not associative) and `collect`'s order IS
  // its answer — all four stay refused, and item 532 is where that is priced rather than guessed.
  //
  // The NaN hazard that would break the sort's order-independence (a comparator mapping
  // incomparable values to `Equal`) cannot arise: the numeric model turns a non-finite into
  // `null` on ingest, every non-finite expression result is `null` too, and the non-null filter
  // below drops those.
  const pct = folded === undefined || folded.length === 0 ? hopPercentile(ret) : null;

  if (
    (folded?.length !== 1 && pct === null) ||
    proj.star ||
    proj.items.length !== 1 ||
    proj.groupKeys.length !== 0 ||
    proj.having !== undefined ||
    !sortsOnOutputOnly(ret, proj) ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  // An explicit `GROUP BY` is checked on the AST as well as through `groupKeys`. An earlier
  // version of this comment justified it by saying the keys are empty for a `GROUP BY` over a
  // name the binding does not carry; that is wrong, and item 420's mutation run found it.
  // `compileProjection` sets `groupKeys` to the compiled GROUP BY expressions whenever any are
  // written, so the compiled check already catches them all. The AST check stays because the
  // synthetic projection below sets `groupBy: undefined`, which hides a GROUP BY from every
  // guard further down — this is the last place that can see one.
  if (ret.projection.groupBy !== undefined) {
    return null;
  }

  const [item] = ret.projection.items;
  const agg = folded?.[0];

  // The item must BE the aggregate node, by identity — `collectAggregates` finds one nested in
  // `max(b.k) + 1` just the same, and that shape needs the group view. The percentile path
  // checks the same thing inside `hopPercentile`, which matched the item itself.
  if (agg !== undefined && item.expr !== agg.expr) {
    return null;
  }

  const aggNode = item.expr;

  // `percentileFraction` answers 0 for a one-argument aggregate and `null` for a malformed
  // percentile; the order-sensitive names reach here through `pct` and are already validated by
  // `hopPercentile`, so they are admitted alongside it rather than by a second parse.
  if (aggNode.kind !== 'func' || (percentileFraction(aggNode) === null && pct === null)) {
    return null;
  }

  const [argExpr] = aggNode.args;
  const outName = proj.items[0].name;
  // A name no GQL identifier can collide with: the synthetic column is read back by key below.
  const VALUE_COL = ' hopagg';

  const synthRet: Clause = {
    ...ret,
    projection: {
      ...ret.projection,
      items: [{ expr: argExpr, alias: VALUE_COL }],
      distinct: false,
      groupBy: undefined,
      having: undefined,
      orderBy: undefined,
      skip: undefined,
      limit: undefined,
    },
  };
  // The compiled twin, built rather than recompiled: `argFn` is the argument closure
  // `compileProjection` already lowered for the fold, so the expression is compiled once for
  // both paths and the fast path cannot evaluate a differently-compiled argument.
  const synthCret: CClause = {
    ...cret,
    projection: {
      star: false,
      distinct: false,
      aggregating: false,
      countedGroups: false,
      // `agg.argFn` is the closure `compileProjection` already lowered for the fold, so the
      // expression is compiled once for both paths. A percentile has no fold and so no
      // `argFn`; it gets `compileExpr` on the SAME AST node the general path compiles, which
      // is identical by construction rather than by replication.
      items: [
        {
          name: VALUE_COL,
          fn: agg?.argFn ?? compileExpr(argExpr),
          isAgg: false,
        },
      ],
      // FALSE conservatively. The field licenses skipping a projection without evaluating it
      // (item 427), and nothing on this path pages — `detectHopProjection` refuses a `skip` or a
      // `limit` outright — so the value is unobservable here and the safe one costs nothing.
      cannotFault: false,
      groupKeys: [],
      groupKeyNames: [],
      orderBy: [],
      orderNeedsOutput: false,
    },
  };

  // ONE walk for a directed hop, TWO for an undirected one — see `withHopDirection` for why
  // that is sound here and not in the projection twin. An undirected `count(b.age)` measured
  // 1450 ms against the directed 150 at 200,000 nodes / 1,000,000 edges (item 478), because the
  // whole hop family refuses `both` and the query fell to the general path.
  // The hop's own direction, read from the AST: `detectHopProjection` validates the rest of the
  // shape, and an `undefined` here simply means "not a single hop", which it will refuse.
  const hopDir =
    m.kind === 'match' && m.patterns.length === 1 && m.patterns[0].segments.length === 1
      ? m.patterns[0].segments[0].rel.direction
      : 'out';
  // A percentile is NOT idempotent — a value counted twice moves it — so the two turned walks
  // are only safe on a graph with no self-loop, which is what `false` here asks for.
  // An ORDER-SENSITIVE fold may ride only the START-driven walk, and only a DIRECTED hop: the
  // undirected form runs two walks (all out-rows then all in-rows) where the general path
  // interleaves them per start vertex, which is a different order by construction.
  const orderSensitive = pct?.orderSensitive === true;

  if (orderSensitive && hopDir === 'both') {
    return null;
  }

  const turned = hopAggregateWalks(m, synthRet, cm, synthCret, hopDir, {
    idempotent: EXTREMA.has(aggNode.name),
    forceStartDriven: orderSensitive,
  });

  if (turned === null) {
    return null;
  }

  const { walks, noSelfLoops, looped } = turned;
  const fold = agg?.fold;

  return (graph, params) => {
    // A self-loop would be met by BOTH turned walks; `expand` yields it once. The single
    // undirected walk handles that itself, so a looped graph switches to it instead of
    // declining — chosen per CALL, which costs the row loop nothing (item 481).
    const chosen = noSelfLoops && graph.selfLoopCount !== 0 ? looped : undefined;

    if (chosen === undefined && noSelfLoops && graph.selfLoopCount !== 0) {
      return null;
    }

    const chosenWalks = chosen === undefined ? walks : [chosen];

    // TWO loops, branched ONCE on which path this is, rather than one loop with the branch
    // inside it — so the fold path's inner loop is unchanged from before this item.
    //
    // NO perf claim attached, and the reason is worth keeping: the single-loop version READ as a
    // 1.02-1.23x regression on the fold control (`max(b.age)` 125.7-127.5 ms before against
    // 129.0-156.8 after, non-overlapping at the bottom over three alternated rounds), and a
    // SECOND A/B after the split refuted it — before 141.4 / 160.1 / 146.9, after
    // 179.2 / 161.3 / 125.8, overlapping and non-monotonic. This row is bimodal ACROSS BUILDS
    // (125-180 for the same source), so three alternated rounds can read disjoint by luck.
    // The split stays because one loop per path is clearer, not because it was measured faster
    // (item 533).
    if (fold === undefined) {
      const values: unknown[] = [];

      for (const walk of chosenWalks) {
        const rows = walk(graph, params);

        if (rows === null) {
          return null;
        }

        for (const row of rows) {
          const v = row[VALUE_COL];

          if (!isNullish(v)) {
            values.push(v);
          }
        }
      }

      return [{ [outName]: aggregateOverValues(pct!.name, values, pct!.frac) }];
    }

    let acc = fold.init();

    for (const walk of chosenWalks) {
      const rows = walk(graph, params);

      // A DECLINE from the walk is a decline from here too: the general path has a better plan.
      if (rows === null) {
        return null;
      }

      for (const row of rows) {
        const v = row[VALUE_COL];

        // The array path folds over the non-null values and the streaming step skips nullish
        // the same way; this is the third place that rule lives, so it reads the same as both.
        if (!isNullish(v)) {
          acc = fold.step(acc, v);
        }
      }
    }

    return [{ [outName]: fold.finish(acc) }];
  };
};

/**
 * The IDEMPOTENT aggregates: folding a value twice gives the same answer as folding it once,
 * because the extremum of a multiset does not depend on multiplicity. That is what lets an
 * undirected hop be served as two walks over a graph that HAS self-loops (item 479).
 */
const EXTREMA = new Set(['min', 'max']);

/** One projected aggregate's accumulator in the MULTI-aggregate hop path (item 472). */
type HopAcc =
  | { readonly kind: 'rows'; readonly out: string }
  | { readonly kind: 'fold'; readonly out: string; readonly fold: AggFold; readonly col: string }
  // An aggregate with NO streaming fold — the four order-sensitive ones and the two percentiles
  // (item 552). It collects the column's non-null values and hands them to the same
  // `aggregateOverValues` the general path runs, which is what the single-aggregate twin's
  // non-foldable branch already does.
  | {
      readonly kind: 'values';
      readonly out: string;
      readonly col: string;
      readonly name: string;
      readonly frac: number;
    };

/**
 * One projected aggregate's accumulator on the MULTI-aggregate hop rung, or `null` to decline.
 *
 * Extracted from `detectMultiHopAggregate`'s item loop, which item 552 pushed past the
 * complexity gate: the decision is per ITEM and reads nothing from the loop but the column
 * index, so it separates cleanly. `collects` is the non-foldable admission — the four
 * order-sensitive names (which then force the start-driven walk, item 551) and the two
 * percentiles, which read no order and so need no forcing. Anything else without a fold
 * declines.
 */
const hopAccFor = (
  e: Extract<Expr, { kind: 'func' }>,
  out: string,
  col: string,
): { acc: HopAcc; extremum: boolean; orderSensitive: boolean } | null => {
  if (e.distinct) {
    return null;
  }

  if (e.star) {
    return e.name === 'count' && e.args.length === 0
      ? { acc: { kind: 'rows', out }, extremum: false, orderSensitive: false }
      : null;
  }

  const fold = e.args.length === 1 ? foldFor(e.name, false, false) : undefined;

  if (fold !== undefined) {
    return {
      acc: { kind: 'fold', out, fold, col },
      extremum: EXTREMA.has(e.name),
      orderSensitive: false,
    };
  }

  const frac = percentileFraction(e);
  const sensitive = ORDER_SENSITIVE_AGGREGATES.has(e.name);

  if (frac === null || !(sensitive ? e.args.length === 1 : PERCENTILES.has(e.name))) {
    return null;
  }

  return {
    acc: { kind: 'values', out, col, name: e.name, frac },
    extremum: false,
    orderSensitive: sensitive,
  };
};

/**
 * The same walk under TWO OR MORE foldable aggregates — `RETURN count(*), max(b.k)`.
 *
 * WHY THIS EXISTS. `detectHopAggregate` refuses `proj.items.length !== 1`, so a pair fell to the
 * general path exactly as the scan pair did before item 469 — and on a hop that is the expensive
 * one, because the general path materializes a `Binding` per EDGE. Measured at 200,000 nodes
 * over 1,000,000 edges (item 472): `max(b.age)` alone 153 ms, `count(*), max(b.age)` **668**,
 * `min(b.age), max(b.age)` 655.
 *
 * The admission set is `foldFor`'s, UNCHANGED and for item 419's reason: the far-driven walk may
 * visit rows in a different order from the general path, so only an order-INDEPENDENT aggregate
 * may ride it. `count`/`min`/`max` qualify; `sum`/`avg` do not and are refused here even though
 * item 468 admits them on an unfiltered SCAN, where there is no far-driven alternative.
 * `count(*)` is a row counter needing no projected column.
 */
export const detectMultiHopAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  // `< 2` leaves the one-item shapes to `detectHopAggregate`, which runs first: the two rungs
  // are disjoint by ARITY, so this cannot regress the shape that one claims.
  if (
    proj.star ||
    proj.items.length < 2 ||
    proj.groupKeys.length !== 0 ||
    proj.having !== undefined ||
    !sortsOnOutputOnly(ret, proj) ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    ret.projection.groupBy !== undefined
  ) {
    return null;
  }

  // `foldedAggs` carries an argument closure `compileProjection` already lowered; reusing it
  // keeps one compilation per expression. It is absent whenever any item is a `count(*)`
  // (`foldFor` refuses a star), which is why the fallback compiles the argument here.
  const lowered = new Map<object, CompiledExpr>();

  for (const a of proj.foldedAggs ?? []) {
    lowered.set(a.expr, a.argFn);
  }

  const accs: HopAcc[] = [];
  const synthItems: { expr: Expr; alias: string }[] = [];
  const synthCols: CReturnItem[] = [];
  // Every item an extremum? Then a self-loop met twice changes nothing — see `EXTREMA`. A
  // `count(*)` row counter is NOT one, so one of those re-arms the self-loop decline.
  let allExtrema = true;
  // Does any item read the row ORDER? Then the walk must be the start-driven one (item 551).
  let orderSensitive = false;

  for (const [i, item] of ret.projection.items.entries()) {
    const e = item.expr;
    const out = proj.items[i].name;

    if (e.kind !== 'func') {
      return null;
    }

    const col = ` hopagg${i}`;
    const slot = hopAccFor(e, out, col);

    if (slot === null) {
      return null;
    }

    accs.push(slot.acc);
    allExtrema = allExtrema && slot.extremum;
    orderSensitive = orderSensitive || slot.orderSensitive;

    if (slot.acc.kind === 'rows') {
      continue;
    }

    const [argExpr] = e.args;

    synthItems.push({ expr: argExpr, alias: col });
    synthCols.push({ name: col, fn: lowered.get(e) ?? compileExpr(argExpr), isAgg: false });
  }

  // All-`count(*)` projects nothing, and the walk needs an item to produce.
  if (synthItems.length === 0) {
    return null;
  }

  const synthRet: Clause = {
    ...ret,
    projection: {
      ...ret.projection,
      items: synthItems,
      distinct: false,
      groupBy: undefined,
      having: undefined,
      orderBy: undefined,
      skip: undefined,
      limit: undefined,
    },
  };
  const synthCret: CClause = {
    ...cret,
    projection: {
      star: false,
      distinct: false,
      aggregating: false,
      countedGroups: false,
      items: synthCols,
      // FALSE conservatively, for the reason the single-aggregate twin gives: nothing here
      // pages, so the field is unobservable and the safe value costs nothing.
      cannotFault: false,
      groupKeys: [],
      groupKeyNames: [],
      orderBy: [],
      orderNeedsOutput: false,
    },
  };
  // One walk for a directed hop, TWO for an undirected one — the same arrangement item 478
  // gave the single-aggregate twin, sound for the same reason: every admitted fold is
  // order-independent, so two passes emitting out-rows then in-rows cannot be told from the
  // general path's interleaving.
  const hopDir =
    m.kind === 'match' && m.patterns.length === 1 && m.patterns[0].segments.length === 1
      ? m.patterns[0].segments[0].rel.direction
      : 'out';

  // The undirected form runs two walks (all out-rows then all in-rows) where the general path
  // interleaves them per start vertex, so no flag can make that order the general path's.
  if (orderSensitive && hopDir === 'both') {
    return null;
  }

  const turned = hopAggregateWalks(m, synthRet, cm, synthCret, hopDir, {
    idempotent: allExtrema,
    forceStartDriven: orderSensitive,
  });

  if (turned === null) {
    return null;
  }

  const { walks, noSelfLoops, looped } = turned;

  return (graph, params) => {
    // See the single-aggregate twin: two walks meet a self-loop twice, and the single
    // undirected walk does not.
    const chosen = noSelfLoops && graph.selfLoopCount !== 0 ? looped : undefined;

    if (chosen === undefined && noSelfLoops && graph.selfLoopCount !== 0) {
      return null;
    }

    const state = accs.map((a) => {
      if (a.kind === 'fold') {
        return a.fold.init();
      }

      return a.kind === 'values' ? [] : undefined;
    });
    let n = 0;

    for (const walk of chosen === undefined ? walks : [chosen]) {
      const rows = walk(graph, params);

      // A DECLINE from the walk is a decline from here: the general path has a better plan.
      if (rows === null) {
        return null;
      }

      for (const row of rows) {
        n += 1;

        // An INDEX loop rather than `accs.entries()`, which allocates a tuple per accumulator
        // per row — item 469 measured that at 40-55% of a multi-aggregate scan's cost.
        for (let i = 0; i < accs.length; i += 1) {
          const a = accs[i];

          if (a.kind === 'rows') {
            continue;
          }

          const v = row[a.col];

          if (isNullish(v)) {
            continue;
          }

          if (a.kind === 'values') {
            (state[i] as unknown[]).push(v);
          } else {
            state[i] = a.fold.step(state[i], v);
          }
        }
      }
    }

    const out: Row = {};

    for (let i = 0; i < accs.length; i += 1) {
      const a = accs[i];

      if (a.kind === 'rows') {
        out[a.out] = n;
      } else if (a.kind === 'values') {
        out[a.out] = aggregateOverValues(a.name, state[i] as unknown[], a.frac);
      } else {
        out[a.out] = a.fold.finish(state[i]);
      }
    }

    return [out];
  };
};
