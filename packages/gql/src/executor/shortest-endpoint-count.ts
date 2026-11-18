/**
 * `MATCH ANY SHORTEST (a:L)-[:T]->{m,n}(b:L2) RETURN count(*)` — counted from the BFS's own distance
 * map, with no row materialized (item 2151).
 *
 * ⚠️⚠️ **THE SEMANTICS WERE SETTLED BY MEASUREMENT, AND THEY ARE WHY THE EXISTING RUNG CANNOT SERVE
 * THIS.** On a diamond (`a→b→d`, `a→c→d`) at `{1,2}`:
 *
 * ```text
 *     ANY SHORTEST      3     one path per endpoint — b, c, d
 *     default `walk`    4     counts PATHS: a→b, a→c, a→b→d, a→c→d
 *     ALL SHORTEST      4     d has TWO equally-short paths
 * ```
 *
 * 🔑 Three different answers, so `detectReachableShortcut` declining a selector is CORRECT, not a defect
 * (item 2150 nearly concluded otherwise). What `ANY SHORTEST`'s `count(*)` wants is **the size of the
 * reachable set**, which is exactly what a BFS's `dist` map holds once it has run.
 *
 * ⚠️⚠️ **BARE `ANY` IS NOT ADMITTED, AND I FIRST THOUGHT IT WAS.** I reasoned that `'any'` keeps one
 * arbitrary path per endpoint so its COUNT must match `'anyShortest'`'s. ⚠️ It does not: `ast.ts` says
 * `'any'` keeps one path **per endpoint** while `'anyShortest'` keeps one **per endpoint PAIR**, so bare
 * `ANY` dedups ACROSS starts and counts fewer. An existing test (`a vacuous {1,1} quantifier`) caught it
 * on the first run — `MATCH ANY (x)-[:T]->{1,1}(y) RETURN count(*)` is 3, not the per-pair total.
 *
 * ### ⚠️ Why this is worth a rung at all
 *
 * A windowed profile of the general matcher on this shape put `withBinding` at **34.4% self** and the BFS
 * itself — `shortestWalk` — at only **6.9%**: the walk is cheap and materializing a row per endpoint costs
 * five times it. The no-`WHERE` form, which seeds from the whole label, measured **226.92 ms** at 200,000
 * vertices.
 */
import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr, LabelExpr, PathPattern } from '../ast.js';
import { candidateVertices, matchesLabel } from '../graph-queries.js';
import type { Params, Row } from './core.js';
import type { InlinePred } from './inline-gate.js';
import { inlineHolds } from './inline-gate.js';
import { chainGatesOf, countStarColumn, gateWith } from './shortcuts.js';

/** The pattern shapes this rung answers, with everything it needs pulled out. */
type Shape = {
  readonly startLabel: LabelExpr | undefined;
  /** The clause `WHERE`'s conjuncts on the START variable, as one predicate — item 2152. */
  readonly startPred: InlinePred | undefined;
  readonly farLabel: LabelExpr | undefined;
  readonly type: string;
  readonly out: boolean;
  readonly min: number;
  readonly max: number;
};

/**
 * The pattern, if this rung can answer it — otherwise `undefined`.
 *
 * ⚠️⚠️ **THE START'S INLINE PROPERTIES ARE ADMITTED, AND REFUSING THEM OPENED A SPELLING GAP I HAD TO
 * CLOSE IN THE SAME ITEM.** `(a:P {k: 1})` means exactly `WHERE a.k = 1`, and with only the clause form
 * admitted the two measured **8.24 ms against 27.52 — 3.3x apart for one question**, which is the defect
 * class this repo is organised around. 🔑 `gateWith` folds a node's own inline properties together with
 * the clause conjuncts, so admitting them is one condition removed, not new code.
 *
 * ⚠️ The FAR node's inline properties stay refused, for a real reason: they would have to be evaluated
 * per discovered endpoint, and whether that is still a win is a separate measurement.
 *
 * ⚠️ Each remaining condition removes a case whose ANSWER would differ, not merely a case that is awkward:
 * a path variable or a non-`any` selector wants the paths themselves; `mode` other than the default
 * restricts which walks count, and a BFS over distinct endpoints cannot express that; an inline property constraint or node `WHERE` needs per-element evaluation this rung does not do; and a missing
 * quantifier is a plain hop, which already has its own rung.
 */
const shapeOf = (pattern: PathPattern, clauseWhere: Expr | undefined): Shape | undefined => {
  if (
    pattern.pathVar !== undefined ||
    pattern.segments.length !== 1 ||
    pattern.selector !== 'anyShortest' ||
    (pattern.mode !== undefined && pattern.mode !== 'trail')
  ) {
    return undefined;
  }

  const [seg] = pattern.segments;
  const { rel, node } = seg;
  const { quantifier, label, direction, properties, where, variable } = rel;

  if (
    quantifier === undefined ||
    label?.kind !== 'label' ||
    (direction !== 'out' && direction !== 'in') ||
    properties !== undefined ||
    where !== undefined ||
    variable !== undefined ||
    node.properties !== undefined ||
    node.where !== undefined ||
    pattern.start.where !== undefined
  ) {
    return undefined;
  }

  const { min, max } = quantifier;

  /*
   * ⚠️ AN UNBOUNDED `max` IS REFUSED — spelled `null` here, not `undefined`. `{1,}` reaches the whole component and the general matcher's trail
   * budget is what currently bounds it — a rung that ignored that would answer a DIFFERENT number on a
   * large graph, which is the worst kind of difference because it only shows up at scale.
   */
  /*
   * ⚠️ `max === null` IS REDUNDANT WITH `max < min`, by coercion: `{1,}` parses to `{min: 1, max: null}`
   * and `null < 1` is `0 < 1`. Mutation says so — removing it alone changes no answer, while removing
   * the whole condition is caught. 🔑 Kept because it states the intent, and because relying on a
   * null-to-zero coercion to reject an unbounded walk is not something a reader should have to notice.
   */
  if (max === undefined || max === null || min < 1 || max < min) {
    return undefined;
  }

  /*
   * ITEM-2152-START-GATE: the clause `WHERE`, admitted when it constrains ONLY the start variable.
   *
   * 🔑 `chainGatesOf` splits the `WHERE`'s AND conjuncts by the variable each one constrains, and
   * returns `null` when it cannot attribute them all. ⚠️ A conjunct on the FAR variable is REFUSED here
   * rather than applied: this rung counts endpoints as the BFS discovers them, so a far-side predicate
   * would have to run per endpoint, and whether that is still a win is a separate measurement.
   */
  const startVar = pattern.start.variable;
  const gates =
    clauseWhere === undefined
      ? undefined
      : chainGatesOf(clauseWhere, pattern.start, pattern.segments);

  if (gates === null) {
    return undefined;
  }

  if (
    gates !== undefined &&
    (startVar === undefined || [...gates.keys()].some((k) => k !== startVar))
  ) {
    return undefined;
  }

  const startPred = gateWith(
    pattern.start,
    startVar === undefined ? undefined : gates?.get(startVar),
  );

  /* ⚠️ `gateWith` returns `null` for a predicate it cannot express, which is NOT `undefined`. */
  if (startPred === null) {
    return undefined;
  }

  return {
    startLabel: pattern.start.label,
    startPred,
    farLabel: node.label,
    type: label.name,
    out: direction === 'out',
    min,
    max,
  };
};

/**
 * Whether the far label cannot reject any vertex, so the per-endpoint test is pure overhead.
 *
 * ⚠️ TRUE only for an ABSENT label or a single `label` kind that every vertex carries. 🔑 A composite
 * label expression (`:A&B`, `:A|B`) is NOT read here — `matchesLabel` owns that logic, and duplicating
 * it to save a call is how a vacuity check becomes a WRONG ANSWER.
 *
 * ⚠️ `far.kind === 'label'` is REDUNDANT BY THE TYPE'S SHAPE, and mutation says so: only that variant
 * carries a `name`, so for any other one `far.name` is `undefined`, the lookup misses and the test
 * declines regardless. 🔑 Kept because reading it as "every composite happens to miss a `Map` lookup" is
 * not how a reader should have to establish that `:A&B` is handled.
 *
 * ⚠️ A `wildcard` (`kind: 'wildcard'`) is deliberately NOT claimed vacuous: whether `:%` means "any
 * label" or "has at least one label" decides it, and a vertex with no labels at all distinguishes them.
 * That is an ISO question, not a guess to make here.
 */
const farLabelIsVacuous = (graph: Graph, far: LabelExpr | undefined): boolean => {
  if (far === undefined) {
    return true;
  }

  return far.kind === 'label' && graph.verticesByLabel.get(far.name)?.size === graph.vertexCount;
};

/**
 * Endpoints reachable from `seed` at a distance in `[min, max]` that carry the far label.
 *
 * 🔑 A plain BFS over the typed adjacency bucket — the same read item 2149 gave the shortest-path walk,
 * for the same reason: nothing is allocated per edge. ⚠️ `seen` is keyed by vertex id and includes the
 * seed at distance 0, so a cycle back to the seed counts it as an endpoint exactly once (and only when
 * `min` admits the distance at which it closes).
 */
const reachableCount = (
  graph: Graph,
  seed: Vertex,
  shape: Shape,
  farLabel: LabelExpr | undefined,
): number => {
  const { type, out, min, max } = shape;
  /*
   * ITEM-2154-IDENTITY-SEEN: a `Set<Vertex>`, not a `Map<string, number>` keyed on `v.id`.
   *
   * 🔑 TWO SEPARATE SAVINGS, and the second is why a `Map` was the wrong shape from the start:
   *
   *   - **the key.** `dist.has(nbr.id)` / `dist.set(nbr.id, …)` cost an `id` GETTER plus a string hash,
   *     twice per edge. After item 2153 removed the label test, `reachableCount` was **80.3% self** with
   *     `get id` 2.6% and `get to` 3.7% beside it, so the keying was the loop's remaining bulk.
   *   - **the value.** The distance was never READ — the frontier already carries the depth. A `Map`
   *     stored a number per vertex that nothing consulted.
   *
   * ⚠️⚠️ **IDENTITY KEYING IS ONLY SOUND BECAUSE VERTEX IDENTITY IS STABLE HERE, AND THAT WAS CHECKED,
   * NOT ASSUMED**: `edge.to`, `getVertexById` and the `addVertex` return are all the same object for one
   * vertex. A graph that handed back a fresh wrapper per access would make this a WRONG ANSWER, not a
   * slow path. ⚠️ Item 1589 refuted identity keying for a GREMLIN dedup set, which is a different call
   * site — the claim there was that the fast side keeps no dedup set at all, and a BFS must.
   */
  const seen = new Set<Vertex>();
  let frontier: Vertex[] = [seed];
  let depth = 0;
  let count = 0;
  let seedCounted = false;

  while (frontier.length > 0 && depth < max) {
    const next: Vertex[] = [];

    depth += 1;

    for (const v of frontier) {
      const bucket = (out ? v.adjFrom : v.adjTo)?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        const nbr = out ? edge.to : edge.from;

        /*
         * ⚠️⚠️ **THE SEED IS A LEGITIMATE ENDPOINT WHEN A PATH RETURNS TO IT, AND I GOT THIS WRONG.**
         * `dist` holds the seed at distance 0 so it reads as already-visited, which silently dropped
         * `(a, a)` for a self-loop: a WRONG ANSWER, not a slow one. An existing test caught it on the
         * first run (`a non-walk SELECTOR is NOT rewritten`, whose fixture has `a→a`), and it is the same
         * `seedCycle` bookkeeping `shortestWalk` carries for the same reason.
         *
         * 🔑 Counted at most ONCE and never re-expanded: `anyShortest` keeps one path per endpoint pair,
         * so the FIRST distance at which the cycle closes is the only one that contributes.
         */
        if (nbr === seed) {
          if (!seedCounted && depth >= min && matchesLabel(nbr, farLabel)) {
            count += 1;
            seedCounted = true;
          }

          continue;
        }

        if (seen.has(nbr)) {
          continue;
        }

        seen.add(nbr);
        next.push(nbr);

        /*
         * ITEM-2153-VACUOUS-FAR-LABEL: the label test ELIDED when it cannot reject anything.
         *
         * 🔑 `get soleLabel` was **13.1% self** in a windowed profile of this rung at depth 2 — the test
         * runs once per DISCOVERED ENDPOINT, and on a single-label graph every one of them passes. ⚠️ At
         * 200,000 scattered candidates item 1599 measured the test at 14.52 ns against 7.56 because the
         * read is a CACHE MISS, which is the regime a BFS over scattered neighbours is in.
         *
         * ⚠️ Item 1599 refuted two ways of making the test CHEAPER; this is the third mechanism its own
         * item-1623 narrowing names as separate, which took 1.17x in the generic matcher.
         *
         * ⚠️⚠️ **THE ELISION IS SPELT AS `farLabel = undefined`, NOT AS A `vacuous ||` GUARD HERE, AND
         * THE FIRST SPELLING COST THE REALISTIC CASE 8%.** A per-endpoint `vacuous ||` reads 1.13-1.33x
         * on an all-one-label graph and **0.92x on a MIXED one** (130.8 ms → 140.8), where the extra
         * boolean always falls through — and `label-vacuity-gates-fast-paths` records that MIXED is the
         * realistic schema, so that version was a reject. 🔑 `matchesLabel(v, undefined)` returns `true`
         * on its FIRST line without touching `soleLabel`, so resolving the label once per CALL buys the
         * same saving and adds nothing to the path that still needs the test.
         */
        if (depth >= min && matchesLabel(nbr, farLabel)) {
          count += 1;
        }
      }
    }

    frontier = next;
  }

  return count;
};

/**
 * The rung, or `null` when the shape is not one it answers.
 *
 * ⚠️ `graph` is read at RUN time, never at compile time: the detector sees only the AST, so the same
 * compiled closure serves a graph that has since been written to.
 */
export const detectShortestEndpointCount = (
  clauses: readonly Clause[],
): ((graph: Graph, params: Params) => Row[] | undefined) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;

  if (m?.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return null;
  }

  const column = countStarColumn(ret.projection);
  const { projection } = ret;

  if (
    column === null ||
    (projection.orderBy ?? []).length > 0 ||
    projection.skip !== undefined ||
    projection.limit !== undefined ||
    projection.groupBy !== undefined ||
    projection.having !== undefined ||
    projection.distinct
  ) {
    return null;
  }

  const shape = shapeOf(m.patterns[0], m.where);

  if (shape === undefined) {
    return null;
  }

  return (graph: Graph, params: Params): Row[] => {
    /* ⚠️ ONE binding, reused across every seed — `inlineHolds` writes the element into it and reads it. */
    const binding = new Map<string, unknown>();
    /*
     * 🔑 COMPUTED ONCE PER CALL, not per endpoint and not at compile time: a write can add a vertex
     * without the label, and the same closure serves the graph afterwards.
     */
    const farLabel = farLabelIsVacuous(graph, shape.farLabel) ? undefined : shape.farLabel;
    let total = 0;

    for (const seed of candidateVertices(graph, shape.startLabel)) {
      if (!inlineHolds(shape.startPred, seed, binding, params, graph)) {
        continue;
      }

      total += reachableCount(graph, seed, shape, farLabel);
    }

    return [{ [column]: total }];
  };
};
