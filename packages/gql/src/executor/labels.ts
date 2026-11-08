/**
 * LABEL VACUITY AND EMPTINESS: when a label constrains nothing, and when it constrains everything.
 *
 * ⚠️ THE TWO ARE OPPOSITE EDGE CASES OF ONE QUESTION, and both are elisions a planner must get
 * right in BOTH directions. `vacuousLabel` is a label every vertex carries, so testing it is pure
 * cost and the test is dropped (`effectiveLabel` is the dropper). `emptyLabel` is a label NO vertex
 * carries, so the pattern it sits on matches nothing and the whole rung can short-circuit (item
 * 1552). Getting vacuity wrong costs time; getting emptiness wrong returns rows that do not exist.
 *
 * They live here, below everything, because `matching.ts` needed `effectiveLabel` from
 * `shortcuts.ts` while `shortcuts.ts` needed four symbols back from `matching.ts` — one of the four
 * mutual import pairs that made this package cyclic (item 1666). One symbol closed that cycle.
 *
 * ⚠️ `vacuousLabel` READS `graph.verticesByLabel` AND `graph.vertexCount`, which is why it is
 * graph-dependent rather than a property of the expression. A label is vacuous relative to the data
 * in the graph right now — and `verticesByLabel` is NOT maintained by the `v.labels =` setter, so an
 * elision taken from it can be a WRONG ANSWER on a graph mutated that way. That is a known open
 * decision, not something this move changes.
 */

import type { Graph } from '@lenke/core';

import type { LabelExpr } from '../ast.js';

/**
 * Is `expr` satisfied by EVERY vertex in `graph`, so that testing it per element is pure
 * cost? Only the plain single-label form is answered; `and`/`or`/`not`/`%` fall through.
 *
 * WHY THIS EXISTS. The per-element label test is the whole cost of a labelled 1-hop count,
 * and it is a cache-locality cost, not an interpretation one — each `edge.from.labels.has(L)`
 * chases a pointer to a random `Vertex` and its `Set` across a large heap. Over the 1,000,000
 * edges of the cross-engine bench: the walk WITHOUT the label test is 1.1ms, and WITH it
 * 89.3ms (the generator the walk used to run through accounts for only ~7ms of that).
 *
 * AND IT IS THE REPO'S OWN INVARIANT, not a special case. When every vertex is a `Person`,
 * `MATCH (a:Person)-[:KNOWS]->(x)` and `MATCH (a)-[:KNOWS]->(x)` are EQUIVALENT SPELLINGS of
 * one question — and they cost 586ms against ~0ms, because only the unlabelled spelling
 * reached the O(1) bucket-size path. The native engine already elides this, which is why it
 * answers the same query in ~0.5ms.
 *
 * SOUNDNESS is the `===`: a bucket holding exactly as many vertices as the graph has must
 * hold all of them, so `labels.has(name)` is universally true and dropping it cannot change a
 * row. A stale over-count makes the comparison FAIL and simply leaves the optimization off,
 * which is the safe direction. An empty graph compares `0 === 0` and is trivially vacuous —
 * it has no edges to count either.
 */
/**
 * Is `expr` carried by EVERY vertex, so testing it per element is pure cost?
 *
 * Exported since item 167: the fused hop projection needs the same question to decide whether
 * it may drive the FAR side (a start label it cannot apply by iteration is only ignorable when
 * no vertex fails it).
 */
export const vacuousLabel = (graph: Graph, expr: LabelExpr | undefined): boolean => {
  if (expr === undefined) {
    return false;
  }

  switch (expr.kind) {
    case 'label':
      return (graph.verticesByLabel.get(expr.name)?.size ?? 0) === graph.vertexCount;

    // ⚠️ THE COMPOUND KINDS, which this used to ignore (item 1549). `LabelExpr` has five, and only
    // `label` was tested — so every compound spelling of a vacuous label stayed in the plan and
    // left the O(1) route. The same defect as item 1547's on the Gremlin side, where
    // `dropVacuousLabels` required `labels.length === 1`. Measured at 200,000 vertices, every arm
    // answering the identical 200,000:
    //
    //     MATCH (a)-[:E]->(x)        0.003 ms      MATCH (a:P)-[:E]->(x)      0.001 ms
    //     MATCH (a:P|Q)-[:E]->(x)    7.406         MATCH (a:Q|P)-[:E]->(x)    7.152
    //     MATCH (a:!Nope)-[:E]->(x)  6.949         MATCH (a:P&P)-[:E]->(x)    9.495
    //
    // `or` needs only ONE side universal, since a disjunction matches whatever either side does;
    // `and` needs both.
    case 'or':
      return vacuousLabel(graph, expr.left) || vacuousLabel(graph, expr.right);

    case 'and':
      return vacuousLabel(graph, expr.left) && vacuousLabel(graph, expr.right);

    // `:!X` matches everything exactly when `X` matches nothing, and an empty bucket is the cheap
    // way to know that. Deliberately only for a plain inner label: a nested compound would need a
    // matches-NOTHING recursion, which is a second function for a shape nobody writes.
    case 'not':
      return (
        expr.expr.kind === 'label' && (graph.verticesByLabel.get(expr.expr.name)?.size ?? 0) === 0
      );

    // ⚠️ THE WILDCARD IS **NOT** VACUOUS, AND THAT IS MEASURED, NOT ASSUMED. `:%` reads as "any
    // node" and the obvious implementation here is `return true` — which is a WRONG ANSWER. On a
    // graph with one `:P` vertex and one UNLABELLED vertex:
    //
    //     MATCH (a)     count 2        MATCH (a:%)   count 1
    //
    // So `%` means "carries at least one label", and eliding it would invent the unlabelled rows.
    // It is vacuous only when every vertex has a label, and nothing here knows that in O(1): the
    // label buckets can sum past `vertexCount` because a vertex may carry several. Left un-elided.
    case 'wildcard':
      return false;

    default:
      return false;
  }
};
/**
 * A label that constrains nothing — ABSENT, or carried by every vertex in the graph — collapsed to
 * `undefined`, so the paths below can take their no-label route.
 *
 * Decided per EXECUTION and not at compile time, because vacuity is a property of the GRAPH. This
 * is the third place the same reasoning pays: item 215 made the far-endpoint resolve conditional
 * on it, item 217 removed a far-label test that a false `needsFar` had already made constant, and
 * here it turns the two-hop degree product's per-edge scan back into a `size` read.
 */
export const effectiveLabel = (
  graph: Graph,
  label: LabelExpr | undefined,
): LabelExpr | undefined => (label !== undefined && vacuousLabel(graph, label) ? undefined : label);
/**
 * The COMPANION of vacuity: a label carried by NO vertex, so the pattern it sits on matches
 * nothing (item 1552).
 *
 * Same bucket read as {@link vacuousLabel} and the same per-EXECUTION reasoning — emptiness is a
 * property of the graph, so it cannot be decided when the plan is compiled and cached (item 1551).
 * One is `size === vertexCount`, the other `size === 0`; between them they turn a label into "drop
 * the test" or "drop the query".
 *
 * ⚠️ WHY THE ENDS NEEDED THIS AND THE MIDDLE DID NOT. `buildTwoHopCount` drives from the MIDDLE —
 * a two-hop count is a degree inner product over `b` — so an empty middle bucket yields an empty
 * driver and 0 falls out for free. The end labels are applied as per-edge FILTERS, so an empty one
 * costs the whole sweep to discover nothing. Measured at 200,000 vertices:
 *
 * ```text
 *   MATCH (a)-[:E]->(b:Nope)-[:E]->(c)     0.001 ms    <- the driver is empty, already free
 *   MATCH (a:Nope)-[:E]->(b)-[:E]->(c)   146.126       <- a filter that rejects everything
 *   MATCH (a)-[:E]->(b)-[:E]->(c:Nope)   118.157
 *   MATCH (a:Q)-[:E]->(b)-[:E]->(c)      148.264       <- a GENUINELY selective label, for scale
 * ```
 *
 * `:Nope` cost the same as a selective label, which is the tell: it took the same route and simply
 * filtered everything out at the end of it.
 *
 * Only a plain `label` for now. The compound kinds are decidable too — `or` is empty iff both
 * sides are, `and` iff either is — but they are unmeasured here, and item 1549's wildcard is the
 * standing reminder that a label operator's obvious reading can be the wrong one.
 */
export const emptyLabel = (graph: Graph, expr: LabelExpr | undefined): boolean =>
  expr?.kind === 'label' && (graph.verticesByLabel.get(expr.name)?.size ?? 0) === 0;
/**
 * Does any of these labels match nothing? Taken as a LIST rather than a chain of `||` because the
 * three-hop closure sits on the complexity cap of 35 and four disjuncts put it at 37 — the same
 * budget item 1298's lift had to respect.
 */
export const anyEmptyLabel = (graph: Graph, labels: readonly (LabelExpr | undefined)[]): boolean =>
  labels.some((l) => emptyLabel(graph, l));
