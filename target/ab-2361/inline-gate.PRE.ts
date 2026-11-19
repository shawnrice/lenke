/**
 * THE INLINE-PREDICATE GATE: can a rung serve this pattern\'s inline properties itself, or must it
 * decline to the general matcher?
 *
 * ⚠️ THE MOST-SHARED MACHINERY IN THE RUNG LADDER, and the reason it is its own module (item 1669):
 * ten or eleven of the thirteen `detect*` entry points reach `inlineHolds`, `inlinePredOf`,
 * `predFor` and `composeInlineGate`. Every rung has to answer the same question before it can claim
 * a query, so the answer belongs below all of them rather than inside the file they used to share.
 *
 * ⚠️ `composeInlineGate` IS WHERE "EQUIVALENT SPELLINGS COST THE SAME" IS ENFORCED, and it is the
 * defect class CLAUDE.md opens with. A clause `WHERE u.k = 5` and an inline `{k: 5}` are the same
 * predicate written two ways; a rung that recognises one and declines the other makes them cost
 * 100-300x differently while returning identical answers, so no correctness test can see it. Audit
 * item 125 measured exactly that — a 4x gap between a clause `WHERE` and an inline `{k: v}` on a
 * one-hop count — and this gate is what keeps the two converged.
 *
 * ⚠️ `specializedConjunct` IS A PERFORMANCE DECISION WITH A CORRECTNESS EDGE. Specializing a
 * conjunct is sound only when the predicate has an operator form; `undefined` means it does not,
 * and then the caller must keep the general `matches` path. Item 1492 measured the specialization
 * at 14.20 -> 5.45 ns a vertex, so the temptation to widen it is real — but a specialization that
 * covers a shape it cannot evaluate is a wrong answer, not a slow one.
 */

import type { Edge, Graph, Vertex } from '@lenke/core';

import type { NodePattern } from '../ast.js';
import { compilePredicate, specializeNarrowPred } from './core.js';
import type { CPredicate, EvalEnv, Params } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import { plainNode } from './hop-sides.js';
import { satisfies } from './predicates.js';

/** 1-hop `(a)-[:T]->(b)` count: bucket sizes (unlabeled) or a filtered bucket
 * scan. `null` if the segment can't be bucket-counted (both/And/Not/wildcard). */
/**
 * An endpoint's INLINE constraint, carried into the tally.
 *
 * `MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*)` is the same question as the
 * clause-`WHERE` spelling and cost 4x more, because `plainNode` rejected the node
 * and the whole shortcut declined (audit item 124). The predicate is the COMPILED
 * one and it is applied through `satisfies` — the general path's own
 * implementation of inline-pattern semantics (`structuralEq`, and a NULL on an
 * absent key dropping the row) — so the two spellings agree by construction
 * rather than because the equivalence was re-derived here.
 *
 * `bindVar` is the node's own variable, bound before `satisfies` runs so an inline
 * `(b WHERE b.k = 2)` can see itself.
 */
export type InlinePred = { pred: CPredicate; bindVar?: string };
export const predFor = (
  pred: CPredicate,
  ownVar: string | undefined,
  closedProps: boolean,
): InlinePred =>
  ownVar !== undefined && (pred.where !== undefined || (!closedProps && pred.props.length > 0))
    ? { pred, bindVar: ownVar }
    : { pred };
/** A composed per-element filter: every carried `InlinePred` must hold. */
export type InlineGate = (
  element: Vertex,
  binding: Map<string, unknown>,
  params: Params,
  graph: Graph,
) => boolean;
/**
 * The node's inline constraint as an `InlinePred`, or `null` if it must not be
 * carried.
 *
 * Only CLOSED constraints are accepted — every inline property VALUE must have no
 * free variables, and an inline `WHERE` may read nothing but the node's own
 * variable. `(b {k: 2})` and `(b {k: $p})` qualify; `(b {k: a.k})` does not,
 * because the tally would have to bind `a` per edge and that is the correlation
 * problem of items 121-123, not this one. `undefined` means the node is plain and
 * there is nothing to carry.
 */
/**
 * The part of an inline constraint that is the same for a NODE and a RELATIONSHIP: the
 * properties must be CLOSED, and an inline `WHERE` must read nothing but the element's own
 * variable. Extracted so `relInlineOf` is the same rule rather than a second copy of it —
 * item 633's first version drew its edge-side rule by hand and dropped a predicate.
 *
 * The two callers differ only in what counts as "plain", which is why that check stays with
 * them.
 */
export type InlineShape = Pick<NodePattern, 'properties' | 'where' | 'variable'>;
export const inlinePredOf = (n: InlineShape): InlinePred | null => {
  for (const c of n.properties ?? []) {
    if (freePredicateVars(c.value).size > 0) {
      return null;
    }
  }

  if (n.where !== undefined) {
    // An inline `WHERE` is evaluated with the node bound to its own variable, so
    // it needs one, and it may read nothing else.
    if (n.variable === undefined) {
      return null;
    }

    for (const name of freePredicateVars(n.where)) {
      if (name !== n.variable) {
        return null;
      }
    }
  }

  // The node's OWN variable is passed, which is sound exactly here: the loop above has just
  // proved the inline `WHERE` reads nothing but it. A clause `WHERE` cannot make that claim and
  // so never takes this route. `closedProps` is `true` for the same reason — the FIRST loop in
  // this function is the proof `predFor` asks for.
  return predFor(compilePredicate(n.properties, n.where, n.variable), n.variable, true);
};
export const inlineOf = (n: NodePattern): InlinePred | null | undefined =>
  plainNode(n) ? undefined : inlinePredOf(n);
/** Apply an endpoint's inline constraint, binding the node's own variable first. */
export const inlineHolds = (
  ip: InlinePred | undefined,
  // `Edge` as well as `Vertex` since item 637: the same call applies a rel's inline
  // constraint per edge. `satisfies` is element-generic already — `matchRel` passes it an
  // edge — so only this signature was narrower than the thing it calls.
  element: Vertex | Edge,
  binding: Map<string, unknown>,
  params: Params,
  graph: Graph,
): boolean => {
  if (ip === undefined) {
    return true;
  }

  if (ip.bindVar !== undefined) {
    binding.set(ip.bindVar, element);
  }

  return satisfies(element, ip.pred, binding, params, graph);
};
/**
 * `MATCH (n:L) WHERE <row-local pred> RETURN <row-local items>` — a label scan, a filter, and a
 * projection, with no hop, no aggregate and no window.
 *
 * This is the simplest query there is and it was the one shape in the file with no fast path.
 * `detectCountShortcut` answered the `count(*)` form, `detectHopProjection` needs a hop
 * (`segments.length !== 1` declines a bare node), `detectDistinctProjection` needs a `DISTINCT` —
 * so a plain point lookup fell through to the general pipeline, which materializes a binding per
 * SCANNED row. Measured on 20,000 vertices, one property equality, projecting one property:
 *
 *     a hand-written label-bucket loop            6.8ns a vertex
 *     count(*) over the same scan (its shortcut)  30.6ns
 *     the projection form                         83.3ns     <- 12.2x the floor
 *
 * `bench:usage` shows the consequence: every UNINDEXED read there is 60-82x behind native while
 * the indexed ones are a healthy 3x, because an index turns the scan into a seek and hides this
 * (audit item 204).
 *
 * The gate is built exactly as the grouped tally's is — the inline `{k: v}` constraint and the
 * clause `WHERE` are two spellings of one filter, both funnelled through `inlineHolds` ->
 * `satisfies`, which is the general path's own implementation rather than a re-derivation. The
 * composition via `reduceRight` is load-bearing for the same measured reason recorded there: an
 * `for (const ip of preds)` allocated an iterator per vertex over an empty array and cost an
 * unfiltered scan 34%.
 */
/**
 * A single-node scan's filter gate: the start node's INLINE constraint and the clause `WHERE`
 * composed into one predicate, `undefined` for no filter, or `null` to decline the shape.
 *
 * Extracted (item 651) so the row-projecting path and the aggregate paths build the SAME gate
 * from the same pieces. That matters more than the saved lines: an aggregate path assembling its
 * own gate could admit a shape the row path declines, or filter differently — wrong answers, not
 * slow ones. Both spellings go through the general path's own `inlineHolds` / `nodeWhereOf`,
 * which is what keeps this filter identical to the general path's rather than merely similar.
 *
 * ⚠️ NOT shared with `detectGroupedNodeAggregate`, whose gate is character-identical at the
 * `reduceRight` and at everything above the `WHERE` — but carries the `WHERE` through
 * `compilePredicate` and its own `freePredicateVars` loop instead of `nodeWhereOf`. The two are
 * not interchangeable, and an anchored edit here matches BOTH sites; that is how this was found.
 *
 * The free-variable checks on the `WHERE` and on each item are DEFENSIVE, not load-bearing,
 * and mutation confirms it: with exactly two clauses, one pattern and no segments, `nodeVar`
 * is the ONLY name anything can be bound to — there is no earlier clause to bind another and
 * no far end to introduce one, so a reference to any other name does not resolve at all.
 * Removing either check changes no answer. They stay because that argument depends on the
 * clause-count and segment-count guards above keeping their exact shape, and because
 * (An earlier version of this note claimed `freePredicateVars` descends into a subquery and so
 * would catch one here. It does NOT — it returns the empty set for `exists` / `countSubquery` /
 * `valueSubquery`, per item 213 — so the ALLOWLIST is the only thing refusing a subquery, and
 * these checks are purely about outer names.) The same reasoning, and the same
 * wording, as `detectHopProjection`'s rel-variable and path-variable checks.
 */
/**
 * EVERY carried `InlinePred` must hold, composed into ONE closure — the single implementation of a
 * per-element inline gate.
 *
 * ⚠️ ITEM 1601 EXTRACTED THIS FROM EIGHT IDENTICAL COPIES, and the duplication was not cosmetic:
 * item 1600 put its fast arm in `nodeScanGate`'s copy and the other seven — the three-hop interior,
 * the two-hop middle, the keyed, anchored and far-side walks — silently kept the slow one. That is
 * the shape this file's own note warns about ("two copies of one shape rule is how the far endpoint
 * ended up on a per-edge tally once before"), realized as a performance divergence rather than a
 * wrong answer.
 *
 * `reduceRight` rather than a loop, and that is load-bearing for the measured reason recorded at
 * `gateWith`: a `for (const ip of preds)` allocated an iterator per element over an empty array and
 * cost an unfiltered scan 34%.
 *
 * The conjuncts stay in WRITTEN order (inline before clause), which is what lets an inline filter
 * matching nothing short-circuit a faulting clause `WHERE` — both engines do this.
 */
export const composeInlineGate = (preds: readonly InlinePred[]): InlineGate | undefined =>
  preds.reduceRight<InlineGate | undefined>((rest, ip) => {
    /**
     * ITEM 1600: each conjunct's per-element work chosen ONCE PER QUERY, which is item 1598's
     * lever one consumer along. `inlineHolds` -> `satisfies` re-dispatches over twelve carriers
     * per element; `specializeSingleProp` resolves the single-carrier case to one closure.
     *
     * ⚠️ THE SIZE OF THIS IS AN ABLATION, not a profile share (item 1104). Replacing the gate call
     * in `detectNodeProjection`'s streaming walk with `() => true` — a wrong answer measured only
     * to price the right one — on `MATCH (u:User) WHERE u.team = $v RETURN u.score`, 400 rows of
     * 20,000 seeded, one shape per process:
     *
     * ```text
     *    baseline                    24204  24572  24643 ns
     *    the GATE ablated            11721  11987  11996       2.05x
     *    the LABEL test ablated      18996  19176  19930       1.27x
     *    both ablated                 7373   7680   7994       3.16x
     *    a hand-written FLOOR         8353   8502              both-ablated IS the floor
     * ```
     *
     * So the gate is ~31 ns a candidate and 2.05x of that query, and with it and the label test
     * gone the rung sits exactly on a floor that walks the bucket, tests the label and builds one
     * row. That is what nominated this rather than a frame name.
     *
     * ⚠️ AND IT GOES HERE, NOT IN THE LOOPS. The gate has thirteen call sites and
     * `executor-edits-perturb` prices a new walk variant at up to 16% on UNRELATED rows, so a fast
     * arm added per site would cost more than it buys. Composed here the signature is unchanged,
     * every site benefits, and no loop body moves.
     *
     * The `{ binding, params, graph }` is allocated per element, which looks like the wrong trade
     * and is not: item 1512, in this same file, removed 800,000 such allocations per call from the
     * projection loop and measured **1.01x** — "it allocates per row" is not by itself a cost in
     * this engine, because V8's young-generation bump allocation is near-free. The dispatch it
     * replaces is not.
     *
     * `bindVar === undefined` is REQUIRED, not an optimization: `inlineHolds` WRITES the binding
     * for a correlated conjunct before testing it, and the specialized closure never writes one.
     * `specializeSingleProp` would otherwise evaluate a value against a name nothing had bound.
     */
    const fast = specializedConjunct(ip);

    return fast === undefined
      ? (v, binding, params, graph) =>
          inlineHolds(ip, v, binding, params, graph) &&
          (rest === undefined || rest(v, binding, params, graph))
      : (v, binding, params, graph) =>
          fast(v, { binding, params, graph }) &&
          (rest === undefined || rest(v, binding, params, graph));
  }, undefined);
/**
 * One gate conjunct's per-element closure when it can be pre-resolved, else `undefined` so the
 * caller keeps `inlineHolds`.
 *
 * ⚠️ A SEPARATE EXPORTED FUNCTION BECAUSE IT IS A ROUTE CHOICE, and a route choice is
 * answer-equivalent — so every mutant of it survives the differential tests and it needs a test of
 * its own (`perf-gate-needs-its-own-test`, and item 1064's `topKPlan` is the same shape).
 * `gate-conjunct-route.test.ts` is that test.
 *
 * `bindVar === undefined` is REQUIRED, not an optimization: `inlineHolds` WRITES the binding for a
 * correlated conjunct before testing it, and a specialized closure never writes one — it would
 * otherwise evaluate a value against a name nothing had bound.
 */
export const specializedConjunct = (
  ip: InlinePred,
): ((element: Vertex | Edge, env: EvalEnv) => boolean) | undefined =>
  ip.bindVar === undefined ? specializeNarrowPred(ip.pred) : undefined;
