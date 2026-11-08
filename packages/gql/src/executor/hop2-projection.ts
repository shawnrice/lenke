import type { Graph, Vertex } from '@lenke/core';

import type { Clause, NodePattern, RelPattern } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import type { CClause, CompiledExpr, CProjection, Params, Row } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import { plainRowProjection } from './hop-projection.js';
import type { AlwaysRowsFn } from './hop-projection.js';
import { plainNode, plainRel } from './hop-sides.js';
import { projectRow } from './rows.js';
import { asTruth } from './scalars.js';
import { effectiveLabel, rowLocal } from './shortcuts.js';

/**
 * `MATCH (a:A)-[:T]->(b:B)-[:U]->(c:C) RETURN <items>` — a TWO-SEGMENT pattern returning ROWS,
 * answered by one nested walk instead of the generic matcher (item 1619).
 *
 * ⚠️ FOUND BY `gql-cliff-finder.ts`, built one tick earlier, and it is the biggest hole that
 * instrument has named. The shape is ONE SEGMENT away from `detectHopProjection`'s and had no rung
 * at all:
 *
 * ```text
 *    MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k                  65.3 ns/row   hopProjection
 *    MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k     638.3          PIPELINE
 *    the same two-hop COUNT                                  closed form, 1.16 ms
 * ```
 *
 * The blind spot is the one items 1614/1615 found in the GREMLIN engine, for the same reason: every
 * two-hop shape in the profile corpus and in `bench.ts` returns a COUNT, which `countShortcut`
 * answers from degrees without walking, so the two-hop ROW-returning walk had never been profiled
 * in either engine. The profile of it is the generic matcher rather than extra work — `expand`
 * 28.5%, `walkSegments` 11.3%, `evalLabelExpr` 9.3%, `withBinding` 8.5% — where the ONE-hop shape's
 * top engine frame is `farDrivenHopWalk`.
 *
 * Priced against hand floors BEFORE anything was built (item 1465's rule), at 20,000 x 4:
 *
 * ```text
 *    ENGINE  2 hop rows (the PIPELINE)      204.24 ms   319972 rows   638.3 ns/row
 *    HAND    2 hop, scalar  (walk only)      19.86                     62.1
 *    HAND    2 hop, {k: v}  (rows)           26.69                     83.4   <- THE FLOOR, 7.65x
 *    HAND    2 hop, template copy            34.85                    108.9
 * ```
 *
 * ⚠️ AND AN OBJECT LITERAL BEATS TEMPLATE-AND-COPY BY 1.31x AT ONE ALIAS, which is worth recording
 * because `farDrivenHopWalk`'s header recommends the template trick. That trick amortizes over a
 * vertex's whole BUCKET (item 167) and pays for itself at width; at one alias per row the spread
 * copy is pure cost. This walk therefore goes through `projectRow`, which allocates a fresh `Row`
 * per call — the same choice the one-hop walk makes for its non-template arms.
 *
 * ⚠️ A SEPARATE MODULE, NOT A RELAXED GATE IN `hop-projection.ts`. That file is 5591 lines of
 * individually-measured arms whose shapes are pinned to `pattern.segments.length === 1`, and its own
 * header records item 1527 refusing to fork its four walks. The Gremlin side set the precedent
 * twice: `start-filtered-hop-values.ts` and `hop-chain-values.ts` are both separate modules for
 * exactly this reason, with items 1441/1466 measuring an edit to the shared file at up to 16% on
 * UNRELATED rows in an arbitrary direction.
 *
 * ⚠️ THE SCOPE IS NARROW ON PURPOSE, and what it declines simply stays where it already is:
 *
 *   - ~~a clause `WHERE` DECLINES~~ — **CARRIED since item 1620**, evaluated at the DEEPEST level so
 *     the evaluation point is identical to the general matcher's. Pushing a start-only conjunct up
 *     to the outer loop is a separate item: it changes WHEN the predicate runs, which `carriedWhere`
 *     records as a raise-parity question pinned by five tests (items 139-145).
 *   - `both` on either segment declines: its contract visits a self-loop from both ends.
 *   - a quantifier, inline node or rel properties, an inline `WHERE`, a path variable, a path mode
 *     or selector, and a named relationship MENTIONED anywhere all decline.
 *   - anything but a PLAIN row projection declines (`plainRowProjection`): no `DISTINCT`, no
 *     `GROUP BY`, no `HAVING`, no `ORDER BY`, no `SKIP`/`LIMIT`, no `*`, no aggregate.
 *
 * ROW ORDER IS UNSPECIFIED without an `ORDER BY` (item 198), so a start-driven nested walk is free
 * to emit in its own order — unlike the Gremlin twin, where stream order is a TinkerPop contract.
 * The walk is start-driven anyway, because that is the order the general matcher produces and
 * matching it keeps the two comparable by eye when a test disagrees.
 */
export const detectHop2Projection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cm.kind !== 'match' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  const [pattern] = m.patterns;

  /**
   * A path variable has to build a `Path` per row.
   *
   * ⚠️ THE PATH MODE IS NOT CHECKED, AND I WROTE THE CHECK FIRST AND IT REJECTED EVERYTHING. `mode`
   * defaults to `'trail'` and `selector` to `'walk'` — neither is ever `undefined` — so
   * `mode !== undefined` declined every query, which `routes-fired.test.ts` caught immediately.
   *
   * Having found that, the question is whether TRAIL is load-bearing across two SEGMENTS: it forbids
   * reusing an edge, and a self-loop lets a two-segment pattern traverse the same edge twice. It is
   * NOT, and that is measured rather than reasoned — on a fixture with a self-loop at `a` plus
   * `a->b`, all four of the default, `WALK`, `TRAIL` and `ACYCLIC` answer the SAME two rows,
   * including `{a, a, a}`, which reuses the loop edge. The restrictors are applied per REPETITION of
   * a quantifier, exactly as `detectHopProjection`'s own comment states, and a quantifier is
   * declined by `plainRel`. `detectHopProjection` checks neither field for the same reason.
   *
   * ⚠️ AND THE `pathVar` CHECK IS MUTUALLY REDUNDANT WITH THE FREE-VARIABLE TEST BELOW. Each mutant
   * SURVIVES alone and dropping BOTH is caught: a READ path variable (`RETURN nodes(p)`) declines on
   * the free-var test because `p` is not a node variable, and an unbound name can only reach the
   * projection through a path variable in the first place. Both stay — the pair is the guard, and
   * item 475's rule is that a survivor means "redundant" as readily as "untested". The free-var test
   * also only looks at the RETURN items, so the `pathVar` check is the half that would still hold if
   * a future relaxation let a clause `WHERE` ride this rung.
   */
  if (pattern.pathVar !== undefined || pattern.segments.length !== 2) {
    return null;
  }

  const [s0, s1] = pattern.segments;
  const nodes = [pattern.start, s0.node, s1.node];

  // Every node plain (no inline properties, no inline `WHERE`) — `plainNode` is `shortcuts.ts`'s,
  // asked rather than restated.
  if (!nodes.every((n: NodePattern) => plainNode(n))) {
    return null;
  }

  const hops = [hopOf(s0.rel), hopOf(s1.rel)];

  if (hops[0] === null || hops[1] === null) {
    return null;
  }

  /**
   * THE THREE NODE VARIABLES, and every projected item must read only these.
   *
   * ⚠️ `freePredicateVars` IS THE PRIMITIVE `projectedEndsOnly` USES, so this is the same admission
   * rule at a different arity rather than a second derivation — that function answers a THREE-WAY
   * split (start / rel / far) its callers need and this walk does not. What must NOT differ is which
   * names count as free, and that comes from the shared walk.
   *
   * An UNNAMED node is admitted: nothing can read it, so it constrains the walk by label only.
   */
  const named = new Set<string>();

  for (const n of nodes) {
    if (n.variable !== undefined) {
      named.add(n.variable);
    }
  }

  // ⚠️ THE AST ITEMS, not the compiled ones: a `CReturnItem` carries a compiled `fn`, not an `expr`,
  // and `freePredicateVars` walks the AST. `projectedEndsOnly`'s signature admits both shapes and is
  // called with the AST form for exactly this reason; passing the compiled items threw inside the
  // walk rather than declining, which `routes-fired.test.ts` surfaced as 57 failures.
  for (const item of ret.projection.items) {
    for (const name of freePredicateVars(item.expr)) {
      if (!named.has(name)) {
        return null;
      }
    }
  }

  /**
   * ⚠️ A CLAUSE `WHERE` IS CARRIED (item 1620), and it is evaluated AT THE DEEPEST LEVEL — once per
   * complete match, exactly where the general matcher evaluates it.
   *
   * THAT PLACEMENT IS THE WHOLE CARE HERE. Pushing a start-only predicate up to the outer loop is
   * the obvious optimization and it is NOT answer-equivalent: the general path evaluates a clause
   * `WHERE` once per COMPLETE match, so a start that yields no row must never evaluate it, and a
   * predicate that FAULTS would then raise where it previously did not. `carriedWhere`'s own note
   * records that parity (items 139-145 pinned it with five tests) and routes an invariant predicate
   * specifically to the walk that carries it. Taking the push-down means redoing that analysis, so
   * it is a separate item with its own number; this one keeps the evaluation point identical and
   * takes the WALK, which is where the measured 4.5x sits.
   *
   * `rowLocal` is still required, for item 175's reason: a zero-variable predicate can still hold a
   * faulting uncorrelated subquery, and nothing here orders conjuncts to keep one away from it.
   */
  const { where } = m;

  if (where !== undefined) {
    if (!rowLocal(where)) {
      return null;
    }

    const vars = freePredicateVars(where);

    /**
     * ⚠️ REDUNDANT, and the mutant proves it rather than the reasoning doing so: in a two-clause
     * query a clause `WHERE` has nothing to read but the pattern's own names, a parameter (not a
     * free variable), or a path variable — and a path variable is refused above. Kept as the pair to
     * the projection's identical loop, so a reader sees the same rule applied to both halves of the
     * clause, and because a later relaxation of either guard would make this one load-bearing.
     */
    for (const name of vars) {
      if (!named.has(name)) {
        return null;
      }
    }

    /**
     * ⚠️ A `WHERE` THAT READS THE START VARIABLE DECLINES, AND THAT IS A MEASURED REFUSAL rather
     * than a conservative one. I admitted it first and it was a **3.7x REGRESSION**: the general
     * matcher rejects a start BEFORE expanding it, so a start-anchored predicate costs it one test
     * per VERTEX, where this walk evaluates at the deepest level and pays one per ROW.
     *
     * ```text
     *    WHERE a.k = 5   (start-only)    4.825 ms general  ->  17.895 admitted   3.71x WORSE
     *    WHERE b.k = 5   (middle)      161.205           ->  22.980             7.02x better
     *    WHERE c.k = 5   (far)         165.432           ->  26.321             6.28x better
     *    WHERE true      (invariant)   209.829           ->  36.575             5.74x better
     * ```
     *
     * So the refusal is exactly `carriedWhere`'s own point — *"a start-only predicate ... gets its
     * own closure, which applies it PER START VERTEX instead of per row — the whole point of
     * carrying it"* — reached here from the opposite direction, by shipping the naive placement into
     * a measurement. Taking it means PUSHING the predicate to the outer loop, which changes WHEN it
     * is evaluated and reopens the raise-parity question items 139-145 pinned with five tests. That
     * is a separate item with its own number; declining leaves the shape exactly where it already
     * was, at 4.8 ms.
     *
     * ⚠️ IT IS THE START VARIABLE, NOT "START-ONLY". A predicate reading `a` AND `c` would still
     * lose the matcher's early start rejection, so the test is membership rather than exclusivity —
     * and that also declines the lifted form of an inline `{…}` on the start node, which is the same
     * predicate by another spelling.
     */
    const startVar = nodes[0].variable;

    if (startVar !== undefined && vars.has(startVar)) {
      return null;
    }
  }

  const gate = cm.where;

  /**
   * A `WHERE` in the AST and no compiled gate (or the reverse) would silently DROP or INVENT a
   * filter, so the two are required to agree rather than assumed to.
   *
   * ⚠️ UNREACHABLE TODAY — the mutant SURVIVED, because `compileMatch` compiles a clause `WHERE`
   * exactly when there is one. It is defence in depth against a compiler change that stops doing so
   * for some shape: the failure mode is a filter silently not applied, which is a wrong ANSWER, and
   * this rung reads the AST and the compiled form from two different places. One test per query.
   */
  if ((where === undefined) !== (gate === undefined)) {
    return null;
  }

  // ⚠️ `plainRowProjection` takes the AST projection and `aggregating` is on the COMPILED one, so
  // both are asked — of the right object each. They are not the same test: the AST form rejects
  // `DISTINCT`/`GROUP BY`/`HAVING`/`ORDER BY`/`SKIP`/`LIMIT`/`*`, and `aggregating` is what rejects
  // `RETURN count(c.k)`, which is none of those.
  const { projection } = cret;

  if (
    !plainRowProjection(ret.projection) ||
    projection.aggregating ||
    projection.items.length === 0
  ) {
    return null;
  }

  return walk(nodes, hops as readonly Hop[], projection, gate);
};

type Hop = { readonly type: string; readonly forward: boolean };

/**
 * One named edge type in one direction, with nothing else on the relationship.
 *
 * `both` is refused by the direction test: its contract visits a self-loop from both ends, so a
 * nested pair of them is four interleaved orders. A relationship VARIABLE is refused outright here
 * rather than admitted-if-unmentioned — `detectHopProjection` admits that case and its own comment
 * records the subquery-correlation hole that cost (item 444's "defensive, not load-bearing" guard
 * turning out to be load-bearing for a reason its comment got wrong). This module has no need of
 * the relaxation, so it does not take on the risk.
 */
const hopOf = (rel: RelPattern): Hop | null => {
  if (!plainRel(rel) || rel.variable !== undefined) {
    return null;
  }

  if (rel.direction !== 'out' && rel.direction !== 'in') {
    return null;
  }

  return rel.label?.kind === 'label'
    ? { type: rel.label.name, forward: rel.direction === 'out' }
    : null;
};

/**
 * The nested walk. ONE `Binding` allocated per call and mutated per row — the reuse every walk in
 * `hop-projection.ts` makes, and `projectRow`'s own header states it never retains the binding.
 *
 * ⚠️ THE LABEL TESTS ARE HOISTED PER CALL, and `effectiveLabel` drops a label carried by EVERY
 * vertex (items 1551/1552/1609). That matters more here than anywhere: a two-hop walk tests THREE
 * labels per row, and item 1609 measured the elision per-ELEMENT costing a control 1.32x — so it
 * is resolved once per execution, not per element and not per compile.
 */
const walk = (
  nodes: readonly NodePattern[],
  hops: readonly Hop[],
  projection: CProjection,
  gate: CompiledExpr | undefined,
): AlwaysRowsFn => {
  const [n0, n1, n2] = nodes;
  const [h0, h1] = hops;
  const v0 = n0.variable;
  const v1 = n1.variable;
  const v2 = n2.variable;

  return (graph: Graph, params: Params): Row[] => {
    const l0 = effectiveLabel(graph, n0.label);
    const l1 = effectiveLabel(graph, n1.label);
    const l2 = effectiveLabel(graph, n2.label);
    const binding = new Map<string, unknown>();
    const out: Row[] = [];

    for (const a of graph.vertices) {
      if (!matchesLabel(a, l0)) {
        continue;
      }

      const b0 = (h0.forward ? a.adjFrom : a.adjTo)?.get(h0.type);

      if (b0 === undefined) {
        continue;
      }

      if (v0 !== undefined) {
        binding.set(v0, a);
      }

      for (const e0 of b0) {
        const b: Vertex = h0.forward ? e0.to : e0.from;

        if (!matchesLabel(b, l1)) {
          continue;
        }

        const b1 = (h1.forward ? b.adjFrom : b.adjTo)?.get(h1.type);

        if (b1 === undefined) {
          continue;
        }

        if (v1 !== undefined) {
          binding.set(v1, b);
        }

        for (const e1 of b1) {
          const c: Vertex = h1.forward ? e1.to : e1.from;

          if (!matchesLabel(c, l2)) {
            continue;
          }

          if (v2 !== undefined) {
            binding.set(v2, c);
          }

          /**
           * ⚠️ THE GATE RUNS BEFORE `projectRow`, and `asTruth(...) !== true` is the test rather
           * than a falsy check: a clause `WHERE` keeps only rows whose predicate is definitely
           * TRUE, so UNKNOWN (a null comparison) must be dropped like FALSE. `filters.ts`'s own
           * rule, and the reason the comparison is to `true` and not to `false`.
           *
           * The `{ binding, params, graph }` object is rebuilt per row, which item 833 priced at
           * 5.6 ns — real but not worth hoisting here, because the binding it names is the one
           * being mutated and a hoisted env would alias it. `projectRow` builds the same object
           * one line later for the same reason.
           */
          if (gate !== undefined && asTruth(gate({ binding, params, graph })) !== true) {
            continue;
          }

          out.push(projectRow(projection, binding, params, graph));
        }
      }
    }

    return out;
  };
};
