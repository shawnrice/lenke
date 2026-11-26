/**
 * `MATCH (a[:L]) WHERE [NOT] EXISTS { (a)-[:T]->() } RETURN count(*)` from the edge index (item 2163).
 *
 * THE ARITHMETIC: that count is `|{vertices with ≥1 such edge}|`, and `edgesFromByLabel` is an index
 * of exactly that — a vertex id to its out-edges by type, holding ONLY vertices having an edge on that
 * side. `NOT EXISTS` is `vertexCount` minus it. The general path instead visits every candidate and
 * evaluates the subquery per row, which a profile priced at `get adjFrom` **~30% self** over 200,000 box
 * reads.
 *
 * Flagged by the native-reference screen with both engines' ANSWERS verified equal (item 2161), and
 * measured over 200,000 vertices:
 *
 * ```text
 *     EXISTS            19-27 ms -> 0.90     (native 0.87 — parity)
 *     NOT EXISTS        22-33    -> 1.27
 *     EXISTS incoming      33    -> 2.22
 * ```
 *
 * Its own file because `shortcuts.ts` is at its 3000-line cap, as `shortest-endpoint-count.ts` is for
 * item 2151's rung.
 */
import type { Graph } from '@lenke/core';

import type { Expr, NodePattern } from '../ast.js';
import { compilePredicate } from './core.js';
import type { Params } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import { plainNode, plainRel } from './hop-sides.js';
import { predFor } from './inline-gate.js';
import type { InlinePred } from './inline-gate.js';

/** The empty labelled set, shared so the arm below need not allocate one per execution. */
const EMPTY_VERTICES: ReadonlySet<{ readonly id: string }> = new Set();

type CountOf<T> = (graph: Graph, params: Params) => T;

/** A one-hop `EXISTS` on the start variable, peeled of a `NOT`, or `undefined`. */
const existsHopOf = (
  where: Expr | undefined,
  startVar: string | undefined,
): { type: string; out: boolean; negated: boolean } | undefined => {
  const negated = where?.kind === 'not';
  const inner = negated ? where.expr : where;

  if (inner?.kind !== 'exists' || inner.where !== undefined || inner.patterns.length !== 1) {
    return undefined;
  }

  const [pattern] = inner.patterns;
  const { start, segments, pathVar, selector, mode } = pattern;

  /*
   * **THE PARSER FILLS THESE IN, SO `!== undefined` REJECTS EVERYTHING.** A plain
   * `EXISTS { MATCH (a)-[:T]->(b) }` parses with `selector: 'walk'` and `mode: 'trail'` — the ISO
   * defaults — not with them absent. My first draft tested for `undefined` and the form was never
   * reached by ANY query; a `throw` at the site is what showed it (the third time this session).
   *
   * Accepting those two is sound rather than convenient: `walk` is the default selector, and
   * `hop-projection.ts` records that a path MODE is applied PER REPETITION, so on a single
   * non-quantified hop the restrictors are no-ops — measured there against the general path.
   */
  if (
    pathVar !== undefined ||
    segments.length !== 1 ||
    (selector !== undefined && selector !== 'walk') ||
    (mode !== undefined && mode !== 'trail')
  ) {
    return undefined;
  }

  const [seg] = segments;
  const { rel, node } = seg;

  /*
   * EVERY CONDITION REMOVES A CASE WHOSE ANSWER WOULD DIFFER, not merely an awkward one: the
   * subquery's start must BE the outer candidate (else it is not correlated); a quantifier, a rel
   * variable, inline properties or a `WHERE` on either element need per-element evaluation the index
   * cannot do; `both` would double-count a vertex with edges on each side; and a FAR label or predicate
   * makes "qualifying" depend on the far END, which the index does not record.
   *
   * `plainNode` / `plainRel` CARRY SEVEN OF THESE, and this gate hand-wrote all seven until item
   * 2392 — in a file that did not import `hop-sides.js` at all, while five other detectors did.
   *
   * **AND THE SWAP IS NOT NEUTRAL: IT ADMITS `(n {})`, WHICH IS AN EQUIVALENT-SPELLING GAP THIS
   * GATE WAS LOSING.** `plainNode` tests `(properties?.length ?? 0) === 0`, the hand-written operand
   * tested `properties !== undefined`, and `parsePropertyMap` returns an EMPTY ARRAY for `{}` (its
   * `if (!check('rbrace'))` skips the entry loop) — so `MATCH (a) WHERE EXISTS { (a)-[:T]->(b {}) }`
   * parses with `properties: []` and was declining a route that `(b)` takes. An empty constraint list
   * constrains nothing, so admitting it is the CORRECT answer and not merely a wider one.
   *
   * MEASURED, A/B with a NULL CONTROL, 200,000 vertices / 600,000 edges, median of 6
   * post-warmup reps (`exists-brace-2392.mjs`):
   *
   * ```text
   *                            bare       braced x3                  spread
   *     route DISABLED        63.72 ms    64.22 / 64.53 / 64.05      1.01x   <- the control
   *     old gate              17.86       64.55 / 64.36 / 64.29      3.61x
   *     this gate             19.26       17.09 / 19.51 / 17.22      1.14x
   * ```
   *
   * THE CONTROL IS WHAT MAKES THIS A ROUTE CLAIM RATHER THAN A RATIO. Forcing the whole arm to
   * decline puts the BARE spelling at 63.72, and the old gate's braced arms sit ON that number
   * (64.3-64.6) — so they were not taking a slower variant of the route, they were not taking it
   * at all. Guarded by the spelling probe's `EMPTY inline map` group, because no answer test can
   * see this: every spelling already answered correctly, just 3.61x slower.
   */
  if (
    startVar === undefined ||
    start.variable !== startVar ||
    start.label !== undefined ||
    !plainNode(start) ||
    rel.label?.kind !== 'label' ||
    rel.variable !== undefined ||
    !plainRel(rel) ||
    (rel.direction !== 'out' && rel.direction !== 'in') ||
    node.label !== undefined ||
    !plainNode(node) ||
    node.variable === undefined
  ) {
    return undefined;
  }

  return { type: rel.label.name, out: rel.direction === 'out', negated };
};

/**
 * `MATCH (a[:L]) WHERE [NOT] EXISTS { (a)-[:T]->() } RETURN count(*)` — from the edge index (item 2163).
 *
 * **`index.size` WOULD BE A WRONG ANSWER, and item 2162 is the proof.** That index keeps a vertex's
 * OUTER entry after its last edge is removed — only the inner per-type bucket is deleted — so `.size`
 * counts vertices with no edges at all. This walks the entries and tests `has(type)`, which IS accurate
 * after a removal; item 2162 shipped the same correction to `optional-hop.ts` for the same reason.
 *
 * The anchor label must be VACUOUS, checked per CALL. The index is keyed by vertex id with no label
 * information, so a selective label would count non-anchors — and a write can add a vertex without the
 * label to a graph this closure was compiled against.
 */
const existsHopNodeCount = <T>(
  start: NodePattern,
  where: Expr | undefined,
  rowOf: (n: number) => T,
  inStart: InlinePred | null | undefined,
  walk: CountOf<T> | null,
): CountOf<T> | undefined => {
  const hop = existsHopOf(where, start.variable);

  if (hop === undefined || inStart !== undefined || walk === null) {
    return undefined;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return undefined;
  }

  /*
   * `_params` IS UNUSED NOW AND THAT IS THE POINT: the pre-2191 arm's only use of it was
   * `walk(graph, params)`, the non-vacuous fallback this item replaced. `walk` is still read by the GATE
   * above (`walk === null` declines), so the parameter stays in the signature — but nothing in the body
   * delegates any more, because both the vacuous and the non-vacuous cases are answered here.
   */
  return (graph, _params) => {
    /*
     * **THE FALLBACK IS INSIDE THE CLOSURE, AND IT HAS TO BE.** Vacuity is a RUN-time property — a
     * write can add a vertex without the label to a graph this closure was compiled against, and the plan
     * cache reuses the closure for the same query text. `CountOf` must ANSWER, it cannot decline, so
     * the non-vacuous case delegates to the per-candidate walk rather than returning a wrong number.
     * (My first draft returned `NaN` here, which would have answered rather than declined.)
     */
    const index = hop.out ? graph.edgesFromByLabel : graph.edgesToByLabel;
    /*
     * **`?? EMPTY` IS LOAD-BEARING AND ITS ABSENCE WAS A WRONG ANSWER I WROTE.** A label NOTHING
     * carries has NO bucket, so `get` returns `undefined` — and treating that as "no label" takes the arm
     * below, which ignores the label and answered `vertexCount - withEdge` (3 on a fixture where the
     * right answer is 0). An absent bucket means an EMPTY labelled set, which is a different thing
     * from an absent label. Caught by this item's own `a label NOTHING carries` test.
     */
    const labelled =
      label === undefined ? undefined : (graph.verticesByLabel.get(label.name) ?? EMPTY_VERTICES);

    /*
     * **THE NON-VACUOUS ARM, ADDED AT ITEM 2191 — IT USED TO DELEGATE TO THE FULL WALK.** The
     * original fallback here was `return walk(graph, params)`, which is correct and was the top
     * nomination on the realistic screen once item 2190 made `MIXED` the default:
     *
     * ```text
     *     EXISTS subquery      marginal +12.17 ms against native's +0.79    15.4x
     *     NOT EXISTS subquery  marginal +12.75                              16.1x
     * ```
     *
     * They read 1.54 and 1.59 ms on a HOMOGENEOUS fixture, where the label is vacuous and the index
     * arm below answers — so this fallback was invisible until the screen got a realistic schema. A
     * differential profile named it exactly: `get adjFrom` **+239 ms**, `existsReachable` **+84**,
     * `oneHopExists` **+36**, all **0.0** in the vacuous arm.
     *
     * **THE SHAPE IS AN INTERSECTION, NOT A WALK**: `EXISTS { (a)-[:T]->(b) }` asks only whether `a`
     * has a T-bucket, so counting the labelled vertices that have one needs no predicate evaluation and
     * no traverser. It drives from the SMALLER side — the labelled set is usually far smaller than the
     * whole adjacency index, but a near-vacuous label makes the reverse true.
     *
     * **`byType.has(type)` AND NOT `index.has(id)`** — item 2162 shipped a WRONG ANSWER on exactly
     * that confusion: an outer entry SURVIVES the removal of its last edge, so the entry's existence does
     * not mean the vertex still has an edge of that type.
     */
    if (labelled !== undefined) {
      let hit = 0;

      if (labelled.size <= index.size) {
        for (const v of labelled) {
          if (index.get(v.id)?.has(hop.type) === true) {
            hit += 1;
          }
        }
      } else {
        for (const [id, byType] of index) {
          if (byType.has(hop.type) && graph.getVertexById(id)?.labels.has(label!.name) === true) {
            hit += 1;
          }
        }
      }

      return rowOf(hop.negated ? labelled.size - hit : hit);
    }

    let withEdge = 0;

    for (const byType of index.values()) {
      if (byType.has(hop.type)) {
        withEdge += 1;
      }
    }

    return rowOf(hop.negated ? graph.vertexCount - withEdge : withEdge);
  };
};

/**
 * The bare-node `count(*)` arm of `patternCountOf`: the `EXISTS` index form where it applies, else the
 * per-candidate walk.
 *
 * **THE WHOLE ARM LIVES HERE, NOT JUST THE `EXISTS` FORM, AND THAT WAS FORCED.** `shortcuts.ts` sits
 * exactly AT its 3000 code-line cap, so adding even an import breaks the gate — item 2135 records five
 * iterations spent on that same wall. Moving the arm takes 18 code lines out of that file and leaves
 * the call site a single statement.
 *
 * `walkOf` is passed in rather than imported: `buildNodeCount` is 259 lines with ten dependencies of
 * its own, so moving IT would risk a cycle, and only the caller knows how to build that walk.
 */
export const bareNodeCount = <T>(spec: {
  readonly start: NodePattern;
  readonly where: Expr | undefined;
  readonly rowOf: (n: number) => T;
  readonly cstart: unknown;
  readonly inStart: InlinePred | null | undefined;
  readonly walkOf: (
    start: NodePattern,
    rowOf: (n: number) => T,
    preds: readonly InlinePred[],
    cstart?: never,
  ) => CountOf<T> | null;
}): CountOf<T> | null => {
  const { start, where, rowOf, cstart, inStart, walkOf } = spec;
  // A clause `WHERE` over the single node is the SAME question as the inline
  // spelling, and tallying one while declining the other would create exactly the
  // equivalent-spelling gap the probe exists to catch. It is carried as a second
  // closed predicate rather than by splicing an `AND` into the AST.
  const preds: InlinePred[] = [];

  if (inStart !== undefined && inStart !== null) {
    preds.push(inStart);
  }

  if (where !== undefined) {
    if (start.variable === undefined) {
      return null;
    }

    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== start.variable) {
        return null;
      }
    }

    // `start.variable` is passed as the predicate's OWN variable, which lets `directEqProps`
    // read the element directly instead of through the binding. Sound because the loop above has
    // just proved exactly the precondition that argument documents: every free variable of
    // `where` IS `start.variable`, so the predicate is element-local. Without it the clause
    // spelling paid 29.0 ns a vertex against the inline spelling's 17.2 for the same answer, and
    // 47.4 against 21.1 for an AND of two equalities (audit item 230).
    preds.push(predFor(compilePredicate(undefined, where, start.variable), start.variable, true));
  }

  const walk = walkOf(start, rowOf, preds, cstart as never);

  return existsHopNodeCount(start, where, rowOf, inStart, walk) ?? walk;
};
