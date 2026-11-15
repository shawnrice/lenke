import type { Graph, Vertex } from '@lenke/core';

import type { Clause, NodePattern, RelPattern } from '../ast.js';
import type { CClause, Params } from './core.js';
import { csrFor } from './csr-cache.js';
import type { AlwaysRowsFn } from './hop-projection.js';
import { plainNode, plainRel } from './hop-sides.js';
import { valueKey } from './rows.js';

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

export const detectChainFoldLevels = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    // ⚠️ NO CARRIED `WHERE`. The existing rung carries one; this reader does not, so a filtered
    // chain declines to it rather than being walked without its filter.
    m.where !== undefined ||
    ret.kind !== 'return' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  const [pattern] = m.patterns;

  // TWO OR MORE SEGMENTS. One hop has `hop-endpoint-extremum.ts` (item 1246) and is already fast.
  /*
   * ⚠️⚠️ **THE PATH MODE IS DELIBERATELY NOT CHECKED, and checking it was this rung's first bug —
   * it declined EVERY query.** The parser stamps `mode: 'trail'` and `selector: 'walk'` as DEFAULTS
   * on every pattern, so `mode !== undefined` is false for nothing at all.
   *
   * 🔑 AND THE RIGHT ANSWER IS NOT `mode === 'trail'` EITHER — mode is IRRELEVANT here, on two
   * independent pieces of evidence. `CLOSED.md` records that "the restrictors apply per REPETITION
   * of a quantifier … and a quantifier is declined by `plainRel`", which `levelOf` enforces; and the
   * engine's own `count(d.n)` over a default (`mode: trail`) 3-hop chain reads **625000 = 5000 × 5³
   * exactly**, which is the WALK count — so no edge- or vertex-distinctness rule is in play for a
   * non-quantified chain. Items 2007/2008 spent two items on the fact that mode DOES matter for a
   * quantified path; this is the other side of that line.
   *
   * ⚠️ THE SELECTOR IS CHECKED, with the `?? 'walk'` default `needsGeneralMatcher` uses: an
   * `ANY`/`ALL SHORTEST` selector changes which paths exist and the recurrence would answer over all
   * of them.
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
    const { u, order } = levelWalk(graph, levels, startLabelExpr?.name);
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
