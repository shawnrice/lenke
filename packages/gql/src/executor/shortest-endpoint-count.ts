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

import type { Clause, LabelExpr, PathPattern } from '../ast.js';
import { candidateVertices, matchesLabel } from '../graph-queries.js';
import type { Params, Row } from './core.js';
import { countStarColumn } from './shortcuts.js';

/** The pattern shapes this rung answers, with everything it needs pulled out. */
type Shape = {
  readonly startLabel: LabelExpr | undefined;
  readonly farLabel: LabelExpr | undefined;
  readonly type: string;
  readonly out: boolean;
  readonly min: number;
  readonly max: number;
};

/**
 * The pattern, if this rung can answer it — otherwise `undefined`.
 *
 * ⚠️ Each condition removes a case whose ANSWER would differ, not merely a case that is awkward:
 * a path variable or a non-`any` selector wants the paths themselves; `mode` other than the default
 * restricts which walks count, and a BFS over distinct endpoints cannot express that; an inline property constraint or node `WHERE` needs per-element evaluation this rung does not do; and a missing
 * quantifier is a plain hop, which already has its own rung.
 */
const shapeOf = (pattern: PathPattern): Shape | undefined => {
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
    pattern.start.properties !== undefined ||
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

  return {
    startLabel: pattern.start.label,
    farLabel: node.label,
    type: label.name,
    out: direction === 'out',
    min,
    max,
  };
};

/**
 * Endpoints reachable from `seed` at a distance in `[min, max]` that carry the far label.
 *
 * 🔑 A plain BFS over the typed adjacency bucket — the same read item 2149 gave the shortest-path walk,
 * for the same reason: nothing is allocated per edge. ⚠️ `seen` is keyed by vertex id and includes the
 * seed at distance 0, so a cycle back to the seed counts it as an endpoint exactly once (and only when
 * `min` admits the distance at which it closes).
 */
const reachableCount = (graph: Graph, seed: Vertex, shape: Shape): number => {
  const { type, out, min, max, farLabel } = shape;
  const dist = new Map<string, number>([[seed.id, 0]]);
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
        if (nbr.id === seed.id) {
          if (!seedCounted && depth >= min && matchesLabel(nbr, farLabel)) {
            count += 1;
            seedCounted = true;
          }

          continue;
        }

        if (dist.has(nbr.id)) {
          continue;
        }

        dist.set(nbr.id, depth);
        next.push(nbr);

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

  if (
    m?.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    m.where !== undefined ||
    ret?.kind !== 'return'
  ) {
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

  const shape = shapeOf(m.patterns[0]);

  if (shape === undefined) {
    return null;
  }

  return (graph: Graph): Row[] => {
    let total = 0;

    for (const seed of candidateVertices(graph, shape.startLabel)) {
      total += reachableCount(graph, seed, shape);
    }

    return [{ [column]: total }];
  };
};
