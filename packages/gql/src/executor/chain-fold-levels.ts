import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr, NodePattern, PathPattern, RelPattern } from '../ast.js';
import type { CClause, Params, Row } from './core.js';
import { csrFor } from './csr-cache.js';
import { freePredicateVars } from './expr-analysis.js';
import type { AlwaysRowsFn } from './hop-projection.js';
import { plainNode, plainRel } from './hop-sides.js';
import { vacuousLabel } from './labels.js';
import { columnName, resolveCount, valueKey } from './rows.js';
import { groupedClauses, groupedProjection, groupedSortApplier } from './shortcuts.js';
import { propOf } from './values.js';

/**
 * `MATCH <chain of 2+ segments> RETURN min|max|count(<far>.k)` — answered by a LEVEL RECURRENCE
 * instead of a path walk (item 2010).
 *
 * ⚠️⚠️ **THE EXISTING RUNG IS NOT MISSING, IT IS O(paths).** `detectChainFoldedAggregate` (item 1824)
 * already admits exactly these order-invariant folds for a chain — but its own note says it "reuses
 * `detectChainProjection`'s ENTIRE GATE by handing it a synthetic projection", so it rides that
 * module's path walk. It avoids materializing rows; it still visits every path. At fanout 5 a 4-hop
 * chain over 5,000 vertices is 3,125,000 paths for ONE row.
 *
 * 🔑 **THESE FOLDS DO NOT NEED THE PATHS.** `u_k(v)` — the number of length-k walks ending at `v` —
 * is computable in O(k·(|V| + |E|)), and:
 *
 *   - `min` / `max` are SET functions: they read only WHICH entries are non-zero, so multiplicity is
 *     irrelevant and one pass over the final level answers them;
 *   - `count(x)` is NOT a set function (one per PATH with a non-null `x`) but needs exactly the
 *     multiplicity the recurrence already carries: `sum over v with non-null x of u_k(v)`;
 *   - `count(DISTINCT x)` is a set function again, over the projected VALUES.
 *
 * MEASURED CEILING before building (`foldceiling-2009.mjs`, CSR and recurrence rebuilt every rep so
 * nothing is warm, answers verified against the engine):
 *
 * ```text
 *     depth    fold          engine ms   ceiling ms     ratio   agree
 *     3 hops   min(d.n)          53.04         0.23     233.6x    YES
 *     3 hops   count(d.n)        45.87         0.15     315.2x    YES
 *     4 hops   min(e.n)         288.72         0.27    1069.4x    YES
 *     4 hops   count(e.n)       251.76         0.17    1515.0x    YES
 * ```
 *
 * ⚠️⚠️ **`sum`, `avg` AND `collect` ARE EXCLUDED BY CONTRACT, NOT BY DIFFICULTY — and a
 * multiplicity-weighted sum is the specific trap.** Writing `sum` here as
 * `Σ u_k(v) · value(v)` is arithmetically appealing and is a DIFFERENT COMPUTATION from adding the
 * per-path values one at a time: f64 addition is not associative, so the two disagree in the last
 * ulp. Byte-identity with the Rust engine is a hard invariant, and
 * `ORDER_INVARIANT_AGGREGATES`/`foldFor` both refuse these for exactly this reason. The temptation
 * is real enough that item 1829's note predicted someone would arrive here motivated to widen it.
 *
 * ⚠️ **A CHAIN PATTERN COUNTS WALKS, WHICH IS WHY THE RECURRENCE IS EXACT — and that was MEASURED,
 * not assumed.** A quantified path carries a mode (trail/acyclic), and items 2007/2008 spent two
 * items on the fact that a walk recurrence answers the wrong question there. A multi-segment PATTERN
 * has no such restriction: the engine's `count(d.n)` over a 3-hop chain reads **625000 = 5000 × 5³
 * exactly**, matching the walk recurrence, so no edge- or vertex-distinctness rule is in play.
 *
 * ⚠️ IT DECLINES RATHER THAN GUESSES, and the direction matters: everything it refuses falls to the
 * existing rung, so a gap in this reader is a MISSED SPEEDUP. Only admitting something it handles
 * wrongly could change an answer, which is why the admission below is strictly narrower than
 * `detectChainProjection`'s: no relationship variable, no inline properties, no clause `WHERE`, no
 * union types, and the fold's argument must read only the FAR node.
 */
/** The evaluation environment the fold's argument reads — one binding, reused per vertex. */
type FoldEnv = { binding: Map<string, unknown>; params: Params; graph: Graph };

type Level = {
  readonly type: string;
  readonly forward: boolean;
  readonly label: string | undefined;
};

/** One named edge type in one direction with nothing else on it — `chain-projection`'s own rule. */
const levelOf = (rel: RelPattern, node: NodePattern): Level | null => {
  if (!plainRel(rel) || rel.variable !== undefined || !plainNode(node)) {
    return null;
  }

  const { label } = node;

  // A label EXPRESSION (a disjunction, a negation) is refused: this walks one name per level.
  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const dir = rel.direction;

  if (dir !== 'out' && dir !== 'in') {
    return null;
  }

  const types = rel.label;

  if (types?.kind !== 'label') {
    return null;
  }

  return { type: types.name, forward: dir === 'out', label: label?.name };
};

/**
 * The multiplicity vector after walking every level.
 *
 * ⚠️ THE LABEL MASK IS APPLIED PER LEVEL, which is what lets this admit a labelled chain rather than
 * depending on the label being vacuous. `(a:T)-[:E]->(b:Q)-[:E]->(c:T)` zeroes every non-`Q` entry
 * after the first step, so a filtering intermediate label narrows the walk exactly as the general
 * path would. ⚠️ A rung that ignored those labels would OVER-count, which is the one way this module
 * could produce a wrong answer rather than merely decline.
 */
const levelWalk = (
  graph: Graph,
  levels: readonly Level[],
  startLabel: string | undefined,
): {
  u: Float64Array;
  order: readonly Vertex[];
} => {
  // Every level shares one vertex ordering: `csrFor` builds `order` from `graph.verticesById` for
  // EVERY direction and type set, so slot `i` is the same vertex in all of them.
  const first = csrFor(graph, !levels[0].forward, [levels[0].type]);
  let u = new Float64Array(first.order.length);
  let next = new Float64Array(first.order.length);

  for (let i = 0; i < first.order.length; i += 1) {
    u[i] = startLabel === undefined || first.order[i].labels.has(startLabel) ? 1 : 0;
  }

  for (const level of levels) {
    const { off, nbr, order } = csrFor(graph, !level.forward, [level.type]);

    next.fill(0);

    for (let v = 0; v < order.length; v += 1) {
      const m = u[v];

      if (m === 0) {
        continue;
      }

      const end = off[v + 1];

      for (let k = off[v]; k < end; k += 1) {
        next[nbr[k]] += m;
      }
    }

    if (level.label !== undefined) {
      const want = level.label;

      for (let v = 0; v < order.length; v += 1) {
        if (next[v] !== 0 && !order[v].labels.has(want)) {
          next[v] = 0;
        }
      }
    }

    const swap = u;

    u = next;
    next = swap;
  }

  return { u, order: first.order };
};

/**
 * The pattern-side admission, shared by both detectors in this module (item 2012).
 *
 * ⚠️ ONE READER, because `chain-projection.ts` warns twice that two copies of one shape rule is how
 * the far endpoint ended up on a per-edge tally. It is deliberately NARROWER than
 * `detectChainProjection`'s: no relationship variable, no inline properties, no union types,
 * single-name labels — so everything it refuses falls to the existing rungs unchanged.
 */
type ChainShape = {
  readonly levels: readonly Level[];
  readonly startLabel: string | undefined;
  readonly pattern: PathPattern;
};

const chainShapeOf = (m: Clause): ChainShape | null => {
  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    // ⚠️ NO CARRIED `WHERE`: the existing rungs carry one, this reader does not, so a filtered chain
    // declines to them rather than being walked without its filter.
    m.where !== undefined
  ) {
    return null;
  }

  const [pattern] = m.patterns;

  /*
   * ⚠️⚠️ **THE PATH MODE IS DELIBERATELY NOT CHECKED, and checking it declined EVERY query** when
   * this module was written (item 2010): the parser stamps `mode: 'trail'` and `selector: 'walk'` as
   * DEFAULTS, so `mode !== undefined` is false for nothing at all. And `mode === 'trail'` would be
   * wrong too — mode is IRRELEVANT without a quantifier, on two independent pieces of evidence.
   * `CLOSED.md`: "the restrictors apply per REPETITION of a quantifier … and a quantifier is declined
   * by `plainRel`", which `levelOf` enforces; and the engine's own `count(d.n)` over a default
   * (`mode: trail`) 3-hop chain reads **625000 = 5000 × 5³ exactly**, the WALK count.
   */
  if (
    pattern.segments.length < 2 ||
    pattern.pathVar !== undefined ||
    (pattern.selector ?? 'walk') !== 'walk' ||
    !plainNode(pattern.start)
  ) {
    return null;
  }

  const startLabelExpr = pattern.start.label;

  if (startLabelExpr !== undefined && startLabelExpr.kind !== 'label') {
    return null;
  }

  const levels: Level[] = [];

  for (const seg of pattern.segments) {
    const level = levelOf(seg.rel, seg.node);

    if (level === null) {
      return null;
    }

    levels.push(level);
  }

  return { levels, startLabel: startLabelExpr?.name, pattern };
};

/**
 * Is this label name absent, or carried by EVERY vertex?
 *
 * ⚠️ `vacuousLabel` TAKES A `LabelExpr`, and the chain shape carries plain NAMES — so the expr is
 * synthesized rather than the test re-implemented. Item 1549 found a hand-rolled copy of this test
 * handling only one of `LabelExpr`'s five kinds.
 */
const vacuousOrAbsent = (graph: Graph, name: string | undefined): boolean =>
  name === undefined || vacuousLabel(graph, { kind: 'label', name });

/**
 * Is EVERY label on this chain vacuous or absent? — the rung's execution-time decline, as a pure
 * function (item 2087).
 *
 * ⚠️⚠️ **EXPORTED AND UNIT-TESTED BECAUSE A ROUTE CHOICE IS ANSWER-EQUIVALENT.** Both routes return
 * the same count, so a mutation round found FIVE survivors here — a decline that never fires, one
 * that always fires, one ignoring the levels, one ignoring the start, and a `vacuousOrAbsent` stuck
 * at `true`. Every one is a pure PERF change and no differential test can see it. The repo's rule for
 * exactly this ("extract the arithmetic as a pure fn and unit-test it") is the only thing that gives
 * it teeth.
 *
 * 🔑 THE SEMANTICS: `true` means `countShortcut` should keep the query — all labels elide, so its
 * unfiltered CSR arm answers at 12.57 ms/rep against this rung's ~20. `false` means a label really
 * filters, where that rung falls to a per-edge tally at 94.01 and this one answers at 19.21.
 */
export const chainLabelsAllVacuous = (
  graph: Graph,
  startLabel: string | undefined,
  levels: readonly { readonly label: string | undefined }[],
): boolean =>
  vacuousOrAbsent(graph, startLabel) && levels.every((l) => vacuousOrAbsent(graph, l.label));

/**
 * `MATCH <chain of 2+ segments> RETURN count(*)` — the PATH count, straight off the level recurrence
 * (item 2087).
 *
 * ⚠️⚠️ **WHY THIS EXISTS: THE SIMPLER SPELLING WAS 4.58x SLOWER THAN THE HARDER ONE.**
 * `detectChainFoldLevels` next door answers `count(<far>.k)` over this same recurrence and applies the
 * label mask per level, so it admits a LABELLED chain. `count(*)` was rejected one line into its gate
 * (`agg.expr.star`) and fell to the per-edge tally the moment a label stopped being vacuous. Measured
 * at 200,000 vertices, the same chain, same answer (200,000):
 *
 * ```text
 *                      vacuous label   REAL label
 *     count(*)             12.57          94.01      <- 7.48x mode penalty
 *     count(c.k)           20.02          20.51      <- flat; it had this rung
 * ```
 *
 * So with a real label the query doing strictly LESS work (no null test per reached vertex) cost 4.58x
 * the one doing more. CLAUDE.md's "equivalent spellings must cost the same" in its sharpest form —
 * these two are not equivalent, which makes the inversion worse rather than excusable.
 *
 * 🔑 `count(*)` IS `sum(u)` AND NOTHING ELSE. The recurrence's multiplicity vector after the final
 * level holds, per vertex, the number of label-satisfying paths ending there — so the total is their
 * sum. No `argFn`, no far variable, no null test: that is why this is a separate detector rather than
 * a branch in its neighbour, whose every remaining field exists to serve a projected value.
 *
 * ⚠️ THE START AND EVERY INTERMEDIATE LABEL ARE ALREADY HANDLED by `levelWalk` — the start as the
 * seed mask, each level's target label as a post-step zeroing. A reader checking this rung's
 * correctness should check THAT function, not this one.
 */
export const detectChainStarCount = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
  /*
   * ⚠️ NOT an `AlwaysRowsFn`: the returned closure DECLINES at execution time, because vacuity is a
   * property of the graph. `undefined` rather than `null` is deliberate — it is exactly
   * `varLengthCount`'s convention, which sits one rung above for the same reason ("cannot decide at
   * COMPILE time whether a depth-4 trail's endpoint label is vacuous"), and the caller's fall-through
   * already tests `!== undefined`.
   */
): ((graph: Graph, params: Params) => Row[] | undefined) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  /*
   * ⚠️⚠️ **TWO SEGMENTS MINIMUM, AND ONE SEGMENT WAS TRIED AND REFUTED (item 2088).** `hopall`
   * (`MATCH (a:P)-[:E]->(b:P) RETURN count(*)`) is a 5.35x MIXED-mode cliff whose profile is 55% label
   * test, so a one-level recurrence looked like the same win this rung took for two hops. Measured at
   * 100,000 vertices, MIXED, both arms asserted to the same answer:
   *
   * ```text
   *     FANOUT    recurrence   per-edge tally
   *       1          8.80          4.22        <- tally wins 2.09x
   *       3          9.80          7.58        <- tally wins 1.29x
   *       6         12.23         13.08        <- recurrence wins 1.07x
   * ```
   *
   * 🔑 **THE RECURRENCE'S ADVANTAGE IS ABOUT HOP COUNT, NOT LABELS.** A per-edge tally over k hops
   * walks every PATH, which is superlinear in k; the recurrence is O(k·(|V|+|E|)). At ONE hop the
   * tally is already linear, so there is nothing to beat — and the recurrence additionally pays two
   * `Float64Array` allocations and two full |V| mask passes, which at FANOUT=1 is the SAME number of
   * label tests the tally does per endpoint. It only pulls ahead past FANOUT≈6 and then by 1.07x.
   */
  const shape = chainShapeOf(m);

  if (shape === null) {
    return null;
  }

  const { levels, startLabel } = shape;
  const proj = cret.projection;

  /*
   * ⚠️⚠️ **`count(*)` IS NOT IN `foldedAggs`, AND THE FIRST VERSION OF THIS GATE LOOKED THERE.** A
   * folded aggregate carries an EXPRESSION to fold; a star has no argument, so `foldedAggs` is
   * `undefined` for `count(*)` and the gate declined every query it was written for. 🔑 The flag that
   * means "every aggregate here is `count(*)`" is `countedGroups`, which `core.ts` derives with
   * `everyAggregateIsCountStar` over both the items AND the ORDER BY keys, and which also implies no
   * `HAVING`.
   *
   * ⚠️ The diagnosis was an INSTRUMENTED BUILD printing each gate's inputs, not a reading of the
   * code: timing cannot tell a declined rung from a starved one, and the field name alone looks
   * plausible either way.
   */
  if (!proj.aggregating || !proj.countedGroups || proj.items.length !== 1) {
    return null;
  }

  if (proj.star || proj.distinct || ret.projection.items.length !== 1) {
    return null;
  }

  /*
   * ⚠️ A GROUPED count is a DIFFERENT shape and `chainGroupedLevels` owns it — `sum(u)` is one total,
   * not one per group.
   */
  if ((proj.groupKeys?.length ?? 0) > 0) {
    return null;
  }

  /*
   * ⚠️⚠️ `SKIP`/`LIMIT` ARE REFUSED, AND `LIMIT 0` IS WHY. This rung returns its one row
   * unconditionally, so a `LIMIT 0` — which must yield NO rows — would be a wrong answer, not a slow
   * one. `ORDER BY` over a single row cannot reorder anything, but it travels with them here and
   * costs nothing to refuse alongside.
   */
  if (proj.skip !== undefined || proj.limit !== undefined || (proj.orderBy?.length ?? 0) > 0) {
    return null;
  }

  const outName = proj.items[0].name;

  return (graph: Graph) => {
    /*
     * ⚠️⚠️ **AN EXECUTION-TIME DECLINE, AND IT IS WHAT MAKES THIS SAFE TO PUT ABOVE `countShortcut`.**
     * Vacuity is a property of the GRAPH, not of the query, so it cannot be decided when this rung is
     * compiled. When every label is vacuous, `effectiveLabel` elides them all and `countShortcut`
     * reaches `twoHopUnfilteredCsrCount` — **12.57 ms/rep against this rung's ~20**. Returning `null`
     * hands those queries back to it unchanged; only the non-vacuous case, which it answers with a
     * per-edge tally at **94.01**, lands here.
     *
     * 🔑 This is `var-length-count.ts`'s established pattern ("the closure can test `vacuousLabel`
     * with the graph in hand and fall back"), not a new one — and `vacuousLabel` is CALLED rather
     * than re-derived, because it is the one reader that knows the compound label kinds (item 1549
     * found four of five spellings unhandled in a copy).
     */
    if (chainLabelsAllVacuous(graph, startLabel, levels)) {
      return undefined;
    }

    const { u } = levelWalk(graph, levels, startLabel);
    let total = 0;

    /*
     * ⚠️⚠️ AN INDEXED LOOP, AND THE LINT'S `prefer-for-of` IS DISABLED ON MEASUREMENT, not taste.
     * Summing a 200,000-element `Float64Array`, medians of 14:
     *
     *     indexed   0.122 ms
     *     for...of  1.739      <- 14.3x, the iterator protocol per element
     *     reduce    1.577
     *
     * 1.6 ms is ~8% of this query at that size, so the suggested form would give back a tenth of
     * what this rung wins. A typed array is the one case where `for...of` is not free.
     */
    // eslint-disable-next-line @typescript-eslint/prefer-for-of -- 14.3x; see the note above
    for (let i = 0; i < u.length; i += 1) {
      total += u[i];
    }

    return [{ [outName]: total }];
  };
};

/**
 * The DISTINCT values of a far-end expression, straight off the level recurrence — item 2119.
 *
 * ⚠️⚠️ **IT KEEPS NULL AND `foldLevel` DROPS IT, AND THAT IS NOT A STYLE DIFFERENCE.** `count(DISTINCT x)`
 * counts non-null values; `RETURN DISTINCT x` treats NULL as a present value and emits one row for it.
 * Verified on a graph with reachable far vertices variously missing the key, holding `null`, and holding
 * values:
 *
 * ```text
 *     RETURN DISTINCT c.n   ->  [{"n":null},{"n":2},{"n":1}]    three rows, null INCLUDED
 *     count(DISTINCT c.n)   ->  [{"c":2}]                        nulls EXCLUDED
 * ```
 *
 * 🔑 So this cannot reuse `foldLevel`'s loop with a flag: the `cell === null` skip there is load-bearing
 * for its own semantics, and sharing it would make one of the two silently wrong. That is the same trap
 * `detectChainDistinctCount`'s header records ("`distinctRows(rows).length` would be a silent wrong
 * answer").
 *
 * ⚠️ MULTIPLICITY IS IRRELEVANT, exactly as for `min`/`max`: the distinct SET of a multiset is the
 * distinct set of its support, which is why this is expressible without the paths at all.
 *
 * ⚠️ ROW ORDER IS VERTEX ORDER, which is unspecified for a `DISTINCT` projection with no `ORDER BY`
 * (`order-is-unspecified`) — the general path's order is its own and neither is the answer.
 */
const distinctLevel = (
  pass: Omit<FoldPass, 'name' | 'distinct'> & { readonly outName: string },
): Row[] => {
  const { u, order, argFn, env, binding, farVar, outName } = pass;
  const seen = new Set<string>();
  const rows: Row[] = [];

  for (let v = 0; v < order.length; v += 1) {
    if (u[v] === 0) {
      continue;
    }

    binding.set(farVar, order[v]);

    const cell = argFn(env);
    // ⚠️ `valueKey` IS THE ONE DEFINITION OF DISTINCTNESS in this engine — shared with
    // `UNION`/`EXCEPT`/`INTERSECT` and matched byte-for-byte by the Rust engine. A second keying here
    // would diverge on exactly the hard values (`-0` against `0`, `NaN`, an element keyed by id).
    const key = valueKey(cell);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    /*
     * ⚠️ `?? null` IS DEFENSIVE AND ITS MUTANT SURVIVES — recorded rather than left unexplained. `propOf`
     * already yields NULL for an absent property, so `argFn` cannot return `undefined` for the shapes
     * this gate admits and the coalesce is unreachable. 🔑 It stays because the alternative is a reader
     * having to re-derive that `argFn` can never produce `undefined`: the cost is one `??` on a path that
     * runs once per DISTINCT value, not per path.
     */
    rows.push({ [outName]: cell ?? null });
  }

  return rows;
};

/**
 * `MATCH <chain of 2+ segments> RETURN DISTINCT <far>.<k>` — the distinct SET off the recurrence
 * (item 2119).
 *
 * ⚠️⚠️ **WHY: THE ROW SPELLING COST 27x ITS OWN `count(DISTINCT)` TWIN FOR THE SAME VALUES.** Both must
 * build the same distinct set; the count then reports its size, which is free on top. Measured at
 * 200,000 vertices / 600,000 edges, both answering the same 97 distinct values:
 *
 * ```text
 *     hop2  count(DISTINCT c.n)    18.8 ms    1 row     <- had this recurrence
 *     hop2  RETURN DISTINCT c.n   517.5      97 rows    <- 27x, claimed by `hop2Projection` alone
 *     hop1  RETURN DISTINCT b.n    19.7      97         <- one hop was already fine
 *     hop3  RETURN DISTINCT d.n  1610.8      97
 * ```
 *
 * 🔑 So the row-returning spelling paid 27x to do strictly LESS work than its count twin. Item 2118
 * found it in the CONTROLS of an unrelated question.
 *
 * ⚠️ IT MUST SIT ABOVE `hop2Projection`, which claims this shape today and is the 517 ms. A narrow gate
 * above a broad rung is item 1583's own fix shape; the risk item 418 names (a branch ahead of a hot
 * dispatch costing the shape it does not claim 1.12x) is why the gate below refuses everything it has
 * not measured.
 */
export const detectChainDistinctLevels = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const shape = chainShapeOf(m);

  if (shape === null) {
    return null;
  }

  const { levels, startLabel, pattern } = shape;
  const proj = cret.projection;

  /*
   * ⚠️ ONE COLUMN, `DISTINCT`, NOT AGGREGATING, AND NOTHING AFTER IT. Each clause is a shape this rung
   * has measured: a second column needs a joint key (the multi-column case is separately open), an
   * aggregate belongs to the fold next door, and `ORDER BY`/`SKIP`/`LIMIT` make row order decide WHICH
   * rows survive — which a vertex-order pass may not.
   */
  if (
    !proj.distinct ||
    proj.aggregating ||
    proj.star ||
    proj.items.length !== 1 ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.items[0].isAgg ||
    ret.projection.skip !== undefined ||
    ret.projection.limit !== undefined
  ) {
    return null;
  }

  const farVar = pattern.segments[pattern.segments.length - 1].node.variable;

  if (farVar === undefined) {
    return null;
  }

  /*
   * ⚠️⚠️ **THE ITEM MUST READ ONLY THE FAR VARIABLE, AND THIS IS CHECKED RATHER THAN ASSUMED.** The pass
   * binds `farVar` and nothing else, so an item reading the START (`RETURN DISTINCT a.n`) would evaluate
   * against an unbound name — a silent wrong answer, not a decline. 🔑 `foldLevel`'s neighbour states
   * this requirement in a comment and does not test it; its argument comes from an aggregate whose
   * lowering already bounded it, and this one's does not.
   */
  const reads = freePredicateVars(ret.projection.items[0].expr);

  if (reads.size !== 1 || !reads.has(farVar)) {
    return null;
  }

  const outName = proj.items[0].name;
  const argFn = proj.items[0].fn;

  return (graph: Graph, params: Params) => {
    const { u, order } = levelWalk(graph, levels, startLabel);
    const binding = new Map<string, unknown>();
    const env: FoldEnv = { binding, params, graph };

    return distinctLevel({ u, order, argFn, env, binding, farVar, outName });
  };
};

export const detectChainFoldLevels = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const shape = chainShapeOf(m);

  if (shape === null) {
    return null;
  }

  const { levels, startLabel, pattern } = shape;
  const proj = cret.projection;
  const agg = proj.foldedAggs?.length === 1 ? proj.foldedAggs[0] : undefined;

  if (
    !proj.aggregating ||
    proj.items.length !== 1 ||
    agg === undefined ||
    agg.expr.star ||
    ret.projection.items.length !== 1 ||
    // The item must BE the aggregate, not an expression wrapping it — `count(x) + 1` folds the same
    // aggregate but its row value is the arithmetic (`detectChainFoldedAggregate`'s own rule).
    ret.projection.items[0].expr !== agg.expr
  ) {
    return null;
  }

  const { name } = agg.expr;
  const distinct = Boolean(agg.expr.distinct);

  // ⚠️ `sum`/`avg`/`collect` ARE NOT HERE, and the header says why: a multiplicity-weighted sum is a
  // different arithmetic from a per-path one, and f64 addition is not associative.
  if (name !== 'min' && name !== 'max' && name !== 'count') {
    return null;
  }

  if (distinct && name !== 'count') {
    return null;
  }

  // The fold's argument must read ONLY the far node's variable, so its value is a function of the
  // reached vertex alone — which is what makes a per-vertex pass equivalent to a per-path one.
  const farVar = pattern.segments[pattern.segments.length - 1].node.variable;

  if (farVar === undefined) {
    return null;
  }

  const outName = proj.items[0].name;
  const { argFn } = agg;

  return (graph: Graph, params: Params) => {
    const { u, order } = levelWalk(graph, levels, startLabel);
    const binding = new Map<string, unknown>();
    const env: FoldEnv = { binding, params, graph };

    return [{ [outName]: foldLevel({ u, order, name, distinct, argFn, env, binding, farVar }) }];
  };
};

/**
 * The single pass over the final level — the only part that differs between the four folds.
 *
 * ⚠️ ONE OBJECT RATHER THAN EIGHT PARAMETERS, because the lint gate caps them at six.
 * `chain-projection.ts` records item 1803 hitting the same cap and taking the same way out, with
 * `ts-closure-size-is-load-bearing` as the second reason: this stays at module scope rather than
 * becoming a closure inside the returned function.
 */
type FoldPass = {
  readonly u: Float64Array;
  readonly order: readonly Vertex[];
  readonly name: 'min' | 'max' | 'count';
  readonly distinct: boolean;
  readonly argFn: (env: FoldEnv) => unknown;
  readonly env: FoldEnv;
  readonly binding: Map<string, unknown>;
  readonly farVar: string;
};

const foldLevel = (pass: FoldPass): unknown => {
  const { u, order, name, distinct, argFn, env, binding, farVar } = pass;
  const seen = distinct ? new Set<string>() : undefined;
  let total = 0;
  let best: unknown;
  let have = false;

  for (let v = 0; v < order.length; v += 1) {
    const mult = u[v];

    if (mult === 0) {
      continue;
    }

    binding.set(farVar, order[v]);

    const cell = argFn(env);

    // ⚠️ NULL IS EXCLUDED BY EVERY ONE OF THESE FOLDS, and `count(x)` is the trap: it counts
    // non-null values, so a vertex missing the property contributes nothing even though it IS
    // reached. `detectChainFoldedAggregate`'s note records the same rule for `count(DISTINCT x)`.
    if (cell === null || cell === undefined) {
      continue;
    }

    if (name === 'count') {
      if (seen === undefined) {
        // ⚠️ MULTIPLICITY, NOT ONE PER VERTEX: `count(x)` tallies one per PATH.
        total += mult;
      } else {
        const key = valueKey(cell);

        if (!seen.has(key)) {
          seen.add(key);
          total += 1;
        }
      }

      continue;
    }

    // ⚠️ MULTIPLICITY IS IRRELEVANT HERE — an extremum over a multiset is the extremum over its
    // support, which is exactly why these two are expressible without the paths.
    if (
      !have ||
      (name === 'min' ? (cell as number) < (best as number) : (cell as number) > (best as number))
    ) {
      best = cell;
      have = true;
    }
  }

  if (name === 'count') {
    return total;
  }

  // ⚠️ `null` FOR AN EMPTY EXTREMUM, which is what the general path answers — not `undefined`, and
  // not a sentinel. `have` distinguishes "no reached vertex had a non-null value" from "the minimum
  // happens to be falsy".
  return have ? best : null;
};

/**
 * Walks FROM each start, by running the recurrence BACKWARD (item 2013).
 *
 * 🔑 **`levelWalk` ANSWERS "HOW MANY WALKS END HERE"; A GROUPED COUNT KEYED ON THE START NEEDS "HOW
 * MANY WALKS BEGIN HERE".** Same recurrence, traversed the other way, reusing the same per-level CSR
 * tables and the same label masks rather than a second mechanism:
 *
 * ```text
 *     f_k(v) = [v matches L_k] ? 1 : 0
 *     f_i(v) = [v matches L_i] * sum over v -> x of type t_{i+1} of f_{i+1}(x)
 * ```
 *
 * ⚠️ THE EDGE DIRECTION IS UNCHANGED; only the ACCUMULATION reverses. Each step still reads `v`'s
 * out-edges of the level's own type (`csrFor(graph, !forward, [type])`, the same table `levelWalk`
 * uses) and sums the NEXT level's values at their targets. Reversing the TABLES instead would answer
 * a mirror-image question on any graph that is not symmetric — the defect item 2004's
 * `direction-ignored` mutant exists to catch.
 */
const walksFromStart = (
  graph: Graph,
  levels: readonly Level[],
  startLabel: string | undefined,
): { f: Float64Array; order: readonly Vertex[] } => {
  const first = csrFor(graph, !levels[0].forward, [levels[0].type]);
  const n = first.order.length;
  const last = levels[levels.length - 1].label;
  let f = new Float64Array(n);
  let prev = new Float64Array(n);

  for (let v = 0; v < n; v += 1) {
    f[v] = last === undefined || first.order[v].labels.has(last) ? 1 : 0;
  }

  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const level = levels[i];
    const { off, nbr, order } = csrFor(graph, !level.forward, [level.type]);
    // Position `i` is entered by level `i`'s edge, so stepping OUT of position `i - 1` reads level
    // `i`'s type and tests position `i - 1`'s own label — the start's at `i === 0`.
    const hereLabel = i === 0 ? startLabel : levels[i - 1].label;
    const swap = prev;

    prev = f;
    f = swap;
    f.fill(0);

    for (let v = 0; v < n; v += 1) {
      if (hereLabel !== undefined && !order[v].labels.has(hereLabel)) {
        continue;
      }

      const end = off[v + 1];
      let acc = 0;

      for (let k = off[v]; k < end; k += 1) {
        acc += prev[nbr[k]];
      }

      f[v] = acc;
    }
  }

  return { f, order: first.order };
};

/**
 * `MATCH <chain of 2+ segments> … RETURN <start>.k, count(*)` GROUPED — from the walk counts, with
 * no row materialized (item 2013).
 *
 * ⚠️⚠️ **IT TAKES BOTH SPELLINGS, AND THAT IS HALF THE POINT.** `detectChainGroupedCount` opens with
 * `clauses.length !== 2`, and `LET g = a.n … GROUP BY g` parses as THREE clauses — so the explicit
 * grouping, which is the ONLY way to write it (`GROUP BY` takes a bound name) and the form item
 * 1817's realistic corpus uses, reached no rung at all: **72.08 ms against the aliased form's 24.38
 * for the same 97 groups, a 2.96x cliff** (item 2012). `groupedClauses` admits 2 OR 3 clauses and
 * `groupedProjection` resolves the key through the LET — both already exported and used by
 * `grouped-hop.ts` and `node-scan.ts`, so this rung uses the shared readers rather than a third copy.
 *
 * 🔑 **AND THE KEY IS READ DIRECTLY, NOT THROUGH THE COMPILED PROJECTION, which is what makes the LET
 * form work at all.** For the 3-clause form the compiled key item evaluates the variable `g`, bound
 * by a LET clause this rung skips — so calling it would read an unbound name. `grouped-hop.ts`
 * resolves the key to a PROPERTY of one end and reads it with `propOf`; this does the same.
 *
 * ⚠️ `ORDER BY` AND THE WINDOW GO THROUGH THE SHARED APPLIERS (`groupedSortApplier`, `keepGroups`),
 * because about half the corpus's grouped draws are wrapped in one and refusing them would leave half
 * the family on the slow path. `having` is refused — it needs a group representative this rung does
 * not build.
 *
 * ⚠️ GROUP ORDER IS FIRST-SEEN AND IS A CONTRACT THE DIFFERENTIAL FUZZER CANNOT SEE
 * (`grouped-hop.ts`: "the pinned contract both engines keep"; grouped results compare as MULTISETS).
 * This walks `order`, which `csrFor` builds from `graph.verticesById` in insertion order — the same
 * order the general path visits starts in — and inserts into a `Map`, which preserves it.
 */
export const detectChainGroupedLevels = (clauses: readonly Clause[]): AlwaysRowsFn | null => {
  const shape = groupedClauses(clauses);

  if (shape === null) {
    return null;
  }

  const chain = chainShapeOf(shape.match);

  if (chain === null) {
    return null;
  }

  const letName = shape.let?.var;
  const picked = groupedProjection(shape.ret.projection, letName);

  if (picked === null || picked.having !== undefined || picked.keyCol === undefined) {
    return null;
  }

  // Resolve the key to a property of the START, through the LET when there is one.
  let keySource: Expr | undefined = picked.keyExpr;

  if (shape.let !== undefined) {
    keySource =
      picked.keyExpr.kind === 'var' && picked.keyExpr.name === letName ? shape.let.expr : undefined;
  }

  // ⚠️ THE KEY MUST BE ON THE **START**: keyed anywhere else the count is not a per-start quantity
  // and this recurrence cannot express it. `grouped-hop.ts`'s far-key walk is the shape that needs
  // per-edge visits, and item 1313 records why it cannot be reordered.
  if (
    keySource?.kind !== 'prop' ||
    chain.pattern.start.variable === undefined ||
    keySource.variable !== chain.pattern.start.variable
  ) {
    return null;
  }

  const { key } = keySource;
  const { keyCol, countAt } = picked;
  const countItem = shape.ret.projection.items[countAt];
  // ⚠️ THE ALIAS WINS WHEN THERE IS ONE — `count(*) AS c` names the column `c`, and `columnName`
  // derives a name from the EXPRESSION, which for an aggregate is not what the row is keyed by.
  const countCol = countItem.alias ?? columnName(countItem.expr);
  const applySort = groupedSortApplier(
    shape.ret.projection.orderBy ?? [],
    [keyCol, countCol],
    keyCol,
    keySource,
  );

  if (applySort === null) {
    return null;
  }

  const { skip, limit } = shape.ret.projection;

  return (graph: Graph, params: Params) => {
    const { f, order } = walksFromStart(graph, chain.levels, chain.startLabel);
    const groups = new Map<string, { key: unknown; n: number }>();

    for (let v = 0; v < order.length; v += 1) {
      // ⚠️ A ZERO COUNT IS NOT A GROUP: a start with no matching chain contributes no row on the
      // general path either, so an empty group must never appear.
      if (f[v] === 0) {
        continue;
      }

      const kv = propOf(order[v], key);
      const kk = valueKey(kv);
      const seen = groups.get(kk);

      if (seen === undefined) {
        groups.set(kk, { key: kv, n: f[v] });
      } else {
        seen.n += f[v];
      }
    }

    const rows: Row[] = [];

    for (const { key: kv, n } of groups.values()) {
      rows.push({ [keyCol]: kv, [countCol]: n });
    }

    const sorted = applySort(rows);
    const from = resolveCount(skip, params) ?? 0;
    const take = resolveCount(limit, params);

    return from === 0 && take === undefined
      ? sorted
      : sorted.slice(from, take === undefined ? undefined : from + take);
  };
};
