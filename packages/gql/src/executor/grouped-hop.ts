/**
 * GROUPED HOP RUNGS: `GROUP BY` over a one-hop pattern, counted or aggregated without materialising
 * the rows.
 *
 * `detectGroupedHopCount` and `detectGroupedHopAggregate` plus the eight symbols only they reach.
 *
 * ⚠️ `reachedOnSide` IS THE MIRROR-SPELLING RULE IN THIS FAMILY. `(a:L)-[:T]->(b)` and
 * `(a)-[:T]->(b:L)` are the same question asked from opposite ends, and a rung that serves one and
 * declines the other makes two spellings of one query cost different amounts — the defect class
 * CLAUDE.md opens with, and one this file has re-learned at items 125, 137 and 286. Both sides get
 * the gate.
 *
 * ⚠️ `primedGroupedExtremum` EXISTS BECAUSE AN EXTREMUM HAS NO IDENTITY ELEMENT. A sum starts at 0
 * and a count at 0, but a `min` has to start at the FIRST value seen, not at a sentinel — a
 * `NEG_INFINITY` seed renders as `null` at egress, so a `max` that wrongly skips its first value
 * returns the same JSON as one that is right (item 1161's lesson, in the grouped form).
 */

import type { Edge, Graph } from '@lenke/core';

import type {
  Clause,
  Expr,
  LabelExpr,
  NodePattern,
  PathPattern,
  Projection,
  RelPattern,
} from '../ast.js';
import { candidateVertexSource, directedBucket, expand, matchesLabel } from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { relTypeNames } from './adjacency.js';
import { aggregateOverValues, compilePredicate } from './core.js';
import type { AggFold, CClause, CompiledExpr, Params, Row } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import { plainNode, plainRel } from './hop-sides.js';
import type { InlineGate, InlinePred } from './inline-gate.js';
import { composeInlineGate, inlineOf, predFor } from './inline-gate.js';
import { vacuousLabel } from './labels.js';
import { columnName, valueKey } from './rows.js';
import type { ReachFn } from './shortcuts.js';
import {
  bucketSumsAreSound,
  groupIndex,
  groupedAccs,
  groupedClauses,
  groupedCountRow,
  groupedProjection,
  groupedSortApplier,
  keepGroups,
  pageGroups,
  pageIsEmpty,
  refsOnlyVar,
  sortGroupRows,
} from './shortcuts.js';
import { isNullish, propOf } from './values.js';

/**
 * The clause `WHERE` as an inline predicate on the KEYED end — `null` to decline, `undefined` when
 * there is none.
 *
 * Extracted from `detectGroupedHopAggregate` because admitting `ORDER BY` there (item 1249) pushed
 * it to 36 of the 35 complexity cap, and this block is the cheapest honest thing to lift out: the
 * decision reads only the clause and the keyed variable. Same reason `hopAccFor` and item 1247's
 * wiring were extracted; the cap has been right in this file every time.
 *
 * A predicate reading ANY other variable declines, because this walk binds only the keyed end.
 */
export const keyedClausePred = (
  where: Expr | undefined,
  keyedVar: string | undefined,
): InlinePred | null | undefined => {
  if (where === undefined) {
    return undefined;
  }

  for (const nameRead of freePredicateVars(where)) {
    if (nameRead !== keyedVar) {
      return null;
    }
  }

  return predFor(compilePredicate(undefined, where, keyedVar), keyedVar, true);
};
/**
 * May a hop fast path that binds only NODES accept this relationship variable?
 *
 * Yes when nothing reads it and it collides with neither end's name. The walks behind the
 * grouped tally and the grouped aggregate never bind an edge, so a name with no read cannot
 * change an answer — refusing it cost 2.3x on both (328 against 761, 392 against 805 at 200,000
 * nodes / 1,000,000 edges, item 488).
 *
 * The COLLISION case is the one that bites: `MATCH (x:P)-[x:T]->(b)` names the rel and the start
 * the same, which matches nothing and answers `[]`. A fast path that simply ignored the rel
 * name would return rows instead. Item 487 shipped exactly that shape of bug one tick earlier
 * — there a repeated rel name across two segments — so here it is a precondition rather than a
 * discovery.
 *
 * `freePredicateVars` rather than a string scan: every position checked below is an `Expr` the
 * shape already restricts (a key, a `count(*)`, a row-local aggregate argument, a clause
 * `WHERE`), and none of them can contain a subquery, which is the one construct
 * `freePredicateVars` under-reports (item 444).
 *
 * WHICH OF THESE CHECKS EARNS ITS KEEP. Only the COLLISION one: mutation says the three READ
 * checks are redundant, because every position is already refused elsewhere — the key must be
 * a property of an END (`keySource`), an aggregate argument must read the KEYED end
 * (`refsOnlyVar`), a clause `WHERE` may read only the keyed end, and an `ORDER BY` on anything
 * but a projected column declines before it gets here. All three mutants survive, including
 * against a test that sorts by `r.w`.
 *
 * They stay anyway, and the reason is specific rather than habitual: each of those covering
 * rules is one relaxation away from letting an expression that reads the edge reach a walk
 * with no edge bound, and the failure mode is a silent wrong answer rather than a slow query.
 * Recorded here so the next reader does not have to re-derive the mutation run (items 469 and
 * 486 made the same call; item 475 removed a guard whose redundancy was provable by reading,
 * which this one's is not).
 */
export const relVarInert = (
  relVar: string | undefined,
  ends: readonly (string | undefined)[],
  projection: Projection,
  where: Expr | undefined,
): boolean => {
  if (relVar === undefined) {
    return true;
  }

  if (ends.includes(relVar)) {
    return false;
  }

  const reads = (e: Expr | undefined): boolean =>
    e !== undefined && freePredicateVars(e).has(relVar);

  return (
    !projection.items.some((i) => reads(i.expr)) &&
    !(projection.orderBy ?? []).some((o) => reads(o.expr)) &&
    !(projection.groupBy ?? []).some(reads) &&
    !reads(projection.having) &&
    !reads(where)
  );
};
/**
 * `MATCH (a:L)-[:T]->(b) RETURN <b.k or a.k>, count(*)` — a GROUPED count over a hop, the
 * empty cell in the count matrix.
 *
 * | shape  | plain        | filtered     | grouped          |
 * | ------ | ------------ | ------------ | ---------------- |
 * | node   | O(1) bucket  | item 135     | items 99 + 141   |
 * | 1-hop  | bucket sums  | items 129/137| **this**         |
 *
 * `detectGroupedNodeCount` requires `segments.length === 0`, so every grouped count over a hop
 * fell to the general path: one binding and one row per EDGE, then grouping. Measured on
 * 200,000 vertices / 1,000,000 edges, where the same hop counted globally is 0.1ms:
 *
 *     MATCH (a:Person)-[:KNOWS]->(b) RETURN b.age, count(*)   1065ms   (1065ns an edge)
 *     MATCH (a:Person)-[:KNOWS]->(b) RETURN a.age, count(*)    951ms
 *
 * ### Two walks, because the key's END decides the shape
 *
 * - **Key on the FAR end**: one pass over the type's edge bucket, reading the far property per
 *   edge. O(E), like `tallyHopCount`.
 * - **Key on the START**: one pass over the start vertices, reading the property ONCE and
 *   adding that vertex's whole matching degree to its group. O(V), like `startOnlyHopCount` —
 *   so it reads 200,000 properties where the general path read 1,000,000.
 *
 * ### The filter comes with it, in the same change
 *
 * Items 135, 137 and 141 each had to go back and add the filter to a tally that refused one,
 * at 2.5-6.4x a time. A filter is carried here if it reads ONLY the keyed end — the vertex is
 * already in hand there, so it costs one gate call. A filter on the OTHER end declines.
 *
 * ### The start-key walk checks DEGREE before the filter, deliberately
 *
 * A start vertex with no matching edge contributes no rows, so the general path never
 * evaluates the predicate on it. Evaluating it anyway RAISES where the general path returns
 * groups, and which queries raise is part of the cross-engine invariant — the 3.1x that item
 * 139 had to reject. Hence degree first, gate second.
 */
export const detectGroupedHopCount = (clauses: readonly Clause[]): ReachFn | null => {
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
  const [pattern] = shape.match.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node: far } = seg;

  if (
    !plainRel(rel) ||
    rel.direction === 'both' ||
    !relVarInert(
      rel.variable,
      [start.variable, far.variable],
      shape.ret.projection,
      shape.match.where,
    )
  ) {
    return null;
  }

  // An ANONYMOUS end is fine: nothing can reference it, so the name was only ever used to bind
  // a predicate. Requiring BOTH ends to be named made two spellings of ONE question cost 2.2x
  // apart — `MATCH (:Person)-[:KNOWS]->(b) RETURN b.age, count(*)` at 735 ms against the named
  // `(a:Person)` at 335 over 1,000,000 edges (item 475) — which is the bug class this repo is
  // named after.
  //
  // There is no replacement guard here, and that is deliberate: the KEYED end is named BY THE
  // KEY EXPRESSION, so `keySource.variable !== far.variable` below already refuses a pattern
  // whose keyed end has no name. A guard added here as well SURVIVED its mutant — redundant
  // with the one twenty lines down — so it was removed rather than left as a line no test can
  // fail on.
  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  // Resolve the group key to a property of one END of the hop.
  let keySource: Expr | undefined = keyExpr;

  if (shape.let !== undefined) {
    keySource = keyExpr.kind === 'var' && keyExpr.name === letName ? shape.let.expr : undefined;
  }

  if (keySource?.kind !== 'prop') {
    return null;
  }

  // `keySource.variable` is a real name (a `prop` always has one), so comparing it against an
  // anonymous end's `undefined` is a mismatch rather than an accidental hit.
  const onStart = keySource.variable === start.variable;

  if (!onStart && keySource.variable !== far.variable) {
    return null;
  }

  const keyed = onStart ? start : far;
  const other = onStart ? far : start;

  // The NON-keyed end must be plain: the walks apply nothing to it beyond its label, and the
  // start-key walk cannot apply even that (it adds a whole degree, not per-edge matches).
  if (!plainNode(other) || (onStart && other.label !== undefined)) {
    return null;
  }

  // The keyed end's inline constraint and the clause `WHERE` are the two spellings of one
  // filter; both go through `inlineHolds` -> `satisfies`, as in item 141.
  const inKeyed = inlineOf(keyed);

  if (inKeyed === null) {
    return null;
  }

  const preds: InlinePred[] = [];

  if (inKeyed !== undefined) {
    preds.push(inKeyed);
  }

  const { where } = shape.match;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== keyed.variable) {
        return null;
      }
    }

    preds.push(predFor(compilePredicate(undefined, where, keyed.variable), keyed.variable, true));
  }

  const gate = composeInlineGate(preds);

  // The start-key walk seeds from the label bucket, which `candidateVertices` fills exactly
  // only for a SIMPLE label (see item 138).
  const startLabel = start.label;

  if (onStart && startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const { key } = keySource;
  const countCol = items[countAt].alias ?? columnName(items[countAt].expr);
  const countFirst = countAt === 0;
  // The variable a `HAVING` reads its representative through: the KEYED end, which is the one
  // this tally groups by and the one whose vertex each slot holds.
  const repVar = keySource.variable;
  const out = rel.direction === 'out';
  const farLabel = far.label;
  const adjacency: Adjacency = {
    direction: rel.direction,
    ...(rel.label ? { label: rel.label } : {}),
  };

  return (graph, params) => {
    if (pageIsEmpty(params, limit)) {
      return [];
    }

    const groups = groupIndex();
    const binding = new Map<string, unknown>();
    const { bump: add } = groups;

    // Summing per-type bucket sizes is sound only when no edge sits in two of them, and that
    // is a RUNTIME property of the graph — so the degree walk is chosen per call, with the
    // per-edge walk as the always-correct alternative rather than a decline. (A `ReachFn`
    // returns rows; it has no way to decline once built.)
    const bucketSumSound = bucketSumsAreSound(types, graph.multiTypeEdgeCount);
    const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;
    const farPb = vacuousLabel(graph, farLabel) ? undefined : farLabel;

    // BOTH walks visit start vertices via `candidateVertices` and then that vertex's own
    // bucket — the order the general path uses. Group order is FIRST-SEEN and observable, so
    // it is not enough to count the right edges; they have to be met in the same order. See
    // the rejected far-end degree walk recorded on this function.
    //
    // ⚠️ "NO SKIP/LIMIT" IS NOT A SUFFICIENT NARROWING, and that was tried and REFUTED at item
    // 1313. The reasoning that invites it is sound as far as it goes: a window is what makes group
    // order decide WHICH groups come back, an `ORDER BY` sorts whatever order arrived, and item
    // 1296 established that a grouped result without `ORDER BY` is compared as a row MULTISET. So
    // a far-key degree walk admitted only when `skip === undefined && limit === undefined` looks
    // safe, and it is worth 3.5x (304.8 ms against the start-key walk's 87.3 on 200,000 nodes /
    // 1,000,000 edges).
    //
    // It is not safe, because first-seen group order is a CONTRACT and not merely a consequence.
    // `paged-count.test.ts` calls it "the pinned contract both engines keep", and
    // `grouped-hop-rel-variable.test.ts` has a case named "the TALLY answers as it does without
    // the name, IN ORDER" — a test named for the ordering pins it deliberately. Both failed on the
    // narrowed walk, with no window in sight. Changing TS's order would also diverge from the
    // native engine on a contract the differential fuzzer cannot see, because it compares grouped
    // results as multisets.
    //
    // And far-driving preserves that order in NO iteration order, which item 1313 measured rather
    // than argued: with `a -> z` inserted before `b -> y` and `y` created first, the general path
    // emits `KZ` first, `edgesToByLabel` order gives `KZ` too, and far-vertex CREATION order gives
    // `KY`. So item 138's rejection generalises past its own source. Do not re-derive this a
    // fourth time.
    for (const v of candidateVertexSource(graph, startLabel)) {
      const byType = index.get(v.id);

      if (byType === undefined) {
        continue;
      }

      if (onStart && bucketSumSound && farPb === undefined) {
        let deg = 0;

        if (types === undefined) {
          for (const set of byType.values()) {
            deg += set.size;
          }
        } else {
          for (const t of types) {
            deg += byType.get(t)?.size ?? 0;
          }
        }

        // DEGREE FIRST: a vertex with no matching edge must never reach the filter. See the
        // raise-parity note above.
        if (deg === 0) {
          continue;
        }

        if (gate !== undefined && !gate(v, binding, params, graph)) {
          continue;
        }

        add(propOf(v, key), deg, v);

        continue;
      }

      // Per EDGE: either the key is on the far end (so each edge's own endpoint must be
      // read), or a bucket sum would double-count a multi-type edge, or a far label has to
      // be applied per edge.
      //
      // `expand` is the GENERAL PATH's own adjacency iterator, used rather than a hand-rolled
      // bucket loop for two reasons it already gets right: it takes a single concrete type
      // straight from its bucket, and for anything else it dedupes a multi-label edge across
      // the per-type buckets with a `Set`. Hand-rolling the bucket loop counted a `T|S` edge
      // TWICE under `-[:T|S]->` — caught by the multi-label test, which the general path
      // answered correctly.
      /**
       * ⚠️ THE LOOP BODY IS WRITTEN TWICE, and the duplication buys removing `expand`'s generator
       * resume AND its per-edge `{ edge, node }` allocation — **16.3%** of this shape's profile with
       * the garbage collector at 8.1% beside it (item 1621).
       *
       * `directedBucket` returns a shape ONLY for the directed single-type case, which is the one
       * `expand` itself fast-paths and the one where nothing needs deduping. Every other pattern
       * still goes through `expand`, which is what the paragraph above is about: hand-rolling the
       * general case counted a `T|S` edge TWICE under `-[:T|S]->`, because the per-type buckets both
       * hold it and only `expand`'s `Set` dedupes across them.
       *
       * The two bodies are identical line for line, and the risk of that is drift rather than the
       * duplication itself — so the multi-label test that caught the original double-count still
       * covers the `expand` arm, and item 1621's own tests cover both arms with the same fixture.
       *
       * ⚠️ THE ROUTE ITSELF IS UNPINNED, the same limit item 1619 recorded for all twenty rungs:
       * making this `if` never fire is answer-equivalent (the bodies are identical, which is the
       * point) and the whole suite passes. What IS pinned is `directedBucket`'s verdict — it is
       * exported and unit-tested directly, so every way it could admit the wrong shape dies. Only
       * "the caller stopped asking" survives, and there is nothing to assert about it that is not a
       * timing test.
       */
      const direct = directedBucket(v, adjacency);

      if (direct !== undefined) {
        const { set, forward } = direct;

        for (const edge of set) {
          const node = forward ? edge.to : edge.from;

          if (farPb !== undefined && !matchesLabel(node, farPb)) {
            continue;
          }

          const keyedNode = onStart ? v : node;

          if (gate !== undefined && !gate(keyedNode, binding, params, graph)) {
            continue;
          }

          add(propOf(keyedNode, key), 1, keyedNode);
        }

        continue;
      }

      for (const step of expand(graph, v, adjacency)) {
        const { node } = step;

        if (farPb !== undefined && !matchesLabel(node, farPb)) {
          continue;
        }

        const keyedNode = onStart ? v : node;

        if (gate !== undefined && !gate(keyedNode, binding, params, graph)) {
          continue;
        }

        add(propOf(keyedNode, key), 1, keyedNode);
      }
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
 * The `(start)-[:T]->(far)` of a single plain, directed, untyped-variable hop, or `null`.
 * Extracted from `detectGroupedHopAggregate` because the complexity cap was right: the shape
 * checks and the projection checks are two jobs.
 *
 * `direction === 'both'` IS admitted (item 477). The tally refuses it because a bucket SUM
 * double-counts an edge whose ends both match; this rung never sums buckets — it walks
 * `expand` per start vertex, which is what the general path walks, so an edge between two
 * matching ends is met once from each end exactly as the general path meets it. Item 476 found
 * the guard's mutant surviving with correct answers and left it priced; measured, the
 * undirected grouped hop was **1849 ms** against the directed shape's 399.
 */
export const plainOneHop = (
  pattern: PathPattern,
): { start: NodePattern; rel: RelPattern; far: NodePattern } | null => {
  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const [seg] = pattern.segments;
  const { rel, node: far } = seg;

  if (!plainRel(rel)) {
    return null;
  }

  return relTypeNames(rel.label) === null ? null : { start: pattern.start, rel, far };
};
/**
 * `MATCH (a:L)-[:T]->(b) RETURN <keyed.k> AS key, <aggregates…>` — a GROUPED aggregate over a
 * hop that the `count(*)` tally cannot take.
 *
 * WHY THIS EXISTS. `detectGroupedHopCount` bumps an integer, so one `max` in the projection
 * sends the whole query to the general path — a `Binding` per EDGE. Measured at 200,000 nodes
 * over 1,000,000 edges (item 476): `b.age AS k, count(*)` 335 ms (the tally),
 * `b.age AS k, max(b.age)` **759**, `b.age AS k, count(*), max(b.age)` **895**.
 *
 * It walks exactly where the tally's PER-EDGE arm walks — `candidateVertexSource` then
 * `expand`, the general path's own adjacency iterator — so first-seen group order is the same
 * traversal, which is the property the tally's header insists on and the one a reordering walk
 * would break. The tally's degree shortcut is NOT reused: a degree is a count, and these
 * aggregates need the edge's own endpoint.
 *
 * `sum`/`avg` are refused, as on every other walk-based rung (items 419, 472): the admission
 * set is `foldFor`'s.
 *
 * The shape resolution below repeats the tally's rather than sharing it. That is a deliberate
 * trade — `groupedProjection` is shared with the NODE tally, and widening it would change two
 * hot detectors at once — but it means a guard fixed here must be fixed there too.
 */
/**
 * The accumulator shape {@link primedGroupedExtremum} needs, stated structurally so the helper does
 * not depend on the full grouped-acc union: only the `fold` arm can ride the per-endpoint path, and
 * the caller's extremum test is what guarantees every accumulator is one.
 */
export type GroupedAccLike =
  | {
      readonly kind: 'fold';
      readonly out: string;
      readonly fold: AggFold;
      readonly argFn: CompiledExpr;
    }
  | { readonly kind: 'rows' | 'values'; readonly out: string };
/** Only `min`/`max` license the per-endpoint fold — see {@link primedGroupedExtremum}. */
export const GROUPED_EXTREMA = new Set(['min', 'max']);
/**
 * Does `byType` hold at least one edge of a wanted type? A bucket SIZE answers it, so nothing is
 * resolved per edge — which is the whole point of the walk below.
 *
 * An empty `types` means the relationship was untyped, i.e. EVERY type, so any non-empty bucket
 * counts.
 */
export const reachedOnSide = (
  byType: ReadonlyMap<string, ReadonlySet<Edge>> | undefined,
  types: readonly string[],
): boolean => {
  if (byType === undefined) {
    return false;
  }

  if (types.length === 0) {
    for (const set of byType.values()) {
      if (set.size > 0) {
        return true;
      }
    }

    return false;
  }

  for (const t of types) {
    if ((byType.get(t)?.size ?? 0) > 0) {
      return true;
    }
  }

  return false;
};
/**
 * The GROUPED per-endpoint extremum fold (item 1310) — `MATCH (a)-[:T]->(x) RETURN x.city,
 * min(x.age)` folded once per DISTINCT ENDPOINT rather than once per edge.
 *
 * Items 1248, 1296 priced this and specified it; this is that specification built. The identity is
 * the one `primedEndpointExtremum` uses for the UNGROUPED case, extended by one step: min/max over
 * a multiset equal min/max over its distinct SUPPORT, and when the GROUP KEY reads only the far
 * endpoint each distinct endpoint belongs to exactly ONE group, so folding it once into that
 * group's accumulator is the same answer. ~200,000 endpoints answer what 1,000,000 edges are asked.
 *
 * ⚠️ HALF OF THIS IDEA IS A REGRESSION ON ITS OWN, which is why the run-time test below is not
 * optional. Item 1245 priced the parts separately:
 *
 * ```text
 *   the per-edge walk                  173698.3 us
 *   per-distinct-endpoint fold         186070.9     1.07x WORSE   <- the dedup ALONE loses
 *   the same + universal-label test     59851.6     2.90x BETTER
 * ```
 *
 * Folding per endpoint only pays once the START label costs nothing to test. Without that, proving
 * "x has a qualifying in-edge from a qualifying start" has to resolve `e.from` per in-edge and
 * gives back more than the multiplicity saved. When the label is carried by EVERY live node a
 * non-empty bucket IS the proof, so nothing is resolved — hence `vacuousLabel`, and hence the test
 * is at RUN time: vacuity is a property of the GRAPH, not of the query.
 *
 * ROW ORDER. This walk iterates the FAR side where the per-edge walk iterates the start side, so
 * groups can come out in a different order. Item 1296 established that this is not observable: the
 * differential fuzzer compares a grouped result as a row MULTISET because "intra-group row order in
 * a CALL without ORDER BY is unspecified", which matches the repo's settled policy, and item 1249
 * gave this rung a real `sortGroupRows` path for when the user does ask for an order. The caller
 * applies that sort to whichever walk ran, so an ordered query is unaffected either way.
 *
 * `null` means "not admissible on this graph", and the caller falls through to the per-edge walk —
 * a branch inside one closure rather than a second rung, because `clauses.ts` would otherwise fall
 * past the whole rung instead of to its walk.
 */
export const primedGroupedExtremum = (o: {
  readonly accs: readonly GroupedAccLike[];
  readonly types: readonly string[];
  readonly outward: boolean;
  readonly bothDirections: boolean;
  readonly startLabel: LabelExpr | undefined;
  readonly farLabel: LabelExpr | undefined;
  readonly keyVar: string;
  readonly key: string;
  readonly keyCol: string;
  readonly keyAt: number;
  readonly gate: InlineGate | undefined;
}): ((graph: Graph, params: Params) => Row[] | null) => {
  const { accs, types, outward, bothDirections, startLabel, farLabel } = o;
  const { keyVar, key, keyCol, keyAt, gate } = o;

  return (graph, params) => {
    // THE RUN-TIME ADMISSION — see the regression table above.
    if (startLabel !== undefined && !vacuousLabel(graph, startLabel)) {
      return null;
    }

    const slots: { readonly key: unknown; readonly state: unknown[] }[] = [];
    const bySeen = new Map<unknown, (typeof slots)[number]>();
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    // An undirected hop reads BOTH sides; a directed one reads the side the far endpoint is on.
    const index = outward ? graph.edgesToByLabel : graph.edgesFromByLabel;
    const opposite = outward ? graph.edgesFromByLabel : graph.edgesToByLabel;
    const farPb = vacuousLabel(graph, farLabel) ? undefined : farLabel;

    for (const x of candidateVertexSource(graph, farLabel)) {
      if (farPb !== undefined && !matchesLabel(x, farPb)) {
        continue;
      }

      // ⚠️ A SELF-LOOP NEEDS NO CORRECTION HERE, for `primedEndpointExtremum`'s reason: this asks
      // only "is x reached at all", a BOOLEAN, and then folds x's value ONCE. A loop sits in both
      // adjacency maps and makes the answer true either way, and min/max do not care how many
      // times a value would have arrived.
      let reached = reachedOnSide(index.get(x.id), types);

      if (!reached && bothDirections) {
        reached = reachedOnSide(opposite.get(x.id), types);
      }

      if (!reached) {
        continue;
      }

      if (gate !== undefined && !gate(x, binding, params, graph)) {
        continue;
      }

      const raw = propOf(x, key);
      const id = raw === null || typeof raw !== 'object' ? raw : valueKey(raw);
      let slot = bySeen.get(id);

      if (slot === undefined) {
        slot = {
          key: raw,
          state: accs.map((a) => (a.kind === 'fold' ? a.fold.init() : undefined)),
        };
        bySeen.set(id, slot);
        slots.push(slot);
      }

      binding.set(keyVar, x);

      // An INDEX loop, not `.entries()` — item 469 measured that iterator's per-accumulator tuple
      // at 40-55% of a multi-aggregate scan.
      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (a.kind !== 'fold') {
          continue;
        }

        const value = a.argFn(env);

        if (isNullish(value)) {
          continue;
        }

        slot.state[i] = a.fold.step(slot.state[i], value);
      }
    }

    return slots.map((slot) => {
      const row: Row = {};

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (i === keyAt) {
          row[keyCol] = slot.key;
        } else if (a.kind === 'fold') {
          // `finish` over an untouched accumulator gives the general path's answer for a group
          // whose every value was null.
          row[a.out] = a.fold.finish(slot.state[i]);
        }
      }

      return row;
    });
  };
};
/**
 * The per-endpoint extremum fold for a grouped hop, or `undefined` when the shape is not admitted
 * (item 1310), specified by item 1296.
 *
 * A FREE FUNCTION rather than a dozen lines in the detector, and for the reason this file keeps
 * re-learning: inlined, it took `detectGroupedHopAggregate` to a complexity of 40 against a cap of
 * 35 — the same wall item 1249 hit when it admitted `ORDER BY` there, and the same reason
 * `groupedSortApplier` lives outside it. This decides a route ONCE PER QUERY, where the walk it
 * selects runs once per endpoint.
 *
 * Four conditions, each load-bearing and each with its own mutant:
 *   * the KEY reads only the far variable (`!onStart`), which is what makes each distinct endpoint
 *     belong to exactly ONE group. A start-keyed group does not, so folding it is a wrong answer;
 *   * every non-key projection item is `min`/`max` with one argument. This is the half that does
 *     the work: `foldFor` admits count/min/max, so `count(x)` builds a `fold` acc that ONLY the
 *     name test refuses;
 *   * every accumulator is a streaming `fold`. ⚠️ THIS GUARD'S MUTANT SURVIVES, and it is kept as
 *     a precondition rather than deleted. Every shape that would expose it — a `values` acc from
 *     `collect`/`percentile`, or a DISTINCT extremum — is refused by the RUNG upstream, which
 *     `compileLinear` shows directly: `routes()` returns `[]` for
 *     `RETURN x.grp, min(DISTINCT x.n)`, so no rung fires and the general path answers. Two
 *     wrong guesses preceded that measurement (first "redundant with the name test", then "a test
 *     gap"), which is why the route check is recorded here rather than the reasoning;
 *   * the relationship's label is a plain type list, so reachability is a bucket read. ⚠️ THIS
 *     GUARD'S MUTANT ALSO SURVIVES, for the same reason: `relTypeNames` does return `null` for a
 *     negated label, but `routes()` returns `[]` for `-[:!T]->` and for `-[:%]->`, so the rung
 *     declines a non-plain relationship label before the fold is consulted. Kept because the
 *     three-way meaning of `relTypeNames` is easy to collapse — the first cut of this extraction
 *     did collapse it, and only the typechecker caught that;
 *   * the aggregate arguments read the keyed end only — enforced by the caller.
 *
 * ⚠️ THE KEY'S SLOT IS A `{kind:'rows'}` PLACEHOLDER that `groupedAccs` pushes so the column can be
 * written by index, so it is EXCLUDED from the acc-kind test rather than required to be a fold. The
 * first cut required every acc to be a fold, which no admissible query can satisfy — the rung
 * stayed green and the target did not move, which is the silent-decline failure that looks exactly
 * like the lever not existing.
 *
 * The START-label condition is deliberately NOT here: vacuity is a property of the GRAPH, not of
 * the query, so it is tested at run time inside the returned closure, which is also where the
 * regression table that justifies it lives.
 */
export const groupedEndpointFold = (o: {
  readonly onStart: boolean;
  readonly accs: readonly GroupedAccLike[];
  readonly keyAt: number;
  readonly items: readonly { readonly expr: Expr }[];
  readonly keyExpr: Expr;
  readonly rel: RelPattern;
  readonly startLabel: LabelExpr | undefined;
  readonly farLabel: LabelExpr | undefined;
  readonly keyVar: string;
  readonly key: string;
  readonly keyCol: string;
  readonly gate: InlineGate | undefined;
}): ((graph: Graph, params: Params) => Row[] | null) | undefined => {
  // ⚠️ `relTypeNames` HAS THREE MEANINGS and they must not be collapsed: `undefined` is an UNTYPED
  // relationship, i.e. EVERY type, which `reachedOnSide` handles as an empty list; `null` is a
  // label expression that is not a plain type list, which must DECLINE; and an array is the types.
  // Declining on `undefined` would silently refuse `-[]->`, and admitting `null` would read the
  // wrong buckets — a wrong answer either way.
  const types = relTypeNames(o.rel.label);

  if (o.onStart || types === null) {
    return undefined;
  }

  if (!o.accs.every((a, i) => i === o.keyAt || a.kind === 'fold')) {
    return undefined;
  }

  const extremaOnly = o.items.every(
    (it) =>
      it.expr === o.keyExpr ||
      (it.expr.kind === 'func' && GROUPED_EXTREMA.has(it.expr.name) && it.expr.args.length === 1),
  );

  if (!extremaOnly) {
    return undefined;
  }

  return primedGroupedExtremum({
    accs: o.accs,
    types: types ?? [],
    outward: o.rel.direction === 'out',
    bothDirections: o.rel.direction === 'both',
    startLabel: o.startLabel,
    farLabel: o.farLabel,
    keyVar: o.keyVar,
    key: o.key,
    keyCol: o.keyCol,
    keyAt: o.keyAt,
    gate: o.gate,
  });
};
export const detectGroupedHopAggregate = (
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

  const hop = plainOneHop(m.patterns[0]);

  if (hop === null) {
    return null;
  }

  const { start, rel, far } = hop;

  // A rel VARIABLE is inert here for the reason `relVarInert` records — this walk binds only
  // nodes — but a name COLLIDING with an end, or read by any position, still declines.
  if (!relVarInert(rel.variable, [start.variable, far.variable], ret.projection, m.where)) {
    return null;
  }

  // One non-aggregate item, a property of one END; the rest aggregates over the KEYED end.
  //
  // ITEM 553 SAID THIS RUNG NEEDED THE WALK FORCING AND THAT WAS WRONG — a guess from item 419's
  // rule rather than a reading of the loop below, which iterates
  // `candidateVertexSource(graph, startLabel)` and expands, with no far-driven alternative
  // anywhere. Its visit order is the start side's, which is the general path's. So the only
  // condition is the SEED hazard item 553 demonstrated, and it is the same flag (item 554).
  //
  // The `unfiltered` value itself is computed below, once the keyed end is known: the filter can
  // be written on EITHER end's inline properties or in the clause `WHERE`, and which end is
  // "keyed" decides which of those this rung may even accept.
  const picked = groupedAccs(ret.projection.items, proj.items, null, true);

  if (picked === null) {
    return null;
  }

  const { accs, keyExpr, keyCol } = picked;
  const onStart = keyExpr.variable === start.variable;

  if (!onStart && keyExpr.variable !== far.variable) {
    return null;
  }

  const keyed = onStart ? start : far;
  const other = onStart ? far : start;

  // The non-keyed end must be plain, exactly as in the tally: this walk applies nothing to it
  // beyond a far label.
  if (!plainNode(other)) {
    return null;
  }

  // Every aggregate argument must read the KEYED end only — it is the one node this walk binds.
  // `refsOnlyVar` is shallow by design, so a compound argument declines rather than being
  // analysed: this rung admits `max(b.k)`, not `max(b.k + c.k)`.
  for (const a of accs) {
    if (a.kind !== 'rows' && !refsOnlyVar(a.argExpr, keyExpr.variable)) {
      return null;
    }
  }

  const inKeyed = inlineOf(keyed);

  if (inKeyed === null) {
    return null;
  }

  const preds: InlinePred[] = [];

  if (inKeyed !== undefined) {
    preds.push(inKeyed);
  }

  const wherePred = keyedClausePred(m.where, keyed.variable);

  if (wherePred === null) {
    return null;
  }

  if (wherePred !== undefined) {
    preds.push(wherePred);
  }

  // THE SEED HAZARD, checked here rather than at the `groupedAccs` call because `preds` is what
  // answers it and `preds` needs the keyed end, which `groupedAccs` is what decides. A FILTERED
  // source may seed from an index in the general path, and then the values reach their group in
  // index order rather than scan order — item 553 demonstrated that on the scan rung with a
  // `collect` that read `[7,5,9]` without an index and `[5,7,9]` with one. This walk always
  // iterates the start side, so it cannot reproduce a seeded order and must decline.
  if (preds.length > 0 && accs.some((a) => a.kind === 'values')) {
    return null;
  }

  const gate = composeInlineGate(preds);
  const startLabel = start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const { key } = keyExpr;
  const keyVar = keyExpr.variable;
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

  const farLabel = far.label;
  const adjacency: Adjacency = {
    direction: rel.direction,
    ...(rel.label ? { label: rel.label } : {}),
  };

  const primed = groupedEndpointFold({
    onStart,
    accs,
    keyAt,
    items: ret.projection.items,
    keyExpr,
    rel,
    startLabel,
    farLabel,
    keyVar,
    key,
    keyCol,
    gate,
  });

  return (graph, params) => {
    const fast = primed?.(graph, params);

    // `[]` is a legitimate answer (a hop matching nothing), so this tests for null/undefined and
    // not for truthiness — and the sort is applied to whichever walk ran, so an ORDER BY query is
    // unaffected by which one that was.
    if (fast !== undefined && fast !== null) {
      return applySort(fast);
    }

    const slots: { readonly key: unknown; n: number; readonly state: unknown[] }[] = [];
    const bySeen = new Map<unknown, (typeof slots)[number]>();
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const farPb = vacuousLabel(graph, farLabel) ? undefined : farLabel;

    for (const v of candidateVertexSource(graph, startLabel)) {
      for (const step of expand(graph, v, adjacency)) {
        const { node } = step;

        if (farPb !== undefined && !matchesLabel(node, farPb)) {
          continue;
        }

        const keyedNode = onStart ? v : node;

        if (gate !== undefined && !gate(keyedNode, binding, params, graph)) {
          continue;
        }

        const raw = propOf(keyedNode, key);
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
        binding.set(keyVar, keyedNode);

        for (let i = 0; i < accs.length; i += 1) {
          const a = accs[i];

          if (a.kind === 'rows') {
            continue;
          }

          const value = a.argFn(env);

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
