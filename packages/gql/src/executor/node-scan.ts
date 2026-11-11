/**
 * THE NODE-SCAN RUNGS: answering a query whose whole pattern is one node, without the matcher.
 *
 * Five detectors — projection, aggregate, multi-aggregate, grouped aggregate, grouped count — plus
 * the machinery only they can reach: the scan gate and its predicates, the top-k and
 * deferred-sort routes, and the multi-accumulator fold.
 *
 * ⚠️ FIVE DETECTORS IN ONE MODULE BECAUSE OWNERSHIP SAYS SO, not because their names rhyme (item
 * 1669). Measured before moving: of the 30 symbols here, 25 are reachable from these five entry
 * points and from NO other detector in the file. Taken individually they look unrelated —
 * `detectNodeProjection` has no private machinery at all while `detectNodeAggregate` has 61 lines —
 * and it is only at the family level that the shared 2,242 lines appear.
 *
 * ⚠️ `topKPlan` / `heapBeatsSort` / `deferredSortedNodeWalk` ARE THREE ROUTES TO ONE ANSWER, and the
 * choice between them is where a LIMIT has to reach the producer. A sort that materialises every
 * row before taking k is the eager fill that measured 473x on a 4096-row tail cache; a heap that
 * keeps k is bounded. `heapBeatsSort` is the gate, and it has to see the k and the row estimate
 * together — which is why these three cannot be separated.
 *
 * ⚠️ `itemLocal` / `itemLocalChild` ARE MUTUALLY RECURSIVE and one of only two such pairs in the
 * whole of `shortcuts.ts`. They stay together here.
 */

import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr, LabelExpr, NodePattern, Projection, SortItem } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import {
  aggregateOverValues,
  compileExpr,
  compilePredicate,
  foldedAggOnlyView,
  gatePredicate,
  percentileFraction,
  sortsOnOutputOnly,
} from './core.js';
import type { AggFold, CClause, CNode, CompiledExpr, EvalEnv, Params, Row } from './core.js';
import { freePredicateVars, hasSubquery, SUBQUERY_KINDS } from './expr-analysis.js';
import { plainNode } from './hop-sides.js';
import type { InlineGate, InlinePred } from './inline-gate.js';
import { composeInlineGate, inlineOf, predFor } from './inline-gate.js';
import { effectiveLabel } from './labels.js';
import {
  boundedTopKeyed,
  outputColumnSorts,
  pageSlice,
  sortRowsByColumns,
  unsortedPageRoute,
} from './ordered-rows.js';
import type { SortPlan } from './ordered-rows.js';
import { foldFor } from './projection.js';
import { columnName, valueKey } from './rows.js';
import { AGGREGATES, collectAggregates } from './scalars.js';
import type { ReachFn } from './shortcuts.js';
import {
  ROW_LOCAL_KINDS,
  VALUES_AGGREGATES,
  groupIndex,
  groupedAccs,
  groupedClauses,
  groupedCountRow,
  groupedProjection,
  groupedSortApplier,
  hopSeekWithKey,
  keepGroups,
  pageGroups,
  pageIsEmpty,
  sameGroupingExpr,
  seedIsExact,
  soleEqualityKey,
  sortGroupRows,
} from './shortcuts.js';
import { isNullish, propOf } from './values.js';

/**
 * Expression kinds that OPEN A NESTED SCOPE: a subquery. Admissible in a projected ITEM and never
 * in the predicate.
 *
 * The three are `exists` (`EXISTS { … }`), `countSubquery` (`COUNT { … }`) and `valueSubquery`.
 * `scalar` is NOT one — it is `{ kind: 'scalar', category }` — and the first version of this set
 * said `['exists', 'scalar']`, which both admitted a non-subquery and missed the two that matter.
 * The cause was a grep: `kind: '[a-z_]+'` over the AST silently skips every camelCase arm, so
 * `countSubquery` and `valueSubquery` were never in the list I worked from. The measurement is
 * what caught it — `EXISTS{}` went 91.4ns to 34.2 while `COUNT{}` did not move at all.
 *
 * The asymmetry is the point. The predicate is evaluated by the per-vertex gate, and item 175
 * gave the seed gate a CHEAP-CONJUNCT-FIRST order precisely so
 * `WHERE u.k = 'nope' AND <faulting subquery>` never reaches the subquery — a gate that evaluates
 * the whole predicate at once loses that, which is why `rowLocal` refuses these outright.
 *
 * An ITEM is different: it is evaluated once per row that SURVIVES the filter, on either path, so
 * a subquery there costs the same in both. And it is where the cost actually was —
 * `MATCH (u:User) WHERE u.name = $n RETURN COUNT { (u)-[:FOLLOWS]->{1,3}(x) }` was 94.3ns a
 * scanned vertex against the fast path's 38.2, and a ONE-HOP `COUNT{}` item measured 90.7ns, so
 * the subquery itself is ~4ns of it and the rest is the general-path scan (audit item 208).
 */
/**
 * One projected ITEM: row-local, but allowed to contain a subquery.
 *
 * The walk STOPS at a subquery rather than descending into it, which is what makes this sound:
 * the interior is a nested scope that the general path compiles and runs identically, and its
 * variables are bound by its own patterns. Outside subqueries the `rowLocal` allowlist still
 * applies in full, so a new `Expr` arm declines rather than slipping through.
 *
 * An aggregate is still refused — it needs the group this path never builds — and the check is
 * only applied OUTSIDE subqueries, because `count(*)` inside a `COUNT { … }` belongs to that
 * subquery, not to this projection.
 */
// Exported for its OWN test, not for a caller — item 1490. This is a pure ROUTE predicate, so
// every answer it changes is answer-equivalent and the differential tests cannot see a mutant in
// it (`perf-gate-needs-its-own-test`). `rowLocal` above is exported for the same reason.
export const itemLocal = (e: Expr | undefined): boolean => {
  if (e === undefined) {
    return true;
  }

  if (SUBQUERY_KINDS.has(e.kind)) {
    return true;
  }

  if (!ROW_LOCAL_KINDS.has(e.kind)) {
    return false;
  }

  if (e.kind === 'func' && AGGREGATES.has(e.name)) {
    return false;
  }

  // The same stop as `rowLocal`'s, for the same reason and with the same measured cost — see the
  // long note there. This copy is what the single-node paths (`nodeWhereOf`, and each projected
  // item in `detectNodeProjection`) go through; `rowLocal`'s is what the hop paths go through,
  // and BOTH declined a temporal literal.
  if (e.kind === 'lit') {
    return true;
  }

  return Object.values(e).every(itemLocalChild);
};
export const itemLocalChild = (child: unknown): boolean => {
  if (Array.isArray(child)) {
    return child.every(itemLocalChild);
  }

  if (typeof child !== 'object' || child === null) {
    return true;
  }

  const rec = child as Record<string, unknown>;

  return typeof rec.kind === 'string'
    ? itemLocal(child as Expr)
    : Object.values(rec).every(itemLocalChild);
};
/**
 * The node scan's clause `WHERE`, compiled into one `InlinePred` — or `'decline'` when this path
 * cannot carry it.
 *
 * Extracted because adding the subquery branch took `detectNodeProjection` to a complexity of 37
 * against a limit of 35 (audit item 209). It is the natural seam: everything here is about the
 * ONE predicate, and nothing in it touches the projection or the scan.
 */
export const nodeWhereOf = (where: Expr, nodeVar: string): InlinePred | 'decline' => {
  // A SUBQUERY is admissible in this predicate, unlike `detectHopProjection`'s, and the reason
  // is the segment count. Here the pattern has ZERO segments, so every candidate vertex yields
  // exactly ONE row — "once per vertex" and "once per complete match" are the same thing, and
  // evaluating the predicate per vertex is exactly what the general path does per row. A HOP
  // has neither property (one start can yield many rows or none), which is why item 207 keeps
  // `rowLocal` there and refuses subqueries outright.
  //
  // The gate is `gatePredicate` — the general path's OWN prefilter, not a re-derivation — so
  // the conjunct ORDER and the stop-at-first-non-TRUE semantics are identical by construction.
  // That ordering is item 175's: a `EXISTS {…}` / `COUNT {…}` conjunct is not reached for a
  // vertex a cheap conjunct already rejected. It is also the observable behaviour already,
  // which was checked rather than assumed — `WHERE k = $miss AND EXISTS { … /0 … }` answers
  // `[]` on the general path both indexed and unindexed, so deferring the subquery does not
  // introduce a raise the general path lacks.
  //
  // Measured (20,000 users, the `analytic: cycle detection` shape), holding the scan fixed and
  // varying the subquery's cost — the technique item 208 used:
  //
  //     no subquery at all                53ns a vertex
  //     a TRIVIAL subquery in the WHERE   86ns
  //     the 2-4 hop cycle subquery        98ns
  //
  // 33ns for merely HAVING a subquery against 12ns for the subquery's own extra work, so the
  // cost was the general-path scan rather than the subquery (audit item 209).
  if (!itemLocal(where)) {
    return 'decline';
  }

  // Skipped for a subquery-bearing predicate for the reason given above the items' copy of this
  // check: `freePredicateVars` reports the variables bound INSIDE a subquery, so it would
  // refuse every one of them, and `nodeVar` is the only name anything here can be bound to.
  // COMPUTED ONCE (item 919). `hasSubquery` is a generic structural walk of the whole
  // expression and was called twice on the same `where` — here, negated, and again in the ternary
  // at the end of this function. A CPU profile put it at 184.2 ms of a clause-`WHERE` compile
  // against 31.9 for the inline spelling.
  const hasSub = hasSubquery(where);

  if (!hasSub) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== nodeVar) {
        return 'decline';
      }
    }
  }

  // `props` used to be EMPTY on both branches, and item 210's version of this comment said so
  // correctly: `compilePredicate(properties, where)` compiled the `properties` it was GIVEN and
  // left the `where` an expression, lifting nothing out of it. That stopped being true in item
  // 224, which added `eqProps` — the conjuncts of a `WHERE` that are `<ownVar>.<key> = <non-null
  // literal>`, compiled to read the ELEMENT directly rather than through the binding — and item
  // 230, which extended it from one comparison to an all-`=` AND-chain.
  //
  // `nodeVar` is passed as that own variable, and the free-variable loop directly above is what
  // establishes the argument: every free name of `where` IS `nodeVar`, so the predicate is
  // element-local.
  //
  // THAT LOOP IS A ROUTE GATE, NOT A CORRECTNESS GUARD — measured, not assumed (item 919).
  // Inverting its condition (so a subquery-free predicate SKIPS the check and never declines)
  // survived the whole gql suite, and a direct probe of the shape it exists to decline — a node
  // projection whose clause `WHERE` reads an OUTER variable, `MATCH (z:P) WHERE z.k = 'b' MATCH
  // (n:P) WHERE n.n = z.n RETURN n.k` — returned identical rows with and without it, across `=`,
  // `>` and `<>`. The reason is the one item 128 recorded for this guard's twin in
  // `pushWhereIntoNode`: a node predicate is evaluated against the INCOMING binding, which
  // already holds every earlier clause's variables, so an outer reference resolves in the
  // pattern exactly as it did in the clause filter. Kept regardless, on item 128's rule — a
  // guard whose necessity is unproven is not a guard shown to be unnecessary — but do not cite
  // it as load-bearing for correctness. Without it the clause spelling of a filtered projection cost 9.64 ms against
  // the inline spelling's 6.78 on 200,000 vertices — 1.42x for one question, and the last group
  // the spelling probe still flagged (audit item 231).
  //
  // The two branches still differ by `gatePredicate` against `compileExpr`, and that
  // discrimination is load-bearing for a measured reason: the mutant routing EVERY predicate
  // through `gatePredicate` costs 18% on the indexed point lookup (95.4k -> 80.8k ops/s) from the
  // indirection alone. A subquery-bearing predicate has nothing else available anyway —
  // `compilePredicate` does not know about subqueries, and a correlated sub-pattern is not a
  // property equality — so `ownVar` would buy it nothing even if it were passed.
  return predFor(
    hasSub
      ? { props: [], where: gatePredicate(where) }
      : compilePredicate(undefined, where, nodeVar),
    nodeVar,
    true,
  );
};
/**
 * The `InlinePred`s a single-node scan's gate is composed from, or `null` when the shape declines.
 *
 * Extracted at item 1610 so the EXACTNESS verdict is formed from the very list the gate composes.
 * `soleEqualityKey(nodeScanPreds(...))` and `nodeScanGate(...)` therefore cannot disagree about
 * what the predicate asserts — which is the whole reason `SeedCandidate` reports a fact rather than
 * carrying an `exact` flag, and the same argument applied one level further out.
 */
export const nodeScanPreds = (
  start: NodePattern,
  where: Expr | undefined,
  nodeVar: string,
): InlinePred[] | null => {
  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  if (where !== undefined) {
    const carried = nodeWhereOf(where, nodeVar);

    if (carried === 'decline') {
      return null;
    }

    preds.push(carried);
  }

  return preds;
};
/**
 * The ONE key a single-node scan's predicate asserts an equality on, or `undefined`.
 *
 * A free function for the LINT GATE rather than for speed — the two lines inlined took
 * `detectNodeProjection` to a complexity of 36 against a limit of 35, which is the same wall
 * `liftedOwnPred` records hitting at 38 and the same way out. It decides a route ONCE PER QUERY,
 * where the walk it unlocks runs once per candidate.
 */
export const nodeScanSoleKey = (
  start: NodePattern,
  where: Expr | undefined,
  nodeVar: string,
): string | undefined => {
  const preds = nodeScanPreds(start, where, nodeVar);

  return preds === null ? undefined : soleEqualityKey(preds);
};
export const nodeScanGate = (
  start: NodePattern,
  where: Expr | undefined,
  nodeVar: string,
): InlineGate | undefined | null => {
  const preds = nodeScanPreds(start, where, nodeVar);

  return preds === null ? null : composeInlineGate(preds);
};
/**
 * The candidate vertices a single-node scan shortcut walks, and whether they came from an INDEX.
 *
 * Extracted (item 651) so the row-projecting path and the aggregate paths share ONE copy of the
 * seed decision rather than three. That decision is the dangerous part of this preamble, not the
 * loop around it: written as a raw bucket walk first, it made the INDEXED point lookup 50x
 * SLOWER (80.9k -> 1.6k ops/s in `bench:usage`) while making the unindexed one 2x faster,
 * because it claimed the query ahead of the general path's index seek and then scanned.
 * `count-shortcuts-must-seek` names that failure and its signature.
 *
 * `hopSeek` returns a candidate set only when it is strictly smaller than the label bucket, so
 * an unindexed graph still walks the bucket and pays nothing for the attempt.
 *
 * ⚠️ `seeded` is returned, not just the iterable, and every caller must use it: a seeded set is
 * a SUPERSET — an index hint is a NECESSARY condition, not a sufficient one, so it can hand back
 * a same-named vertex of the WRONG LABEL. Two tests caught that omission as a WRONG ANSWER, not
 * as a slow one. The bucket walk satisfies the label by construction, which is why the recheck is
 * guarded on `seeded` rather than run unconditionally.
 */
export const scanCandidates = (
  graph: Graph,
  cstart: CNode | undefined,
  label: LabelExpr | undefined,
  labelName: string | undefined,
  env: EvalEnv,
): {
  vertices: Iterable<Vertex>;
  seeded: ReadonlySet<Vertex> | undefined;
  /** The equality key the seek matched on, for the exactness verdict (item 1610). */
  eqKey: string | undefined;
} => {
  const { seeded, eqKey } = hopSeekWithKey(graph, cstart, label, env);

  return {
    seeded,
    eqKey,
    vertices:
      seeded ??
      (labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? [])),
  };
};
/**
 * The pieces a single-node aggregate needs to walk the scan and fold VALUES directly, without
 * `detectNodeProjection` materializing a `Row` per vertex first — or `null` when the shape is
 * not one this can drive.
 *
 * ## Why this exists (item 651)
 *
 * `detectNodeAggregate` builds a synthetic one-item projection and delegates to
 * `detectNodeProjection`, which returns a MATERIALIZED `Row[]`. So `RETURN max(n.w)` over
 * 200,000 vertices allocated 200,000 row objects, wrote the value under a computed key, pushed
 * each to an array, and only then read it back out to fold. Measured at 200,000 vertices, min of
 * 3 alternated rounds:
 *
 * | | before | after | |
 * | --- | --- | --- | --- |
 * | `RETURN max(n.w)` (fold path) | 11.46 ms | **4.00** | **2.87x** |
 * | `RETURN sum(n.w)` (collecting path) | 12.32 ms | **6.64** | **1.86x** |
 *
 * The materialization was the whole gap and not the fold: a BARE `RETURN n.w AS w` over the same
 * scan — the same materialization, none of the fold — measured 9.61 ms, MORE than the entire
 * grouped aggregate (8.45) that folds during its walk.
 *
 * ## `rowsFn` still decides WHETHER the shape is claimed
 *
 * The caller keeps its `detectNodeProjection` call and its null check, so which queries this
 * family claims is unchanged by construction — no new shape becomes claimable, which is the
 * failure mode `count-shortcuts-must-seek` records. This only changes HOW an already-claimed
 * shape is executed. Everything `detectNodeProjection` verifies about the pattern (no path
 * variable, no segments, item locality, free variables) therefore holds whenever `rowsFn` is
 * non-null, and the synthetic projection carries no sort, skip or limit.
 *
 * The candidate set and the gate come from `scanCandidates` and `nodeScanGate` — the SAME
 * helpers the row path uses — so the two agree by construction rather than by a copy being
 * right. Both callers' loops must keep the row path's exact ORDER: label recheck, then gate,
 * then `binding.set`. The gate takes the vertex explicitly and runs before the binding is set.
 */
export type NodeScan = {
  nodeVar: string;
  label: LabelExpr | undefined;
  labelName: string | undefined;
  cstart: CNode | undefined;
  gate: InlineGate | undefined;
  /**
   * The ONE key this scan's predicate asserts an equality on, for the exact-seed skip (item 1611).
   *
   * It rides on `NodeScan` rather than being re-derived per consumer BECAUSE `nodeScanOf` is where
   * the gate is built: the verdict and the gate then come from one parse, which is the property
   * `nodeScanPreds` exists to guarantee. Item 652 split this derivation out so the single- and
   * multi-aggregate paths could not drift; one field here reaches all three of their walks.
   */
  soleKey: string | undefined;
};
/**
 * The scan pieces themselves, shared by the single-aggregate path and the MULTI-aggregate one
 * (item 652). Split out of `valueScanOf` rather than copied: the multi path supplies one compiled
 * argument function PER ACCUMULATOR, so it cannot use `valueScanOf`'s single `argFn`, but the
 * derivation of the candidate set and the gate has to stay identical across both.
 */
export const nodeScanOf = (m: Clause, cm: CClause): NodeScan | null => {
  if (m.kind !== 'match' || cm.kind !== 'match' || m.patterns.length !== 1) {
    return null;
  }

  const [{ start }] = m.patterns;
  const nodeVar = start.variable;

  if (nodeVar === undefined) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const gate = nodeScanGate(start, m.where, nodeVar);

  if (gate === null) {
    return null;
  }

  return {
    nodeVar,
    label,
    labelName: label?.name,
    cstart: cm.patterns[0].start,
    gate,
    soleKey: nodeScanSoleKey(start, m.where, nodeVar),
  };
};
export const valueScanOf = (
  m: Clause,
  cm: CClause,
  argExpr: Expr,
): (NodeScan & { argFn: CompiledExpr }) | null => {
  const scan = nodeScanOf(m, cm);

  return scan === null ? null : { ...scan, argFn: compileExpr(argExpr) };
};
/**
 * The vertex a KEY ROW was ranked for, carried on the row itself.
 *
 * A SYMBOL rather than a reserved name because the row's other keys are the query's own output
 * column names, and a string key cannot be proven not to collide with one. A parallel array
 * cannot be used at all: the sort permutes the rows and the association has to survive it.
 */
export const HELD_VERTEX = Symbol('heldVertex');
export type KeyRow = Row & { [HELD_VERTEX]: Vertex };
/** One resolved `ORDER BY` key: the column the ranking writes it to, and how to compute it. */
export type DeferredKey = { col: string; fn: CompiledExpr };
/**
 * The `ORDER BY` keys of a windowed sort, COMPILED, or `null` to decline.
 *
 * RANKING ON COMPILED KEYS RATHER THAN ON OUTPUT COLUMNS, which is what makes two spellings of
 * one question cost the same. `outputColumnSorts` requires every key to NAME an output column and
 * substitutes only a `prop` alias, so `RETURN n.k + 1 AS c ORDER BY c` resolved and
 * `… ORDER BY n.k + 1` did not. Ranking the first and not the second measured **3.8x apart on
 * `bun run spelling`** (11.30 ms against 43.13) — this repo's named defect class, created by the
 * first cut of item 1062 and caught by the probe before it shipped, where both spellings had been
 * converged at ~34 ms before. Evaluating the key expression itself has no such asymmetry: there is
 * nothing to match an alias against.
 *
 * The key row is DISCARDED — only the full projection is returned — so the keys go to synthetic
 * column names and never have to agree with `cols`.
 *
 * WHAT IT REFUSES, each for a reason the general path states:
 *
 *   - A key that is not ROW-LOCAL to the scan's own variable (`itemLocal`, plus the free-variable
 *     test the items already pass). An aggregate is excluded by `itemLocal`: it is defined over a
 *     group, not a row.
 *   - A SUBQUERY key. `freePredicateVars` returns the empty set for one — it does not descend —
 *     so the free-variable test cannot see its names, and substituting a subquery sort key was a
 *     live cross-engine divergence at item 213.
 *   - A key whose free name is also an OUTPUT name. In the sort scope the output columns are
 *     overlaid on the binding, so that name resolves to the COLUMN and means something else;
 *     `aliasDefinition` declines for exactly this and native does the same.
 */
export const deferredSortKeys = (
  keys: readonly SortItem[],
  proj: Projection,
  cols: readonly string[],
  nodeVar: string,
): DeferredKey[] | null => {
  const outNames = new Set(cols);
  const out: DeferredKey[] = [];

  for (const [i, k] of keys.entries()) {
    // `ORDER BY <alias>` IS `ORDER BY <the expression the alias names>`, and the item's own
    // expression is what gets compiled — the same rewrite `aliasDefinition` performs for the
    // general path, so the two agree on which expression is the key.
    const key = k.expr;
    const named =
      key.kind === 'var'
        ? proj.items.find((it) => (it.alias ?? columnName(it.expr)) === key.name)
        : undefined;
    const expr = named === undefined ? key : named.expr;

    if (!itemLocal(expr) || hasSubquery(expr)) {
      return null;
    }

    for (const nameRead of freePredicateVars(expr)) {
      if (nameRead !== nodeVar || outNames.has(nameRead)) {
        return null;
      }
    }

    out.push({ col: `\u0000k${i}`, fn: compileExpr(expr) });
  }

  return out;
};
/**
 * A windowed, sorted node scan that RANKS ON THE KEYS AND PROJECTS ONLY THE EMITTED ROWS.
 *
 * WHY IT EXISTS (item 1062). `detectNodeProjection` refused a window whenever any projected item
 * could fault — `outputColumnSorts`'s rule — because it projected every row and sliced, which
 * would raise on a row the query never emits. So `RETURN n.k + 1 AS c ORDER BY c LIMIT 10` fell to
 * the general path at ~34 ms where the plain-property spelling takes this rung at 11-14 (items
 * 1058/1060/1061 located that boundary and priced it). The refusal was not about the ITEM being
 * unprojectable — `itemLocal` admits any row-local expression — it was about projecting it too
 * often.
 *
 * This arm does what the general path does, which is also what native does: evaluate the SORT
 * KEYS per row, rank those, then project the full width for the `cap` survivors only. A non-key
 * item that faults on a discarded row is never evaluated, exactly as in `applyProjection` after
 * `aliasDefinition` has substituted the alias; a KEY item that faults still raises, because the
 * general path evaluates every key per row too.
 *
 * A SEPARATE WALK, not a branch in the existing one. The plain arm is byte-for-byte unchanged:
 * item 1033 measured a branch added to a sibling hot loop costing three queries this rung's
 * change could not reach about 2x, and item 1034 built a module-scope walk instead for exactly
 * that reason ([[ts-closure-size-is-load-bearing]]).
 *
 * `binding` is always written here, with no `allDirect` test: this arm is reached only when some
 * item is NOT a direct property read, so the binding is always consulted.
 */
export const deferredSortedNodeWalk = (spec: {
  cstart: CNode | undefined;
  label: LabelExpr | undefined;
  labelName: string | undefined;
  gate: InlineGate | undefined;
  nodeVar: string;
  cols: readonly string[];
  fns: readonly CompiledExpr[];
  directKeys: readonly (string | undefined)[];
  keys: readonly DeferredKey[];
  plan: SortPlan;
  soleKey: string | undefined;
}): ((graph: Graph, params: Params) => Row[]) => {
  const { cstart, label, labelName, gate, nodeVar, cols, fns, directKeys, keys, plan, soleKey } =
    spec;
  const width = cols.length;

  return (graph, params) => {
    const keyed: KeyRow[] = [];
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const { vertices, seeded, eqKey } = scanCandidates(graph, cstart, label, labelName, env);

    // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
    // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
    // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
    // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
    // (item 1551), so a cached plan cannot carry it.
    const labelEff = effectiveLabel(graph, label);
    // Per CALL: the verdict needs the candidate the seek chose, and `seeded !== undefined` is
    // item 1610's designed-out hazard — exactness means nothing on a bucket walk.
    const exactSeed = seeded !== undefined && seedIsExact({ eqKey }, soleKey);

    for (const v of vertices) {
      // Both tests, in the same order and for the same reasons the plain arm states.
      if (seeded !== undefined && !matchesLabel(v, labelEff)) {
        continue;
      }

      // ITEM 1611: an EXACT seed has already decided the predicate — the same skip item 1607 gave
      // the count and item 1610 the streaming projection, now at the five walks that still
      // re-validated. Ablating these gates priced them at 1.39-1.84x before anything was built.
      // The LABEL test above still runs: a seek returns vertices by VALUE across all labels.
      if (!exactSeed && gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      binding.set(nodeVar, v);

      const kr = { [HELD_VERTEX]: v } as KeyRow;

      for (const k of keys) {
        kr[k.col] = k.fn(env);
      }

      keyed.push(kr);
    }

    // The ONE sorter, so the comparator, the bounded heap and the window all stay shared with the
    // plain arm — the key rows carry fewer columns, and nothing in there reads any other.
    const picked = sortRowsByColumns(keyed, plan) as KeyRow[];
    const out: Row[] = [];

    for (const kr of picked) {
      const v = kr[HELD_VERTEX];

      binding.set(nodeVar, v);

      // ❌ REJECTED, item 1477: building this row by cloning a PRE-SHAPED template
      // (`{ ...rowShape }`, so the per-column stores hit existing keys and the hidden class never
      // transitions) measured **1.52x in a 300,000-row micro at width 5** — and NOTHING in the
      // engine. Four widths, 3 rounds, order-alternated: proj1 2/3, proj2 1/3, wideproj 2/3,
      // proj10 1/3, with per-arm ranges fully overlapping (proj1 POST 245-310 against PRE 245-322)
      // and the `sortedpage` CONTROL also reading 2/3 in POST's favour.
      //
      // Why the micro did not transfer: row construction is a small share of the per-row cost here
      // — `propOf`, the `properties` getter, `scanCandidates` and the gate are the rest — so a 1.52x
      // on construction alone is diluted past this instrument's ~30% spread. Third instance in this
      // repo of a clean micro not reaching the engine (see item 1364's 3.8x → 1.11x).
      // ❌ REJECTED HERE, item 1744: the per-row bag hoist, in the `readDirect` form item 1743
      // shipped two closures away. It is FLAT on this one — 1500 runs, three alternated rounds, ms:
      // THREE direct columns beside a computed one 637/633 -> 623/614/644, ~2% with the arm's range
      // ENCLOSING the base's; one direct column 622/635 -> 613/612/606. Both controls flat
      // (`topkwide` 360/377/373 -> 366/377/367, `wideproj` 490/503/486 -> 483/493/487).
      //
      // The comment above already said why, and it holds: row construction is a small share of the
      // per-row cost HERE, because this closure also extracts sort keys and sorts. These shapes cost
      // ~620 ms against `wideproj`'s ~490 for the same 1500 runs, so three getter calls collapsing
      // to one is diluted past the instrument.
      //
      // ⚠️ REACHING THIS CLOSURE AT ALL took a counter, and the shape is narrow: `outputColumnSorts`
      // declines — sending the query here — when a WINDOWED sort has an item that can FAULT, so
      // `RETURN n.k + 1 AS x, n.n AS b … ORDER BY b LIMIT 5` arrives but a parameterized `LIMIT $n`
      // and a `LIMIT 0` do NOT (both measured as entering no counted closure). Probe shapes
      // `defsortwide`/`defsortnarrow` exist for it now.
      //
      // So the lever is SWEPT across all three closures of this kind: shipped at the main one
      // (1.30x, item 1741) and the top-K arm (1.35x, item 1743), flat here.
      const row: Row = {};

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] = dk === undefined ? fns[i](env) : propOf(v, dk);
      }

      out.push(row);
    }

    return out;
  };
};
/**
 * Is selecting `cap` of `rows` with a heap cheaper than sorting all of them?
 *
 * `* 16` is `sortRowsByColumns`'s own MEASURED crossover, not a guess: a heap is O(n log cap)
 * against the sort's O(n log n), so it wins only while `cap` is a small fraction of `n`, and at
 * `cap` near `n` it is a slower way to sort everything. That item's cap sweep at 200,000 rows read
 * 2.9x at 100, 3.2x at 1,000, 2.1x at 5,000, 1.45x at 10,000 and 0.99x at 20,000 — so the heap
 * stops paying at about `n/10` and this admits to `n/16`, inside the win. A looser `* 8` measured
 * 0.95x on `LIMIT 20,000`, which is the regression the constant exists to keep out.
 *
 * A PURE FUNCTION because the choice is answer-equivalent — both arms return the same rows in the
 * same order — so every mutation of it survives the differential tests and only its own unit tests
 * can see it (`perf-gate-needs-its-own-test`, items 1038/1044).
 */
export const heapBeatsSort = (cap: number, rows: number): boolean => cap * 16 <= rows;
/**
 * Can this sort plan be served by selecting the top `cap` during the scan (item 1064)?
 *
 * EXTRACTED AS A PURE FUNCTION because the choice is ANSWER-EQUIVALENT: both arms return the same
 * rows in the same order, so every mutation of a condition inline in the detector would survive the
 * differential tests. `perf-gate-needs-its-own-test` is the rule, learned at items 1038 and 1044.
 *
 * It needs a WINDOW (without a `limit` there is no `cap` to select) and every sort key must be a
 * DIRECT property read of the scan's own variable, because the selection reads keys off the vertex
 * rather than out of a projected row. A key that is not — an arithmetic expression, or a column
 * whose item is not a `prop` — keeps the plain arm, which is correct and only slower.
 */
export const topKPlan = (
  plan: SortPlan,
  cols: readonly string[],
  directKeys: readonly (string | undefined)[],
): { keyProps: readonly string[]; plan: SortPlan & { limit: number } } | undefined => {
  if (plan.limit === undefined || plan.sorts.length === 0) {
    return undefined;
  }

  const keyProps: string[] = [];

  for (const s of plan.sorts) {
    const dk = directKeys[cols.indexOf(s.col)];

    if (dk === undefined) {
      return undefined;
    }

    keyProps.push(dk);
  }

  return { keyProps, plan: { ...plan, limit: plan.limit } };
};
/**
 * A WINDOWED SORT ON DIRECT PROPERTY KEYS: select the top `cap` during the scan, project only
 * those.
 *
 * WHY (item 1064). The plain arm projects a `Row` for EVERY surviving vertex and then hands all of
 * them to `sortRowsByColumns`, whose heap selects `cap`. Over 200,000 vertices that is 200,000 row
 * objects to emit ten, and it measured 12.9 ms where native does the same query in 1.10. Locating
 * the cost took three measurements and refuted two hypotheses:
 *
 * ```text
 *   count(*)                                   0.00 ms   (no scan of properties at all)
 *   min(n.k)         scan + property read      4.63      ← the FLOOR for this shape in TS
 *   RETURN n.k AS c  + a row per vertex        8.42
 *   … ORDER BY c LIMIT 10                     12.9       ← the 4.5 ms on top is the selection
 * ```
 *
 *   - **Routing it through the deferred arm (item 1062) measured 14.25 — SLOWER.** That arm still
 *     allocates a key row per candidate, so it trades one object for another.
 *   - **A flat key array plus a full index sort measured 27.60 — much slower.** Avoiding the row
 *     object is not the win; the O(n log n) is.
 *
 * What works is both together: collect the surviving VERTICES (one array push, no object), select
 * `cap` of them with `boundedTopKeyed`, and project only those. 12.9 → 6.65 ms, which is within
 * 1.4x of the scan floor the `min` row establishes — so most of what is left is the scan, and
 * `pull`-style work on the remaining 2 ms would be chasing the layout ceiling.
 *
 * `boundedTopKeyed` is REUSED rather than re-implemented, for the reason `sortRowsByColumns` gives
 * about comparators: it already carries the arrival-index tiebreak that makes the heap's order the
 * stable sort's total order, and tie order under `ORDER BY` is observable between the engines (item
 * 605). A second selection with its own tiebreak is exactly what byte-identity cannot survive.
 *
 * THE CAP GUARD IS PER CALL, not per compile, because it depends on the row count. `* 16` is
 * `sortRowsByColumns`'s own MEASURED crossover — a heap is O(n log cap) against the sort's
 * O(n log n), so it wins only while `cap` is a small fraction of `n`, and at `cap` near `n` it is a
 * slower way to sort everything. Above it this walk does what the plain arm does, which is why
 * the large-`cap` shape cannot regress past one extra array.
 */
/**
 * One direct-column read, with the row's property bag already in hand when the caller hoisted it.
 *
 * ⚠️ AT MODULE SCOPE DELIBERATELY, and that is the whole point of this shape (item 1743). Item 1742
 * put the two modes in two LOOPS inside the per-row closure and the single-column path lost 7.6%
 * although its code was byte-identical — `ts-closure-size-is-load-bearing`: a bigger closure body
 * inlines worse. Here the closure grows by one local and keeps ONE loop, and the mode choice costs
 * a module-level call that REPLACES the `propOf` call it would otherwise make, so the per-column
 * call count is unchanged.
 */
const readDirect = (bag: Record<string, unknown> | undefined, v: Vertex, dk: string): unknown =>
  bag === undefined ? propOf(v, dk) : (bag[dk] ?? null);

export const topKNodeWalk = (spec: {
  cstart: CNode | undefined;
  label: Extract<LabelExpr, { kind: 'label' }> | undefined;
  gate: InlineGate | undefined;
  nodeVar: string;
  cols: readonly string[];
  fns: readonly CompiledExpr[];
  directKeys: readonly (string | undefined)[];
  keyProps: readonly string[];
  plan: SortPlan & { limit: number };
  soleKey: string | undefined;
}): ((graph: Graph, params: Params) => Row[]) => {
  const { cstart, label, gate, nodeVar, cols, fns, directKeys, keyProps, plan, soleKey } = spec;
  const labelName = label?.name;
  const width = cols.length;
  const cap = plan.skip + plan.limit;
  const allDirect = directKeys.every((k) => k !== undefined);

  return (graph, params) => {
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const { vertices, seeded, eqKey } = scanCandidates(graph, cstart, label, labelName, env);
    const kept: Vertex[] = [];

    // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
    // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
    // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
    // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
    // (item 1551), so a cached plan cannot carry it.
    const labelEff = effectiveLabel(graph, label);
    // Per CALL: the verdict needs the candidate the seek chose, and `seeded !== undefined` is
    // item 1610's designed-out hazard — exactness means nothing on a bucket walk.
    const exactSeed = seeded !== undefined && seedIsExact({ eqKey }, soleKey);

    for (const v of vertices) {
      // Both tests, in the same order and for the same reasons the plain arm states.
      if (seeded !== undefined && !matchesLabel(v, labelEff)) {
        continue;
      }

      // ITEM 1611: an EXACT seed has already decided the predicate — the same skip item 1607 gave
      // the count and item 1610 the streaming projection, now at the five walks that still
      // re-validated. Ablating these gates priced them at 1.39-1.84x before anything was built.
      // The LABEL test above still runs: a seek returns vertices by VALUE across all labels.
      if (!exactSeed && gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      kept.push(v);
    }

    // ✅ SHIPPED AT ITEM 1743, after item 1742 rejected a DIFFERENT spelling of the same idea here.
    // The two-loop form (one loop per mode, as the main closure above uses) measured 1.21x on three
    // columns but cost the SINGLE-column shape 7.6% with disjoint ranges — although that path's code
    // was byte-identical, because `project` grew a second loop and a bigger closure inlines worse.
    // Moving the mode choice into the module-scope `readDirect` above keeps ONE loop and one extra
    // local, and the per-column call count is unchanged (`readDirect` replaces the `propOf` call).
    // 1500 runs, three alternated rounds, ms: THREE columns 508/493 -> 365/372/364, **1.35x with
    // disjoint ranges — better than the two-loop form's 1.21x** — and ONE column 365/370 ->
    // 380/361/358, FLAT. Both of the main closure's shapes are flat too (`wideproj` 499/482/479 ->
    // 483/484/495; `narrow1` 288/290/289 -> 289/287/286), so this change is confined to this arm.
    //
    // ⚠️ The file therefore holds TWO spellings of one optimization: the main closure splits into two
    // loops (item 1741) and this arm calls `readDirect`. Left that way deliberately — 1741's split
    // measured 1.30x with its narrow shape FLAT, so there is no defect there to fix, and rewriting a
    // shipped win to match a style would be a change with a measured risk and no measured gain. If
    // the main closure is ever touched for another reason, `readDirect` is the better shape to adopt.
    //
    // (Historical, item 1742: the per-row bag hoist item 1741 shipped in this file's MAIN
    // projection closure. This arm is the only reachable sibling — verified with a per-closure
    // counter, since all three are returned by the same `nodeProjection` detector and the route name
    // cannot tell them apart (`topkwide` fired this one 78 times; `wideproj`, `ORDER BY` without a
    // `LIMIT`, and `ORDER BY` on a non-output column all took the main closure).
    //
    // 1500 runs, three alternated rounds, ms: THREE columns 494/501/496 -> 408/405/418, **1.21x with
    // disjoint ranges** — but ONE column 381/360/391 -> 401/410/416, **7.6% WORSE, also disjoint.**
    //
    // ⚠️ The regressed path takes the guard's `else` branch, whose code is BYTE-IDENTICAL to this
    // loop. Nothing it runs changed; `project` merely grew a second loop, and a bigger closure body
    // inlines worse — `ts-closure-size-is-load-bearing`. The guard stops the width-1 HOIST from
    // costing anything; it does nothing about the closure growing, and those are separate costs.
    // Item 1741 shipped because its narrow path measured FLAT, not because a split is free.
    //
    // That form was declined because 7.6% is above the 7.4% at which item 312 withdrew `addVertex`.
    // Its note prescribed lifting the loop variants to MODULE scope so this closure stays small —
    // which is what item 1743 then did, in the lighter form above: one module function, not two.)
    const hoistBag = directKeys.filter((k) => k !== undefined).length > 1;
    const project = (v: Vertex): Row => {
      if (!allDirect) {
        binding.set(nodeVar, v);
      }

      const row: Row = {};
      const bag = hoistBag ? v.properties : undefined;

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] = dk === undefined ? fns[i](env) : readDirect(bag, v, dk);
      }

      return row;
    };

    // ABOVE THE CROSSOVER, do what the plain arm does: project everything and let
    // `sortRowsByColumns` sort and slice. Same answer, and the only extra is the `kept` array.
    if (!heapBeatsSort(cap, kept.length)) {
      return sortRowsByColumns(kept.map(project), plan);
    }

    const top = boundedTopKeyed(kept, (v, i) => propOf(v, keyProps[i]), plan.sorts, cap);

    return top.slice(plan.skip).map(project);
  };
};
/**
 * THE DEFERRED ARM's compile-time half (item 1062), extracted because inlining it put
 * `detectNodeProjection` at a complexity of 42 against a ceiling of 35 — the same reason item
 * 1038 pulled `relBoundRoute` out of its own detector.
 *
 * `outputColumnSorts` has just refused a window — most often because a projected item could fault
 * and the plain arm projects every row — and this answers the same shape by ranking on the keys
 * and projecting only the rows it emits, which is what the general path and native both do. Its
 * own window rules, each with its reason:
 *
 *   - `limit === undefined` DECLINES. A `SKIP` with no `LIMIT` is not a top-k: with no cap the
 *     general path sorts and projects EVERY row and then drops the skipped ones, so
 *     `RETURN <faulting> AS x, n.n AS t ORDER BY t OFFSET 1` raises on both engines even though
 *     the window discards the faulting row. `page-fold-fault.test.ts`'s existing control caught
 *     the first cut of this arm admitting it.
 *   - `limit === 0` DECLINES, and here that is CORRECTNESS rather than speed: `applyProjection`
 *     returns `[]` before ranking or projecting anything, so evaluating keys to emit nothing
 *     would raise where the query does not. The identical guard in `outputColumnSorts` is only a
 *     speed guard, which is why it is documented in both places.
 *   - A PARAMETERIZED window declines: the route is chosen once at compile time while the value
 *     lives in `params`, which the plan cache is shared across.
 */
export const deferredRoute = (spec: {
  proj: Projection;
  cstart: CNode | undefined;
  // The NARROWED label, as the detector has it: a plain `:L`, the only form the scan takes.
  label: Extract<LabelExpr, { kind: 'label' }> | undefined;
  gate: InlineGate | undefined;
  nodeVar: string;
  cols: readonly string[];
  fns: readonly CompiledExpr[];
  directKeys: readonly (string | undefined)[];
  soleKey: string | undefined;
}): ((graph: Graph, params: Params) => Row[]) | null => {
  const { proj, cstart, label, gate, nodeVar, cols, fns, directKeys, soleKey } = spec;
  const { skip, limit } = proj;
  const keys = proj.orderBy;

  if (
    keys === undefined ||
    keys.length === 0 ||
    typeof limit !== 'number' ||
    limit === 0 ||
    (skip !== undefined && typeof skip !== 'number')
  ) {
    return null;
  }

  const deferredKeys = deferredSortKeys(keys, proj, cols, nodeVar);

  if (deferredKeys === null) {
    return null;
  }

  return deferredSortedNodeWalk({
    cstart,
    label,
    labelName: label?.name,
    gate,
    nodeVar,
    cols,
    fns,
    directKeys,
    keys: deferredKeys,
    soleKey,
    plan: {
      sorts: keys.map((k, i) => ({
        col: deferredKeys[i].col,
        descending: k.descending,
        nullsFirst: k.nullsFirst,
      })),
      skip: typeof skip === 'number' ? skip : 0,
      limit,
    },
  });
};
export const detectNodeProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm] = compiled;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret.kind !== 'return') {
    return null;
  }

  if (cm.kind !== 'match') {
    return null;
  }

  const proj = ret.projection;

  // `star` needs the binding's whole shape; the rest each need a stage this path does not have.
  //
  // Two of these are belt-and-braces, and mutation says so rather than my reading it:
  //
  //   - `proj.star` is EQUIVALENT to the `items.length === 0` test below, because a `RETURN *`
  //     carries no items. Removing it changes no answer.
  //   - `proj.distinct` is reached only for a MULTI-item `DISTINCT`: `detectDistinctProjection`
  //     runs earlier in the ladder and claims the one-item case. The multi-item case is real
  //     though — nothing here dedupes — so it has a test with two vertices agreeing on BOTH
  //     projected values, which is what a one-column fixture cannot see.
  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    proj.items.length === 0
  ) {
    return null;
  }

  // `orderBy` is NO LONGER an outright decline (item 605) — see `outputColumnSorts`, which admits
  // it when every key is an output column AND there is no window. `skip`/`limit` are refused
  // THERE rather than here, because the two decisions are one rule: a window without a sort must
  // also decline, since the general path is LAZY for it and a `LIMIT 5` short-circuits after a
  // few rows where this path materializes everything — `sortOf` records that as a ~280x
  // regression for the DISTINCT walk, which is the same trade in the same place.
  /**
   * ⚠️ WITH ONE EXCEPTION SINCE ITEM 1776: a SKIP with NO LIMIT is admitted and sliced, because the
   * decline above is a statement about LAZINESS and a skip alone has no brake to collect — the
   * engine emits `N - skip` rows either way, so declining cost **7.9x** over 200,000 vertices for
   * TEN FEWER ROWS than the unpaged spelling (item 1775). `unsortedPageRoute` is that whole rule,
   * including why a `LIMIT` must keep declining and why a PARAMETERIZED skip does.
   *
   * ANSWER-EQUIVALENCE is the part that had to be settled before the speed mattered, and it is
   * settled POSITIONALLY rather than as a multiset: `skip-only-page.test.ts` compares this rung's
   * rows against the general path's for the same query (reached through the parameterized spelling,
   * which declines on purpose), and `offset-order-equiv.mjs` does the same at 5,000 vertices for
   * four skip values. A skip is NOT order-invariant the way a projection is — skipping the first k
   * of two different visit orders yields different multisets — so `order-is-unspecified` licenses
   * nothing here. The orders being identical is also what keeps byte-identity against native
   * intact, the general path being what native agrees with today.
   *
   * FAULTS LINE UP IN BOTH DIRECTIONS. Where the projection CANNOT fault, `pagedFaultFreeRows`
   * pages the BINDINGS and there is nothing to observe. Where it CAN, the general path projects
   * every row and pages the PROJECTED ones — so a skipped row's `CAST` does raise
   * (`skipcast_426`) — and this rung projects every row and slices, which raises the same.
   */
  const pageSkip = unsortedPageRoute(proj);

  if (pageSkip === null) {
    return null;
  }

  const [pattern] = m.patterns;

  // A path variable has to build a `Path` per row; a segment makes this a hop.
  if (pattern.pathVar !== undefined || pattern.segments.length !== 0) {
    return null;
  }

  const { start } = pattern;
  const nodeVar = start.variable;

  if (nodeVar === undefined) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const { where } = m;
  const gate = nodeScanGate(start, where, nodeVar);
  /**
   * ITEM 1610: the one key this scan's predicate asserts an equality on, decided ONCE PER QUERY.
   *
   * Item 1607 gave the exact-seed skip to `buildNodeCount` only, and the PROJECTION kept
   * re-validating every seeded candidate. After item 1609 removed the label test, that is what the
   * profile IS — ablating the gate here measured **34000/34958 ns -> 15407/16039, 2.2x**, the same
   * magnitude item 1607 measured on the count, and for an exact seed skipping it IS that ablation
   * rather than an approximation of it.
   *
   * From `nodeScanPreds`, the same list the gate above is composed from, so the verdict cannot
   * disagree with what is actually applied — `SeedCandidate`'s own argument, one level further out.
   */
  const soleKey = nodeScanSoleKey(start, where, nodeVar);

  if (gate === null) {
    return null;
  }

  const cols: string[] = [];
  const fns: CompiledExpr[] = [];
  /** Per item: the property key when it is `<nodeVar>.<key>`, else `undefined`. See the push. */
  const directKeys: (string | undefined)[] = [];

  for (const item of proj.items) {
    if (!itemLocal(item.expr)) {
      return null;
    }

    // The free-variable check is skipped for an item carrying a SUBQUERY. The reason first given
    // here was that `freePredicateVars` reports the variables bound INSIDE one; it does NOT — it
    // returns the empty set for a subquery, which item 213 established while tracking an
    // `ORDER BY` bug caused by exactly that. So for a BARE subquery the skip is a no-op, and it
    // matters only for a MIXED item such as `COUNT { … } + n.k`, where the arithmetic's own names
    // are reported and the subquery's are not.
    //
    // Nothing is lost. With exactly two clauses, one pattern and no segments, `nodeVar` is the
    // only name anything can be bound to, so both paths evaluate the SAME compiled expression
    // against a binding holding exactly that one name: a reference to any other name resolves
    // identically, or raises identically, on either. That is the same argument the check itself
    // rests on (see above), and mutation confirms removing it changes no answer.
    if (!hasSubquery(item.expr)) {
      for (const nameRead of freePredicateVars(item.expr)) {
        if (nameRead !== nodeVar) {
          return null;
        }
      }
    }

    cols.push(item.alias ?? columnName(item.expr));
    fns.push(compileExpr(item.expr));
    // A DIRECT READ for `<nodeVar>.<key>` (item 835). `compileExpr`'s `prop` arm is exactly
    // `(env) => propOf(env.binding.get(variable), key)`, so for the scan's OWN variable the
    // compiled closure writes the element into a `Map`, builds an `env`, and reads it straight
    // back out. Recording the key here lets the loop call `propOf(v, key)` on the vertex it
    // already holds — byte-identical by construction, because it is the same function on the same
    // element.
    //
    // This is the projection half of what items 224/230 did for PREDICATES (lifting
    // `<ownVar>.<key>` out of the general evaluator) and what item 803 did for the binding write.
    // Measured at item 833: the write, the env and the read-back-out are 11.3 ns a row together,
    // disjoint over three rounds.
    //
    // `variable === nodeVar` is REDUNDANT TODAY and kept deliberately — mutation says so: removing
    // it leaves all 2,634 tests green, because the `freePredicateVars` loop above has already
    // returned `null` for any item reading another name, and a `prop` expr carries no subquery so
    // that loop always ran for it. It is the coupling this read silently depends on, so it stays
    // as the thing that fails loudly if that check is ever loosened — the same reason the rollback
    // path keeps its `schema_reverted` guard. Item 475's rule: a surviving mutant on a new guard
    // means "redundant" as readily as "untested", and the two have opposite fixes.
    directKeys.push(
      item.expr.kind === 'prop' && item.expr.variable === nodeVar ? item.expr.key : undefined,
    );
  }

  // When EVERY item reads the element directly, nothing in the projection consults the binding, so
  // the per-vertex `Map` write is dead too — item 803's rule, applied to the projection.
  const allDirect = directKeys.every((k) => k !== undefined);

  // The sort is resolved AFTER `cols`, because the rule is about output columns and those are
  // what `cols` holds. `undefined` means no sort (the streaming path, unchanged); `null` declines.
  const sorts = outputColumnSorts(ret, cols);

  if (sorts === null) {
    return deferredRoute({
      proj,
      cstart: cm.patterns[0].start,
      label,
      gate,
      nodeVar,
      cols,
      fns,
      directKeys,
      soleKey,
    });
  }

  // THE TOP-K ARM (item 1064). `sorts` is a WINDOWED sort this rung already serves by projecting
  // every row and letting `sortRowsByColumns` select — so the answer is the same either way and
  // this is a pure route choice, which is why `topKPlan` is a tested pure function rather than a
  // condition inline here (`perf-gate-needs-its-own-test`).
  const topK = sorts === undefined ? undefined : topKPlan(sorts, cols, directKeys);

  if (topK !== undefined) {
    return topKNodeWalk({
      cstart: cm.patterns[0].start,
      label,
      gate,
      nodeVar,
      cols,
      fns,
      directKeys,
      keyProps: topK.keyProps,
      plan: topK.plan,
      soleKey,
    });
  }

  const labelName = label?.name;
  const width = cols.length;

  /**
   * HOIST THE PROPERTY BAG ONCE PER ROW when the projection reads MORE THAN ONE direct key off the
   * scan's own element (item 1741).
   *
   * `propOf(v, key)` is `v?.properties?.[key] ?? null`, so the loop below called the `properties`
   * GETTER once per column on the SAME vertex — five times a row for
   * `RETURN n.k, n.n, n.s, n.k, n.n`. Resolving it once is EXACTLY equivalent: the same getter on
   * the same element, and nothing in a projection expression can write, so the bag cannot change
   * between two columns of one row. Same values, same column order, byte-identical.
   *
   * ⚠️ GUARDED ON `> 1`, AND THE GUARD IS LOAD-BEARING. At width 1 the hoist saves no repeated
   * getter and adds one local, and the unguarded version measured the single-column shape ~10%
   * WORSE (`RETURN n.k AS a`: base 284/288/327 against 285/318/320). `RETURN <one column>` is far
   * too common to pay that for a wider shape's win. Guarded, it is flat: 285/326/289 -> 287/284/319.
   *
   * MEASURED at 1500 runs — NOT 300, which item 1740 established spreads 18% on this shape and
   * cannot resolve the effect — three alternated rounds, one arm per build, ms:
   *
   *     5 direct columns   630/635  ->  502/495/493     1.27x, ranges DISJOINT
   *     2 direct columns   517/496  ->  402/379/401     1.29x, ranges DISJOINT
   *     1 direct column    285/326/289 -> 287/284/319   flat (the guard)
   *     a DIFFERENT rung   470/475/479 -> 501/494/482   ~4% slower, the `executor-edits-perturb` toll
   *
   * The last row is the cost side and it is real: `hoprows` takes `hopProjection` and cannot reach
   * this code, so its ~4% is the perturbation an edit in this family imposes on neighbours (the
   * audit records 1.08-1.24x for that, so this is at the mild end). Taken because a multi-column
   * `RETURN` is a far more common shape than the margin is large.
   *
   * Per QUERY, from `directKeys` — which is already decided at compile time, like `allDirect`.
   */
  const hoistBag = directKeys.filter((k) => k !== undefined).length > 1;

  const cstart = cm.patterns[0].start;

  return (graph, params) => {
    const out: Row[] = [];
    // One binding map, reused across the scan. The general path allocates one per SCANNED row,
    // which is the difference this path exists to remove: `inlineHolds` and the projection both
    // overwrite the node's own variable per vertex, and `preds` and the items are CLOSED over
    // that one name, so nothing can read a stale entry.
    const binding = new Map<string, unknown>();
    // SEED FROM THE INDEX when one is cheaper than the label bucket. The decision, and the
    // 50x `bench:usage` regression that shaped it, are documented once on `scanCandidates`.
    const { vertices, seeded, eqKey } = scanCandidates(graph, cstart, label, labelName, {
      binding,
      params,
      graph,
    });

    // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
    // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
    // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
    // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
    // (item 1551), so a cached plan cannot carry it.
    const labelEff = effectiveLabel(graph, label);
    /**
     * Per CALL, because the verdict needs the candidate the seek actually chose.
     *
     * ⚠️ `seeded !== undefined` IS DEFENCE IN DEPTH, and mutation is why it is here rather than a
     * test. Making `hopSeekWithKey` report the chosen candidate's key even when it DECLINED the
     * seek survived the whole suite: on a declined seek the walk covers the whole label bucket, so
     * skipping the gate would emit every member — a wrong answer — but no fixture here reaches
     * that state. `seekIsWorthIt` carries a small-graph floor, so the 60-vertex fixtures seek even
     * for a two-value key; and a graph big enough to decline (measured: an indexed two-value key
     * reads 0.99x its unindexed twin at 20,000 vertices, a five-value key 1.11x, a fifty-value key
     * 33.74x) did not reproduce it either.
     *
     * Rather than keep hunting a fixture, the hazard is removed: exactness can only mean anything
     * for a SEEDED walk, so the skip asks for both. One comparison per call, and the mutant becomes
     * harmless instead of merely untested — which is the better outcome of the two.
     */
    const exactSeed = seeded !== undefined && seedIsExact({ eqKey }, soleKey);

    for (const v of vertices) {
      // The label is re-checked because a SEEDED set is a SUPERSET: an index hint is a
      // NECESSARY condition, not a sufficient one, so it can hand back a same-named vertex of
      // the wrong label. The bucket walk gets this for free by construction and the seek does
      // not — the same three tests in the same order as the hop seek's own loop. Two tests
      // caught the omission as a WRONG ANSWER, not as a slow one. Guarded on `seeded` so the
      // bucket walk — every unindexed graph — pays nothing for a test it satisfies by
      // construction; the same idiom this file already uses at the far-side walk.
      if (seeded !== undefined && !matchesLabel(v, labelEff)) {
        continue;
      }

      // ITEM 1610: an EXACT seed has already decided the predicate — the seeded set IS the
      // matching set — so re-validating every candidate is pure waste. The LABEL test above still
      // runs: the index returns vertices by VALUE across all labels.
      if (!exactSeed && gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      // Only SURVIVORS reach here, so the row object and the item evaluations are paid per
      // result rather than per scanned vertex.
      //
      // ⚠️ REJECTED, WITH ITS NUMBERS (item 1512): hoisting the `{ binding, params, graph }` below
      // out of the loop, so the env object is allocated once per call instead of once per
      // NON-DIRECT column per row. The profile nominated it — GC was 18.1% of a 200,000-row
      // projection — and the hoist is the established spelling at ~30 other sites in this file
      // family, so it looked like free money.
      //
      // It is flat. Measured on a projection of FOUR expression columns over 200,000 vertices, so
      // 800,000 allocations per call are removed rather than 200,000 (`gql-projection-reach-probe`'s
      // `exprcols` arm exists for exactly this; `wide` has only one non-direct column and cannot
      // resolve it against the ~15% ms-scale spread). Five isolated runs each, median of medians:
      //
      //     PRE  22.74 23.32 23.84 23.85 26.50  ->  23.84 ms
      //     POST 22.80 23.13 23.57 24.80 25.70  ->  23.57 ms      1.01x
      //
      // The arm was verified to take THIS rung (`nodeProjection`) before the numbers were read, so
      // the change did reach the executed loop. This is item 424's corollary again, in a new place:
      // **"it allocates per row" is not by itself a cost in this engine** — V8's young-generation
      // bump allocation is near-free, and an 18.1% GC share does not track allocation COUNT. The
      // remaining GC is the row objects themselves, which the API has to return.
      if (!allDirect) {
        binding.set(nodeVar, v);
      }

      const row: Row = {};

      if (hoistBag) {
        const bag = v.properties;

        for (let i = 0; i < width; i++) {
          const dk = directKeys[i];

          row[cols[i]] =
            dk === undefined ? fns[i]({ binding, params, graph }) : (bag?.[dk] ?? null);
        }
      } else {
        for (let i = 0; i < width; i++) {
          const dk = directKeys[i];

          row[cols[i]] = dk === undefined ? fns[i]({ binding, params, graph }) : propOf(v, dk);
        }
      }

      out.push(row);
    }

    // `sortGroupRows` is the tally's sorter and is reused deliberately: it goes through
    // `compareSort`, the engine's own comparator, whose doc states "the Rust `compare_sort`
    // matches" — so DESC and the NULLS placement cannot drift from native, and a second
    // comparator is exactly the thing byte-identity cannot survive.
    //
    // `Array.prototype.sort` is STABLE, so ties keep the scan's arrival order. That matters:
    // tie order under `ORDER BY` is OBSERVABLE between the engines — measured at item 605 over a
    // 60-row fixture with 20 ties per group, where TS and native agree exactly on every ordered
    // spelling — and this path scans the same candidate vertices in the same order the general
    // path does, so a stable sort preserves that agreement.
    // `sortRowsByColumns`, not `sortGroupRows`: the plan may carry a WINDOW (item 610), which
    // the tally's wrapper does not take — it pages through `pageGroups` instead.
    // `pageSkip` is item 1776's skip-only page, and it is NON-ZERO only when `sorts` is
    // `undefined`: it requires no `ORDER BY`, and `outputColumnSorts` returns `undefined` for
    // exactly that. A sorted window still rides `sortRowsByColumns`'s own plan, untouched here.
    if (pageSkip !== 0) {
      return pageSlice(out, pageSkip, params);
    }

    return sorts === undefined ? out : sortRowsByColumns(out, sorts);
  };
};
export const detectGroupedNodeCount = (clauses: readonly Clause[]): ReachFn | null => {
  const shape = groupedClauses(clauses);

  if (!shape) {
    return null;
  }

  const letName = shape.let?.var;
  const picked = groupedProjection(shape.ret.projection, letName);

  if (!picked) {
    return null;
  }

  const { items, skip, limit } = shape.ret.projection;
  const { countAt, sort, having, keyExpr, keyCol } = picked;
  const [{ start, segments }] = shape.match.patterns;

  if (segments.length !== 0 || start.variable === undefined) {
    return null;
  }

  // The start node's INLINE constraint and the clause `WHERE` are the two spellings of one
  // filter, so both are carried and both go through `inlineHolds` -> `satisfies` — the
  // general path's own implementation — rather than being re-derived here. Exactly the
  // arrangement `buildNodeCount` got in item 135; the grouped tally was left behind.
  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  const { where } = shape.match;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== start.variable) {
        return null;
      }
    }

    preds.push(predFor(compilePredicate(undefined, where, start.variable), start.variable, true));
  }

  // Fold the (at most two) predicates into ONE gate at compile time, or `undefined` when
  // there is nothing to apply.
  //
  // This is not style. The tally's loop runs once per vertex whether or not a predicate
  // exists, and written as `for (const ip of preds)` it allocated an iterator per vertex
  // over an EMPTY array — which cost the UNFILTERED grouped count, a shape this change was
  // not meant to touch, a consistent 34% (19.72 -> 26.4ms). Its control row caught that. An
  // indexed loop fixed it but `prefer-for-of` then objects, and the rule is right in general
  // and wrong here; composing instead removes the loop altogether, so there is no iterator
  // for the common case and no suppression comment to out-live its reason.
  const gate = composeInlineGate(preds);

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  // Two-clause: the key IS the property. Three-clause: the key is the `LET` name and the
  // property lives in the `LET`. One-column: the key is the `GROUP BY` element, which is one of
  // those two spellings again. Either way the grouped value must be one property of the matched
  // node; anything else falls through to the general path.
  let keySource: Expr | undefined = keyExpr;

  if (shape.let !== undefined) {
    keySource = keyExpr.kind === 'var' && keyExpr.name === letName ? shape.let.expr : undefined;
  }

  if (keySource?.kind !== 'prop' || keySource.variable !== start.variable) {
    return null;
  }

  const { key } = keySource;
  const countCol = items[countAt].alias ?? columnName(items[countAt].expr);
  const countFirst = countAt === 0;
  const labelName = label?.name;
  // The variable a `HAVING` reads its representative through — the node this tally groups.
  const repVar = start.variable;

  return (graph, params) => {
    if (pageIsEmpty(params, limit)) {
      return [];
    }

    const vertices: Iterable<Vertex> =
      labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? []);
    const groups = groupIndex();
    // One binding map, reused: `inlineHolds` overwrites the node's own variable per vertex
    // and nothing else reads it, which is what `preds` being CLOSED buys.
    const binding = new Map<string, unknown>();

    for (const v of vertices) {
      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      groups.bump(propOf(v, key), 1, v);
    }

    return pageGroups(
      sortGroupRows(
        keepGroups(groups.slots, having, repVar, params, graph).map((slot) =>
          groupedCountRow(slot, countCol, keyCol, countFirst),
        ),
        sort,
      ),
      params,
      skip,
      limit,
    );
  };
};
/**
 * `MATCH (n:L) RETURN max(n.k)` — the SCAN twin of `detectHopAggregate` (audit item 418), and
 * the same construction: one foldable aggregate over exactly the rows `detectNodeProjection`
 * already scans, folded as they are produced instead of grouped.
 *
 * The gap it closes, 200,000 vertices, min of 3 (audit item 420):
 *
 *     MATCH (a:P) RETURN max(a.k)    ~39ms   196ns/row, the general grouping path
 *     MATCH (a:P) RETURN a.k         ~8.4ms   42ns/row, the SAME rows, scanned
 *
 * `detectNodeProjection` compiles its own items, so the synthetic projection handed to it is
 * just the AST: the aggregate's argument as a single item. That means the argument expression is
 * compiled TWICE for an admitted query — once by `compileProjection` for `foldedAggs`, which this
 * path then ignores, and once by the scan. They compile the same AST node, so they cannot differ;
 * it is one wasted `compileExpr` per compile, not per row. (`detectHopAggregate` reuses
 * `foldedAggs[0].argFn` because the hop path takes a compiled twin; this one does not take one.)
 *
 * Admission is `detectHopAggregate`'s, for the reasons recorded there: ONE projection item which
 * must BE the aggregate by node identity, ONE foldable aggregate, and no GROUP BY, HAVING,
 * DISTINCT, ORDER BY or paging. `foldFor` is what keeps `sum`/`avg` out, and item 419 is why that
 * matters: they are order-DEPENDENT, and a fast path that may reorder rows changes their value.
 * A scan does not reorder — but the guard is inherited rather than re-argued, because the next
 * aggregate added to `foldFor` would otherwise arrive here unexamined.
 */
/**
 * A single COLLECTING aggregate (`sum`/`avg`) over an UNFILTERED scan (audit item 468).
 *
 * These have no entry in `foldFor` and cannot get one: `sum` chooses its operation by looking at
 * the WHOLE collection — a temporal anywhere means `temporalSum`, an array anywhere throws — so
 * it is inherently two-pass (item 467). What they do not need is the BINDINGS, which is where
 * the cost is: without a fold the general path keeps a group of them and maps each through the
 * argument, at ~125 ns a row (items 377, 465).
 *
 * **UNFILTERED ONLY, and that boundary is item 466's.** A float `sum` depends on summation
 * ORDER, so the streamed values must arrive in the same order the general path would fold them.
 * For an unfiltered scan that holds BY CONSTRUCTION: the shortcut walks
 * `verticesByLabel.get(name)` (or `verticesById.values()`) and `candidateVertexSource` returns
 * the very same container. Add a `WHERE` and the general path may seed from an index via
 * `seedVertices`, visiting in index order instead — a RUN-time decision on which indexes exist,
 * which is item 419's "observed, not promised" and item 411's trap. Hence: no clause `WHERE`, no
 * inline constraint, no label expression beyond a plain label.
 *
 * DISTINCT is excluded because the general path dedups by `valueKey` before aggregating, and
 * `star` because `sum(*)` is not a thing. Both are what `foldFor` refuses for the same reasons.
 *
 * **The unfiltered guard has NO TEST, and that is recorded rather than papered over.** Mutants
 * dropping the clause-`WHERE` check, the inline-constraint check and the segments check all
 * SURVIVE the suite. The DISTINCT and nullish guards do not — those were given teeth by a
 * duplicate value and an absent property respectively. The difference is that an order
 * divergence needs floats whose sum is order-dependent AND a general path that actually visits
 * in a different order, and I could not construct the second: a hash seek over a value every
 * row shares is wider than the bucket, so `seekIsWorthIt` declines it and scans; make it
 * selective and the index's per-value bucket holds those rows in insertion order anyway.
 *
 * So the boundary is justified by item 466's reasoning — `seedVertices` CAN visit in index
 * order, and whether it does is a run-time decision — and not by a demonstration. It stays
 * because conservative is the safe direction when the hazard is a silent last-bits difference,
 * and because item 419 is the entry about what happens when that judgement goes the other way.
 */
export const unfilteredScan = (m: Clause): boolean => {
  if (m.kind !== 'match') {
    return false;
  }

  // No filter of any kind: a clause `WHERE`, an inline constraint, or an inline node `WHERE`
  // each give the general path something to seed from.
  if (m.where !== undefined || m.patterns.length !== 1) {
    return false;
  }

  const [pattern] = m.patterns;

  return pattern.segments.length === 0 && plainNode(pattern.start);
};
export const unfilteredScanAgg = (
  m: Clause,
  ret: Clause,
): { name: string; frac: number; expr: Extract<Expr, { kind: 'func' }> }[] | undefined => {
  if (!unfilteredScan(m) || ret.kind !== 'return') {
    return undefined;
  }

  const { items } = ret.projection;

  if (items.length !== 1) {
    return undefined;
  }

  const [only] = items;
  // ITEM 1196: the aggregate need not BE the item. `collectAggregates` finds the one inside
  // `size(collect(a.k))` / `coalesce(collect(a.k), 1)`, and requiring EXACTLY one keeps the
  // single-accumulator contract the rest of this function is built on — a second aggregate
  // (`size(collect(a.k)) + count(*)`) still falls to the general path. Matching `only.expr`
  // directly, as this did, declined every wrapped spelling: measured at 6.65-7.97x the bare one.
  const found = collectAggregates(only.expr);

  if (found.length !== 1) {
    return undefined;
  }

  const [e] = found;

  if (e.star || e.distinct) {
    return undefined;
  }

  // The SINGLE-item gate, and the one that was actually refusing the five slow aggregates: it
  // ran ahead of the multi-item path, so widening only that one moved almost nothing (item 530).
  // `grep the pattern elsewhere` applies inside one file as readily as across a repo.
  const frac = percentileFraction(e);

  if (frac === null || !VALUES_AGGREGATES.has(e.name)) {
    return undefined;
  }

  return [{ name: e.name, frac, expr: e }];
};
export const detectNodeAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;
  // `sum`/`avg` have no entry in `foldFor`, so `foldedAggs` is undefined for them and this
  // used to bail here — which cost 4.6x, because the general path then materializes a GROUP OF
  // BINDINGS and maps each through the argument (item 465: `sum(n.age)` 43.7-48.0 ms against
  // `count(n.age)` 9.4-10.2 at 200,000 nodes).
  //
  // They cannot be folds — `sum` chooses its operation by looking at the WHOLE collection, so a
  // temporal anywhere means `temporalSum` and an array anywhere throws (item 467). But they do
  // not need the BINDINGS, only the VALUES, so this streams the values and hands them to
  // `aggregateOverValues` — the same function `compileAggregate` calls, which is what makes the
  // two identical by construction rather than by replication.
  const folded = proj.foldedAggs;
  // A COLLECTING aggregate (`sum`/`avg`) on an UNFILTERED scan, which `foldedAggs` cannot carry
  // because they are not folds. `undefined` when the shape does not qualify, in which case the
  // fold path below is the only one.
  const collect = folded === undefined ? unfilteredScanAgg(m, ret) : undefined;

  if (
    (folded?.length !== 1 && collect === undefined) ||
    proj.star ||
    proj.items.length !== 1 ||
    proj.having !== undefined ||
    !sortsOnOutputOnly(ret, proj) ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  // An explicit `GROUP BY` is refused twice, and the mutation run is what established which of
  // the two does the work. `compileProjection` sets `groupKeys` to the compiled GROUP BY
  // EXPRESSIONS when there are any, falling back to the non-aggregate items only when there are
  // not — so `groupKeys.length !== 0` already catches every written GROUP BY, and dropping the
  // AST check leaves `RETURN max(a.k) AS m GROUP BY a.k` correctly declined. It stays because the
  // synthetic projection below sets `groupBy: undefined`, which hides a GROUP BY from
  // `detectNodeProjection`'s own check, so this function is the last place that can see one; if
  // `groupKeys` ever stopped being populated from the GROUP BY, nothing downstream would notice.
  // (A first version of this comment claimed the AST check was the ONLY one looking. The mutant
  // that dropped it survived, which is how the claim was found to be wrong — a surviving mutant
  // can refute a comment as well as a test.)
  if (ret.projection.groupBy !== undefined || proj.groupKeys.length !== 0) {
    return null;
  }

  const [item] = ret.projection.items;
  const agg = folded?.[0];

  // By IDENTITY: `collectAggregates` finds the aggregate nested in `abs(min(n.k) - 10)` just the
  // same, and that shape needs the folded value substituted back into a group view. The
  // collecting path checks the same thing inside `unfilteredScanAgg`, which matched the item
  // itself rather than searching inside it.
  // THE AGGREGATE NEED NOT BE THE PROJECTION ITEM, on either path (items 1197 and 1198). The node
  // comes from whichever descriptor found it — `unfilteredScanAgg` searched inside the item for the
  // collecting path, `foldedAggs` for the fold path — and the folded value is handed to the
  // wrapping expression by `emit` below. Requiring identity here declined every wrapped spelling:
  // measured at 6.52-10.22x the bare one on the collecting path, and 8.12-9.46x on the fold path
  // (`upper(max(a.str))` 47.8ms against `min(a.num)`'s 3.9).
  const aggNode = collect !== undefined ? collect[0].expr : (agg?.expr ?? item.expr);

  // The THIRD arity gate in this one function, and the last one a percentile had to pass.
  // `percentileFraction` is `0` for a well-formed one-argument aggregate and the clamped
  // fraction for a well-formed percentile, so it says exactly what this gate wants to know for
  // both the fold path and the collecting one (item 530).
  if (aggNode.kind !== 'func' || percentileFraction(aggNode) === null) {
    return null;
  }

  const [argExpr] = aggNode.args;
  // When the aggregate is WRAPPED, the item's own expression still has to run — but ONCE, over a
  // one-row group view carrying the folded value under the aggregate's AST node. That is the key
  // `compileAggregate` already looks a pre-folded value up by, so the wrapping expression goes
  // through the SAME evaluator the general path uses instead of a second implementation of it.
  // `null` for the bare spelling, which must keep returning the aggregate value untouched.
  const outerFn = item.expr === aggNode ? null : compileExpr(item.expr);
  const outName = proj.items[0].name;
  /**
   * Apply the wrapping expression to a streaming closure's single row — or hand the closure back
   * untouched when there is nothing to wrap.
   *
   * ⚠️ A POST-PROCESSOR, not a change inside the loops, and that is MEASURED. The first build of
   * this item threaded the wrapping through each of the four streaming arms, which grew their
   * returned closures' captured environment and cost all three BARE controls in the same
   * direction — `max(a.num)` 0.84x, `count(a.num)` 0.89x and the `min(a.num)` floor 0.95x over
   * three alternated rounds — and making the row counter conditional did NOT recover it. That is
   * this repo's "TS closure size is load-bearing" hazard, and item 1184's measured rule that a
   * widening in place taxes the path it widened. Wrapping from OUTSIDE leaves all four loops
   * byte-identical, so the bare spelling is a path this change cannot reach at all.
   *
   * The group view's SIZE is deliberately unavailable: the arity gate above admits exactly ONE
   * aggregate, so nothing in the wrapping expression can read `group.length` — only a second
   * aggregate would. Rather than invent a number, the view THROWS if its length is ever read, so
   * widening that gate fails loudly instead of silently reporting a wrong count.
   */
  const applyOuter = (
    inner: (graph: Graph, params: Params) => Row[],
  ): ((graph: Graph, params: Params) => Row[]) => {
    if (outerFn === null) {
      return inner;
    }

    return (graph, params) => {
      const [row] = inner(graph, params);

      return [
        {
          [outName]: outerFn({
            binding: new Map<string, unknown>(),
            params,
            graph,
            group: foldedAggOnlyView(aggNode, row[outName]),
          }),
        },
      ];
    };
  };
  // A name no GQL identifier can collide with: the synthetic column is read back by key below.
  const VALUE_COL = ' nodeagg';
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

  const rowsFn = detectNodeProjection([m, synthRet], compiled);

  if (rowsFn === null) {
    return null;
  }

  // `rowsFn` above decided WHETHER to claim this shape; `vs` only changes HOW it runs — folding
  // the argument's values during the walk instead of materializing a `Row` per vertex.
  //
  // ⚠️ `vs` CANNOT BE NULL HERE, which is a change of reading rather than of code (item 1792).
  // This comment used to say a null "falls through to the row-reading loops below", and those
  // loops existed — but `detectNodeProjection` applies every condition `nodeScanOf` applies, so
  // `rowsFn !== null` already implies `vs !== null` and the fallback never ran. It is gone; the
  // branch DECLINES instead, which sends such a query to the general path rather than to a second
  // implementation that had to be kept in step with this one. See `valueScanOf`.
  //
  // `detectMultiNodeAggregate` materializes the same way and is NOT wired here: it reads SEVERAL
  // columns off each row, so it needs a per-aggregate accumulator set rather than one argument
  // function. Same lever, bigger change, measured separately.
  const vs = valueScanOf(m, compiled[0], argExpr);

  // THE COLLECTING PATH (item 468): stream the argument VALUES — one per row, no `Binding`
  // `Map` — and hand them to the same `aggregateOverValues` the general path runs. The nullish
  // filter mirrors the general path's `nonNull`, which is the same rule the fold path applies
  // per step.
  if (collect !== undefined) {
    const [{ name: aggName, frac }] = collect;

    if (vs !== null) {
      const { nodeVar: sv, label, labelName, cstart, gate, argFn, soleKey } = vs;

      return applyOuter((graph, params) => {
        const binding = new Map<string, unknown>();
        const env = { binding, params, graph };
        const { vertices, seeded, eqKey } = scanCandidates(graph, cstart, label, labelName, env);
        const values: unknown[] = [];

        // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
        // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
        // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
        // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
        // (item 1551), so a cached plan cannot carry it.
        const labelEff = effectiveLabel(graph, label);
        // Per CALL: the verdict needs the candidate the seek chose, and `seeded !== undefined` is
        // item 1610's designed-out hazard — exactness means nothing on a bucket walk.
        const exactSeed = seeded !== undefined && seedIsExact({ eqKey }, soleKey);

        for (const v of vertices) {
          if (seeded !== undefined && !matchesLabel(v, labelEff)) {
            continue;
          }

          // ITEM 1611: an EXACT seed has already decided the predicate — the same skip item 1607 gave
          // the count and item 1610 the streaming projection, now at the five walks that still
          // re-validated. Ablating these gates priced them at 1.39-1.84x before anything was built.
          // The LABEL test above still runs: a seek returns vertices by VALUE across all labels.
          if (!exactSeed && gate !== undefined && !gate(v, binding, params, graph)) {
            continue;
          }

          binding.set(sv, v);

          const value = argFn(env);

          if (!isNullish(value)) {
            values.push(value);
          }
        }

        return [{ [outName]: aggregateOverValues(aggName, values, frac) }];
      });
    }

    // ⚠️ UNREACHABLE, AND IT USED TO BE A ROW-READING FALLBACK. `rowsFn` is non-null above, and
    // `detectNodeProjection` applies every condition `nodeScanOf` applies — one pattern, a bound
    // node variable, a plain `:label` rather than a label EXPRESSION, and a non-null
    // `nodeScanGate` — plus more of its own. So `rowsFn !== null` implies `nodeScanOf !== null`
    // and `vs` cannot be null here. Item 1792 deleted the fallback body: 296 arrivals at this
    // gate across the gql suite, every one `vs !== null`, and a `throw` placed in the body raised
    // nothing across 21 projects or the seven fuzzers' 20,000 queries.
    //
    // DECLINING rather than asserting: if the two gates are ever allowed to drift apart, the
    // query goes to the general path and is answered correctly but slower, which is the failure
    // this file can afford. A thrown invariant would turn a planner change into a user-visible
    // crash.
    return null;
  }

  const { fold } = agg!;

  if (vs !== null) {
    const { nodeVar: sv, label, labelName, cstart, gate, argFn, soleKey } = vs;

    return applyOuter((graph, params) => {
      const binding = new Map<string, unknown>();
      const env = { binding, params, graph };
      const { vertices, seeded, eqKey } = scanCandidates(graph, cstart, label, labelName, env);
      let acc = fold.init();

      // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
      // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
      // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
      // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
      // (item 1551), so a cached plan cannot carry it.
      const labelEff = effectiveLabel(graph, label);
      // Per CALL: the verdict needs the candidate the seek chose, and `seeded !== undefined` is
      // item 1610's designed-out hazard — exactness means nothing on a bucket walk.
      const exactSeed = seeded !== undefined && seedIsExact({ eqKey }, soleKey);

      for (const v of vertices) {
        if (seeded !== undefined && !matchesLabel(v, labelEff)) {
          continue;
        }

        // ITEM 1611: an EXACT seed has already decided the predicate — the same skip item 1607 gave
        // the count and item 1610 the streaming projection, now at the five walks that still
        // re-validated. Ablating these gates priced them at 1.39-1.84x before anything was built.
        // The LABEL test above still runs: a seek returns vertices by VALUE across all labels.
        if (!exactSeed && gate !== undefined && !gate(v, binding, params, graph)) {
          continue;
        }

        binding.set(sv, v);

        const value = argFn(env);

        if (!isNullish(value)) {
          acc = fold.step(acc, value);
        }
      }

      // The same `fold.finish` over an untouched accumulator that gives an EMPTY scan its one
      // row holding null, which is what an ungrouped aggregate owes ISO.
      return [{ [outName]: fold.finish(acc) }];
    });
  }

  // ⚠️ UNREACHABLE, AND IT USED TO BE A ROW-READING FALLBACK. `rowsFn` is non-null above, and
  // `detectNodeProjection` applies every condition `nodeScanOf` applies — one pattern, a bound
  // node variable, a plain `:label` rather than a label EXPRESSION, and a non-null
  // `nodeScanGate` — plus more of its own. So `rowsFn !== null` implies `nodeScanOf !== null`
  // and `vs` cannot be null here. Item 1792 deleted the fallback body: 296 arrivals at this
  // gate across the gql suite, every one `vs !== null`, and a `throw` placed in the body raised
  // nothing across 21 projects or the seven fuzzers' 20,000 queries.
  //
  // DECLINING rather than asserting: if the two gates are ever allowed to drift apart, the
  // query goes to the general path and is answered correctly but slower, which is the failure
  // this file can afford. A thrown invariant would turn a planner change into a user-visible
  // crash.
  return null;
};
/**
 * One projected aggregate's accumulator in the MULTI-aggregate scan path (item 469).
 *
 * `rows` is `count(*)`, which needs no value at all — it counts rows, nullish included, which
 * is why it is a separate arm rather than a fold over a projected column.
 */
export type MultiAcc =
  | { readonly kind: 'rows'; readonly out: string }
  | {
      readonly kind: 'fold';
      readonly out: string;
      readonly fold: AggFold;
      readonly col: string;
      /**
       * The aggregate's ARGUMENT, compiled (item 652). The streaming walk evaluates this per
       * vertex; `col` is the synthetic column the row-reading fallback reads instead. Both are
       * carried because that fallback is still the only implementation for a shape the walk
       * cannot drive.
       */
      readonly argFn: CompiledExpr;
    }
  | {
      readonly kind: 'collect';
      readonly out: string;
      readonly name: string;
      readonly col: string;
      /** The percentile fraction, already clamped. 0 for every other name, which ignores it. */
      readonly frac: number;
      /** See the `fold` variant's `argFn`. */
      readonly argFn: CompiledExpr;
    };
/**
 * `MATCH (n:L) [WHERE …] RETURN agg1(…) AS a, agg2(…) AS b, …` — TWO OR MORE aggregates over
 * one scan, each accumulated as the rows are produced.
 *
 * WHY THIS EXISTS. `detectNodeAggregate` takes `proj.items.length !== 1` as a hard refusal, so a
 * projection asking for two aggregates — the ordinary analytic shape — fell off the ladder
 * whole and materialized a `Binding` per row. Measured at 200,000 nodes (item 469):
 * `count(n.age)` alone is 9.4 ms and `sum(n.age)` 12.8, but `count(n.age), count(*)` is 46.4,
 * `min(n.age), max(n.age)` 41.2 and `sum(n.age), avg(n.age)` 64.0 — roughly 4.9x the single-item
 * path for each, and NOT a property of `sum`: the all-foldable pairs pay it too. The general
 * path already streams multiple folds (`stepFolded`), so the cost is the matcher and the
 * per-row binding, not the accumulation.
 *
 * The admission rules are the single-item path's, applied per item rather than once:
 *
 *   - every item must BE an aggregate — a non-aggregate item is a GROUP KEY, and the
 *     `groupKeys` check above refuses those;
 *   - `count`/`min`/`max` accumulate through `foldFor`, the same source the general path's
 *     `stepFolded` reads, so the two cannot drift;
 *   - `sum`/`avg` cannot be folds (item 467) and collect their values for the shared
 *     `aggregateOverValues`, which — exactly as in item 468 — is admitted only on an
 *     UNFILTERED scan, because a filtered one may seed from an index and fold floats in a
 *     different order (items 419, 466);
 *   - `count(*)` counts rows and needs no projected column;
 *   - `DISTINCT` is refused per item, because the general path dedupes by value first.
 */
/**
 * Finish a multi-aggregate accumulator set into its single output row. Shared by the streaming
 * walk and the row-reading fallback (item 652) so the two cannot drift: `fold.finish` over an
 * untouched accumulator is what gives an EMPTY scan its one row holding null, and
 * `aggregateOverValues` is the same function the general path calls.
 */
export const finishMultiAccs = (
  accs: readonly MultiAcc[],
  state: readonly unknown[],
  n: number,
): Row => {
  const out: Row = {};

  for (let i = 0; i < accs.length; i += 1) {
    const a = accs[i];

    if (a.kind === 'rows') {
      out[a.out] = n;
    } else if (a.kind === 'fold') {
      out[a.out] = a.fold.finish(state[i]);
    } else {
      out[a.out] = aggregateOverValues(a.name, state[i] as unknown[], a.frac);
    }
  }

  return out;
};
export const detectMultiNodeAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  // `items.length < 2` leaves the one-item shapes to `detectNodeAggregate`, which runs first and
  // has its own tests: the two rungs are disjoint by arity, so this one cannot regress those.
  if (
    proj.star ||
    proj.items.length < 2 ||
    proj.having !== undefined ||
    !sortsOnOutputOnly(ret, proj) ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    ret.projection.groupBy !== undefined ||
    proj.groupKeys.length !== 0
  ) {
    return null;
  }

  const unfiltered = unfilteredScan(m);
  const accs: MultiAcc[] = [];
  const synthItems: { expr: Expr; alias: string }[] = [];

  for (const [i, item] of ret.projection.items.entries()) {
    const e = item.expr;
    const out = proj.items[i].name;

    if (e.kind !== 'func' || e.distinct) {
      return null;
    }

    if (e.star) {
      if (e.name !== 'count' || e.args.length !== 0) {
        return null;
      }

      accs.push({ kind: 'rows', out });
      continue;
    }

    // The PERCENTILES take `(value, <numeric literal>)`; every other aggregate takes one
    // argument. A malformed percentile call is REFUSED rather than diagnosed here, so the
    // general path raises the same error it always did (item 530).
    const frac = percentileFraction(e);

    if (frac === null) {
      return null;
    }

    const [arg] = e.args;
    // A name no GQL identifier can collide with, one per item.
    const col = ` nodeagg${i}`;
    const fold = foldFor(e.name, false, false);

    const argFn = compileExpr(arg);

    if (fold !== undefined) {
      accs.push({ kind: 'fold', out, fold, col, argFn });
    } else if (VALUES_AGGREGATES.has(e.name) && unfiltered) {
      accs.push({ kind: 'collect', out, name: e.name, col, frac, argFn });
    } else {
      return null;
    }

    synthItems.push({ expr: arg, alias: col });
  }

  // All-`count(*)` projects nothing, and `detectNodeProjection` needs an item.
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
  const rowsFn = detectNodeProjection([m, synthRet], compiled);

  if (rowsFn === null) {
    return null;
  }

  // STREAM the accumulators during the walk instead of over a materialized `Row[]` (item 652,
  // item 651's lever at the multi-aggregate site). `rowsFn` above still decides WHETHER the shape
  // is claimed, so nothing becomes newly claimable; this only changes HOW.
  //
  // Measured at 200,000 vertices, min of three alternated rounds: `max(n.w), min(n.w)` 8.99 ms
  // and `max(n.w), min(n.k)` 9.13, against 3.54 for the SINGLE-aggregate spelling over the same
  // column — which 651 had already put on a streaming walk. A second accumulator is one extra
  // fold step per row; it was costing 2.5x, and the difference was the `Row` per vertex.
  const vs = nodeScanOf(m, compiled[0]);

  if (vs !== null) {
    const { nodeVar: sv, label, labelName, cstart, gate, soleKey } = vs;

    return (graph, params) => {
      const binding = new Map<string, unknown>();
      const env = { binding, params, graph };
      const { vertices, seeded, eqKey } = scanCandidates(graph, cstart, label, labelName, env);
      const state = accs.map((a) => (a.kind === 'fold' ? a.fold.init() : ([] as unknown[])));
      let n = 0;

      // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
      // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
      // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
      // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
      // (item 1551), so a cached plan cannot carry it.
      const labelEff = effectiveLabel(graph, label);
      // Per CALL: the verdict needs the candidate the seek chose, and `seeded !== undefined` is
      // item 1610's designed-out hazard — exactness means nothing on a bucket walk.
      const exactSeed = seeded !== undefined && seedIsExact({ eqKey }, soleKey);

      for (const v of vertices) {
        // The row path's exact order: label recheck, then gate, then `binding.set`. The gate
        // takes the vertex explicitly and runs before the binding is set.
        if (seeded !== undefined && !matchesLabel(v, labelEff)) {
          continue;
        }

        // ITEM 1611: an EXACT seed has already decided the predicate — the same skip item 1607 gave
        // the count and item 1610 the streaming projection, now at the five walks that still
        // re-validated. Ablating these gates priced them at 1.39-1.84x before anything was built.
        // The LABEL test above still runs: a seek returns vertices by VALUE across all labels.
        if (!exactSeed && gate !== undefined && !gate(v, binding, params, graph)) {
          continue;
        }

        binding.set(sv, v);
        n += 1;

        // An INDEX loop, not `accs.entries()`, for item 469's measured reason: the iterator
        // allocates a `[i, a]` tuple per accumulator per row, which alone cost
        // `count(n.age), count(*)` 17.8 ms against 9.4 at 200,000 rows.
        //
        // 🛑 DEDUPLICATING IDENTICAL ARGUMENTS IS REFUTED FOR THE COMMON CASE (item 653), and
        // item 652 recorded it as open before it was priced. `max(n.w), min(n.w)` evaluates
        // `n.w` twice per vertex, so a compile-time grouping by argument expression looked free.
        // Priced with NO code written, using `max(n.w), count(*)` — structurally the CSE'd shape,
        // since it holds the accumulator count at two and varies only the number of argument
        // evaluations (652 measured the `rows` arm as free). 200,000 vertices, min of three
        // alternated rounds:
        //
        //   max(n.w), min(n.w)   TWO evals   6.13 ms
        //   max(n.w), count(*)   ONE eval    6.46      <- two evals is FASTER
        //   grouped twin                     8.06 against 7.76 (3.9%, under the noise floor)
        //
        // A bare property read off an already-bound vertex is the cheapest expression there is,
        // and evaluating it twice costs less than any machinery to avoid it. Since two evals
        // measure FASTER than one here, an always-dedup would add an extra loop level to a path
        // where the saving is zero — a REGRESSION on the shape people actually write.
        //
        // The other half of the enum is real but narrow: with an EXPENSIVE shared argument
        // (`abs(n.w) * 2 + 1`) the same pair reads 27.23 against 20.85, about 1.31x. Capturing
        // it would need a cost model to decide "is this argument expensive", because applying it
        // unconditionally loses the cheap case above. That is a lot of apparatus for
        // `max(<non-trivial expr>), min(<the same expr>)`, so it is NOT built.
        for (let i = 0; i < accs.length; i += 1) {
          const a = accs[i];

          if (a.kind === 'rows') {
            continue;
          }

          const value = a.argFn(env);

          if (isNullish(value)) {
            continue;
          }

          if (a.kind === 'fold') {
            state[i] = a.fold.step(state[i], value);
          } else {
            (state[i] as unknown[]).push(value);
          }
        }
      }

      return [finishMultiAccs(accs, state, n)];
    };
  }

  // ⚠️ UNREACHABLE, AND IT USED TO BE A ROW-READING FALLBACK. `rowsFn` is non-null above, and
  // `detectNodeProjection` applies every condition `nodeScanOf` applies — one pattern, a bound
  // node variable, a plain `:label` rather than a label EXPRESSION, and a non-null
  // `nodeScanGate` — plus more of its own. So `rowsFn !== null` implies `nodeScanOf !== null`
  // and `vs` cannot be null here. Item 1792 deleted the fallback body: 296 arrivals at this
  // gate across the gql suite, every one `vs !== null`, and a `throw` placed in the body raised
  // nothing across 21 projects or the seven fuzzers' 20,000 queries.
  //
  // DECLINING rather than asserting: if the two gates are ever allowed to drift apart, the
  // query goes to the general path and is answered correctly but slower, which is the failure
  // this file can afford. A thrown invariant would turn a planner change into a user-visible
  // crash.
  return null;
};
/**
 * `MATCH (n:L) [WHERE <row-local>] RETURN n.k AS key, <aggregates…>` — a GROUPED aggregate over
 * a scan, where the aggregates are not all `count(*)`.
 *
 * WHY THIS EXISTS. `detectGroupedNodeCount` is a TALLY: it takes exactly two items, one of them
 * `count(*)`, and bumps an integer. Anything else — one `max`, or a `count(*)` with a second
 * aggregate beside it — falls to the general path, a `Binding` per row. Measured at 200,000
 * nodes (item 474): `n.age AS k, count(*)` 2.9 ms (the tally), `n.age AS k, max(n.age)` **53.2**,
 * `n.age AS k, count(*), max(n.age)` **85.8**. 18x and 30x for the same grouping over the same
 * scan. Native answers all three in 1.0-1.4 ms, so this is TS-only.
 *
 * The admission set is `foldFor`'s plus `count(*)`. `sum`/`avg` are NOT admitted: a grouped sum
 * over floats depends on the order values reach their group, and a FILTERED scan may seed from
 * an index (items 419, 466, 468). The unfiltered case would be safe by the item-466 argument,
 * but a grouped path that takes `sum` only when unfiltered is a guard with no test — item 468
 * recorded how that goes — so it waits for a shape that can be demonstrated.
 */
export const detectGroupedNodeAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1) {
    return null;
  }

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  // Paging and ordering are the tally's business (items 190, 199); this rung answers the plain
  // shape and leaves the rest to the general path rather than re-deriving a window.
  if (
    proj.star ||
    proj.distinct ||
    proj.items.length < 2 ||
    proj.having !== undefined ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  const [pattern] = m.patterns;
  const { start, segments } = pattern;
  const nodeVar = start.variable;

  if (segments.length !== 0 || nodeVar === undefined || pattern.pathVar !== undefined) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  // Exactly ONE non-aggregate item, and it must be a property of the matched node — the same
  // restriction the tally works under, and what makes the group key one `propOf` a vertex.
  // UNFILTERED means both spellings of a filter are absent — the start node's INLINE constraint
  // and the clause `WHERE`. `groupedAccs` needs it to admit an aggregate with no streaming fold;
  // `inlineOf` is read again below for the gate itself.
  const unfiltered = inlineOf(start) === undefined && m.where === undefined;
  const picked = groupedAccs(ret.projection.items, proj.items, nodeVar, unfiltered);

  if (picked === null) {
    return null;
  }

  const { accs, keyExpr, keyCol } = picked;

  // An explicit `GROUP BY` must name the key this path groups by; `groupKeys` is the compiled
  // form and `sameGroupingExpr` is the rule item 199 applied to the tally.
  const written = ret.projection.groupBy;

  if (written?.length === 1 ? !sameGroupingExpr(written[0], keyExpr) : written !== undefined) {
    return null;
  }

  const { key } = keyExpr;
  const keyAt = ret.projection.items.findIndex((i) => i.expr === keyExpr);
  // Resolved HERE rather than in the gate, because it needs the output columns and the grouping
  // expression. `null` declines the whole rung; otherwise it is the sort to apply, which is the
  // IDENTITY when the query has no `ORDER BY`.
  const applySort = groupedSortApplier(
    ret.projection.orderBy ?? [],
    proj.items.map((i) => i.name),
    keyCol,
    keyExpr,
  );

  if (applySort === null) {
    return null;
  }

  // The start node's INLINE constraint and the clause `WHERE` are the two spellings of one
  // filter, and both go through the general path's own `inlineHolds` / `compilePredicate`.
  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  const { where } = m;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== nodeVar) {
        return null;
      }
    }

    preds.push(predFor(compilePredicate(undefined, where, nodeVar), nodeVar, true));
  }

  // Composed rather than looped, for the reason item 141 measured on the tally: a `for…of` over
  // an EMPTY predicate array cost the unfiltered shape 34%.
  const gate = composeInlineGate(preds);
  const labelName = label?.name;

  return (graph, params) => {
    const vertices: Iterable<Vertex> =
      labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? []);
    // First-seen group order, which is the contract both engines keep.
    const slots: { readonly key: unknown; n: number; readonly state: unknown[] }[] = [];
    const bySeen = new Map<unknown, (typeof slots)[number]>();
    // ONE binding map for the whole scan, overwritten per vertex — the general path's cost is
    // a fresh `Map` per row, which is what this rung exists to avoid.
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };

    for (const v of vertices) {
      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      const raw = propOf(v, key);
      // `valueKey` for a structural value, the value itself for a primitive: the same split
      // `groupIndex` makes, and it keeps a `Map` lookup off the string path for the common case.
      const id = raw === null || typeof raw !== 'object' ? raw : valueKey(raw);
      let slot = bySeen.get(id);

      if (slot === undefined) {
        slot = {
          key: raw,
          n: 0,
          state: accs.map((a) => {
            if (a.kind === 'fold') {
              return a.fold.init();
            }

            return a.kind === 'values' ? [] : 0;
          }),
        };
        bySeen.set(id, slot);
        slots.push(slot);
      }

      slot.n += 1;
      binding.set(nodeVar, v);

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (a.kind === 'rows') {
          continue;
        }

        const value = a.argFn(env);

        // The same nullish rule as every other fold in this file and in `stepFolded`.
        if (isNullish(value)) {
          continue;
        }

        if (a.kind === 'values') {
          (slot.state[i] as unknown[]).push(value);
        } else {
          slot.state[i] = a.fold.step(slot.state[i], value);
        }
      }
    }

    const rows = slots.map((slot) => {
      const row: Row = {};

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (i === keyAt) {
          row[keyCol] = slot.key;
        } else if (a.kind === 'rows') {
          row[a.out] = slot.n;
        } else if (a.kind === 'values') {
          row[a.out] = aggregateOverValues(a.name, slot.state[i] as unknown[], a.frac);
        } else {
          row[a.out] = a.fold.finish(slot.state[i]);
        }
      }

      return row;
    });

    // One row per GROUP, so this sorts at most what the query returns — the tally's own argument
    // (`sortGroupRows`), and it uses `compareSort` so DESC and NULLS placement match the engine
    // rather than being re-derived here.
    return applySort(rows);
  };
};
