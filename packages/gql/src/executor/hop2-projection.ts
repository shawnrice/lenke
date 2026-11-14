import type { Graph, Vertex } from '@lenke/core';

import type { Clause, NodePattern, RelPattern } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import { distinctRows } from './clauses.js';
import type { CClause, CompiledExpr, CProjection, Params, Row } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import type { AlwaysRowsFn, RowsFn } from './hop-projection.js';
import { plainNode, plainRel } from './hop-sides.js';
import { effectiveLabel } from './labels.js';
import { outputColumnSorts, sortedRows } from './ordered-rows.js';
import { plainRowProjectionIgnoringDistinct, valueKey } from './rows.js';
import { projectRow } from './rows.js';
import { asTruth } from './scalars.js';
import { rowLocal } from './shortcuts.js';

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
 *   - anything but a plain row projection declines (`plainRowProjectionIgnoringDistinct`). ⚠️ SINCE
 *     ITEM 1822 `DISTINCT` IS THE EXCEPTION AND IS ADMITTED — see the dedupe at the return. No
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

  // ⚠️ `plainRowProjectionIgnoringDistinct` takes the AST projection and `aggregating` is on the
  // COMPILED one, so both are asked — of the right object each. They are not the same test: the
  // AST form rejects `GROUP BY`/`HAVING`/`ORDER BY`/`SKIP`/`LIMIT`/`*`, and `aggregating` is what
  // rejects `RETURN count(c.k)`, which is none of those.
  const { projection } = cret;

  if (
    !plainRowProjectionIgnoringDistinct(ret.projection) ||
    projection.aggregating ||
    projection.items.length === 0
  ) {
    return null;
  }

  const rows = walk(nodes, hops as readonly Hop[], projection, gate);

  /**
   * ⚠️ `RETURN DISTINCT` IS ADMITTED AND DEDUPED HERE — item 1822, closing the hole item 1821 left
   * and measured: TWO hops was the SLOWEST of the three widths, a shorter chain costing more than a
   * longer one. `hop-projection.ts`'s `distinctShape` refuses `segments.length > 1` and
   * `chain-projection.ts` requires three segments, so two fell between the two rungs and went to
   * the general matcher — `hop2distinct` 2171.3 ms against this walk's own `hop2rows` at 157.3,
   * a 13.8x gap for a dedupe that can only cost the walk plus a hash.
   *
   * ⚠️ THE ARGUMENT IS ITEM 1821'S AND IS NOT RE-DERIVED: dedupe keeps one row per key whatever
   * order the rows arrive in, so it COMMUTES with the walk and the answer is the same SET
   * (`order-is-unspecified`). `SKIP`/`LIMIT` do NOT commute — there, row order decides WHICH rows
   * survive — so they stay refused by the gate above. And it calls `distinctRows` rather than
   * keying rows itself, because there is ONE definition of distinct in this engine and items 1561
   * and 1562 each shipped a silent answer change in that area.
   */
  return ret.projection.distinct ? (graph, params) => distinctRows(rows(graph, params)) : rows;
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

/**
 * The aggregates these rungs may fold — item 1830, widening item 1824's `count(DISTINCT …)`.
 *
 * ⚠️⚠️ **AN ALLOWLIST BY NAME, AND THE REFUSALS ARE THE POINT.** `foldedAggs` carries a ready `fold`
 * and the compiled `argFn` for EVERY foldable aggregate, so folding any of them over the rung's rows
 * is mechanically identical — and would be a WRONG ANSWER for three of them, because the folds
 * differ in whether ROW ORDER changes their result:
 *
 * ```text
 *   min / max        order-INVARIANT over a total order        ADMITTED
 *   count(x)         order-invariant (a tally)                 ADMITTED
 *   count(DISTINCT)  order-invariant (a set)                   ADMITTED, item 1824
 *   sum / avg        order-SENSITIVE in the last ulp (f64)     REFUSED
 *   collect          its order IS its answer                   REFUSED
 * ```
 *
 * `foldFor`'s own comment states the last two. This engine's hard invariant is BYTE-IDENTITY with
 * the Rust engine, so admitting `sum` would make the two disagree in the last ulp wherever this
 * walk's order differs from the general path's — and whether it differs is the `forceStartDriven`
 * question items 419 and 551 settled FOR ONE HOP ONLY. It is not settled for these widths, so the
 * order-sensitive folds wait for someone to settle it rather than riding on the assumption.
 *
 * ⚠️⚠️ **THIS SET IS REDUNDANT TODAY, AND MUTATION SAID SO — it is kept as the guard against a
 * change someone is now MOTIVATED to make.** Two mutants SURVIVE: dropping the set entirely, and
 * adding `sum` to it. Both survive because `foldFor` itself only ever returns a fold for
 * `count`, `count(DISTINCT)`, `min` and `max` — verified by calling it: `sum`, `avg`, `collect` and
 * `stdev` are NOT FOLDABLE, so they never reach `foldedAggs` and cannot reach this rung however
 * this set is written.
 *
 * So what actually keeps them off today is `foldFor`'s switch, not this line. It is kept anyway
 * because `foldFor`'s comment declines to widen itself on the grounds that doing so "would be scope
 * without a number behind it" — and item 1829 has now PRODUCED that number (`sum` at 25-62 ms
 * against a ~6 ms `rows` cell). The next person to widen `foldFor` for speed would, without this
 * set, silently hand an order-sensitive fold to a walk whose order has never been proved equal to
 * the general path's. That is a wrong answer in the last ulp, invisible to every integer fixture.
 *
 * ⚠️ A NAME, NOT THE FOLD OBJECT: `extremumFold(wantMin)` builds a NEW object per call, so identity
 * works for the singleton `distinctCountFold` and silently fails for `min`/`max`. The aggregate's
 * own AST node carries the name, which is the thing actually being allowed.
 */
const ORDER_INVARIANT_AGGREGATES: ReadonlySet<string> = new Set(['min', 'max', 'count']);

/**
 * `MATCH (a)-[:T]->(b)-[:U]->(c) RETURN count(DISTINCT <expr over the far end>)` — item 1824.
 *
 * ⚠️ THIS EXISTS BECAUSE FIXING THE CHAIN WIDTHS CREATED A FRESH INVERSION, and the grid said so
 * immediately. `detectChainDistinctCount` took depths 3-5 from 35.6/46.8/56.7 ms to 7.7/7.8/8.3,
 * which left TWO hops at 29.5 — **3.8x the now-fixed depth 3** and 4.9x its own `rows` twin. That is
 * item 1822's situation repeating one modifier over: a fix applied at one width turns the unfixed
 * neighbour into the anomaly. Leaving it would have shipped an inversion introduced by the item
 * that was meant to remove one.
 *
 * Everything else about it is `detectChainDistinctCount`'s — the synthetic-projection trick, the
 * identity test that the item IS the aggregate, and above all the NULL RULE (`count(DISTINCT x)`
 * excludes nulls where `RETURN DISTINCT x` keeps them, so `distinctRows(rows).length` would be a
 * silent wrong answer). Read that function's header; it is not repeated here.
 */
export const detectHop2FoldedAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;
  const agg = proj.foldedAggs?.length === 1 ? proj.foldedAggs[0] : undefined;

  if (
    !proj.aggregating ||
    proj.items.length !== 1 ||
    agg === undefined ||
    !ORDER_INVARIANT_AGGREGATES.has(agg.expr.name) ||
    // `count(*)` has its own closed-form route and never reaches `foldedAggs`; a DISTINCT `min`/
    // `max` is not foldable at all (`foldFor` returns undefined), so it cannot arrive here either.
    agg.expr.star ||
    ret.projection.items.length !== 1 ||
    ret.projection.items[0].expr !== agg.expr
  ) {
    return null;
  }

  const outName = proj.items[0].name;
  const column = '__hop2DistinctCountArg';
  const synthetic: CProjection = {
    ...proj,
    aggregating: false,
    distinct: false,
    items: [{ name: column, fn: agg.argFn, isAgg: false }],
    foldedAggs: undefined,
    groupKeys: [],
  };
  const rows = detectHop2Projection(
    clauses,
    compiled.map((c, i) => (i === 1 && c.kind === 'return' ? { ...c, projection: synthetic } : c)),
  );

  if (rows === null) {
    return null;
  }

  return (graph, params) => {
    let acc = agg.fold.init();

    for (const row of rows(graph, params)) {
      const v = (row as Record<string, unknown>)[column];

      if (v !== null && v !== undefined) {
        acc = agg.fold.step(acc, v);
      }
    }

    return [{ [outName]: agg.fold.finish(acc) }];
  };
};

/**
 * A `RETURN` clause with its sort and window removed — item 1827.
 *
 * ⚠️ THE SORT IS STRIPPED FROM BOTH THE AST AND THE COMPILED CLAUSE. The ordered rung gates on the
 * AST projection (`plainRowProjectionIgnoringDistinct` refuses an `orderBy`) and builds rows from
 * the compiled one, so leaving either in place would make it decline the shape it is being handed.
 *
 * At MODULE SCOPE because it captures nothing: `consistent-function-scoping` is right that a
 * closure rebuilt per compile buys nothing, and `ts-closure-size-is-load-bearing` records that
 * closure shape in this package is not free.
 */
const withoutSortOrWindow = <T extends Clause | CClause>(c: T): T =>
  c.kind === 'return'
    ? {
        ...c,
        projection: { ...c.projection, orderBy: undefined, skip: undefined, limit: undefined },
      }
    : c;

/**
 * `MATCH <chain> RETURN <items> ORDER BY <output columns>` — item 1827 (two segments).
 *
 * ⚠️ THE LARGEST ROUTE GAP THIS FAMILY HAS PRODUCED, and it was invisible until two engines were
 * compared marginal-for-marginal (item 1826). GQL's `ORDER BY` marginal cost over its own `rows`
 * cell runs **1.3 → 46.5 → 53.2 → 75.3 → 88.6 ms** across depths 1-5, where Gremlin's `order()` is
 * **1.2 → 1.1 → 1.6 → 1.7 → 1.6** — flat. 1.1x at one hop and 42x at two, because
 * `hop-projection.ts` admits a sort (`outputColumnSorts`, item 607) and the deeper rungs refuse one.
 *
 * ⚠️ IT REUSES THE ENGINE'S OWN SORT, NOT A NEW ONE. `outputColumnSorts` decides which sorts are
 * admissible — every key must resolve to a `var` naming a projected OUTPUT COLUMN, which is
 * precisely what makes sorting the rung's rows equivalent to sorting the general path's — and
 * `sortedRows` is the existing wrapper that applies a `SortPlan` and passes a run-time `null`
 * THROUGH. Both already carry the analysis this route needs; re-deriving either would be the
 * "two copies of one shape rule" failure `detectDistinctCount`'s note records.
 *
 * ⚠️ A WINDOW DECLINES, AND THAT IS A SPEED GUARD, NOT A SAFETY ONE — I wrote the opposite first and
 * a mutant corrected me. Admitting a `SKIP`/`LIMIT` here is ANSWER-EQUIVALENT: the sort decides the
 * order, so sorting the rung's rows and then slicing gives exactly what the general path gives, and
 * the mutant that drops this check passes every answer test. What it would lose is the BOUNDED TOP-K:
 * `boundedTopRows` answers `ORDER BY … LIMIT n` from a heap, and `sortOf` records ~280x for a
 * materializing route where the general path is lazy. So this is `perf-gate-needs-its-own-test`'s
 * exact situation — a route choice no answer can distinguish — and the guard that catches it is the
 * ROUTE assertion in `routes-fired.test.ts`, not a value.
 */
export const detectHop2OrderedProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [, ret] = clauses;

  if (ret.kind !== 'return') {
    return null;
  }

  const { projection } = ret;

  // A window declines — see the header. Checked BEFORE `outputColumnSorts`, so none of its
  // window rules are relied on here.
  if (
    (projection.orderBy?.length ?? 0) === 0 ||
    projection.skip !== undefined ||
    projection.limit !== undefined
  ) {
    return null;
  }

  const cols = projection.items.map((item, i) => item.alias ?? `__col${i}`);
  const plan = outputColumnSorts(ret, cols);

  // `undefined` is "no sort" (impossible here, the orderBy is non-empty) and `null` is a DECLINE:
  // a key that does not name an output column cannot be answered by sorting the rung's rows.
  if (plan === undefined || plan === null) {
    return null;
  }

  const rows = detectHop2Projection(
    clauses.map((c, i) => (i === 1 ? withoutSortOrWindow(c) : c)),
    compiled.map((c, i) => (i === 1 ? withoutSortOrWindow(c) : c)),
  );

  return sortedRows(rows, plan);
};

/**
 * `MATCH <chain> RETURN <expr over the far end> AS k, count(*) AS c` — the GROUPED count, item 1832.
 *
 * ⚠️ THE FOURTH WIDTH GAP IN THIS FAMILY, and the only one `rung-gap-screen.mjs` flags in BOTH
 * engines. `detectGroupedHopCount` requires `segments.length === 1`, so a grouped count past one hop
 * fell to the general matcher: **30.0/38.3/50.9/61.1 ms at depths 2-5 against a ~6 ms `rows` cell**
 * (item 1829). Gremlin's `groupCount` degrades too, 14-22x, which is its own item.
 *
 * ⚠️ IT DOES NOT RE-DERIVE GROUPING SEMANTICS, which is the whole risk in a grouped shape.
 * `buildGroups`' own comment settles the single-key case: "ONE grouping key is the overwhelmingly
 * common shape, and for it the row key IS the value key — `valueKey` is already type-prefixed and
 * injective". So a tally keyed by `valueKey` groups exactly as the general path does, including the
 * cases that are easy to get wrong (a null key, `0` against `-0`, NaN keying equal to itself, an
 * element keyed by id). A second keying here would be the third silent answer change in this area
 * (items 1561, 1562).
 *
 * ⚠️ AND THE GROUP ORDER IS INSERTION ORDER OF FIRST OCCURRENCE, which matches the general path only
 * because item 1831 measured that these rungs emit rows in the general path's order — 25 cases, both
 * internal branches proved live by deletion, identical sequences. Without that measurement this
 * would be an assumption; with it, it is a known property with named residual risk. Group ORDER is
 * unspecified anyway (`order-is-unspecified`), so the fuzzers compare the set — but matching order
 * is what keeps the two engines byte-identical rather than merely both correct.
 *
 * ⚠️ `count(*)` ONLY, via `countedGroups`. That flag means every aggregate in the projection is
 * `count(*)`, so a group needs a COUNT and a representative rather than its bindings — which is
 * exactly what a tally produces. A grouped `sum`/`collect` is a different question and declines
 * here for item 1829's reason: those folds are order-sensitive and `foldFor` does not even make
 * them foldable.
 */
export const detectHop2GroupedCount = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  if (
    !proj.aggregating ||
    !proj.countedGroups ||
    proj.groupKeys.length !== 1 ||
    proj.items.length !== 2 ||
    !plainRowProjectionIgnoringDistinct(ret.projection) ||
    ret.projection.distinct
  ) {
    return null;
  }

  const keyItem = proj.items.find((i) => !i.isAgg);
  const aggItem = proj.items.find((i) => i.isAgg);

  if (keyItem === undefined || aggItem === undefined) {
    return null;
  }

  const synthetic: CProjection = {
    ...proj,
    aggregating: false,
    countedGroups: false,
    distinct: false,
    items: [keyItem],
    groupKeys: [],
    foldedAggs: undefined,
  };
  const rows = detectHop2Projection(
    clauses,
    compiled.map((c, i) => (i === 1 && c.kind === 'return' ? { ...c, projection: synthetic } : c)),
  );

  if (rows === null) {
    return null;
  }

  return (graph, params) => {
    // Insertion-ordered: a `Map` preserves first-insertion order, which is the general path's group
    // order given the row order item 1831 measured. The bucket holds the KEY VALUE as well as the
    // count, because `valueKey` is not reversible — `countedGroups` calls that the representative.
    const groups = new Map<string, { key: unknown; n: number }>();

    for (const row of rows(graph, params)) {
      const key = (row as Record<string, unknown>)[keyItem.name];
      const k = valueKey(key);
      const seen = groups.get(k);

      if (seen === undefined) {
        groups.set(k, { key, n: 1 });
      } else {
        seen.n += 1;
      }
    }

    const out: Row[] = [];

    for (const { key, n } of groups.values()) {
      out.push({ [keyItem.name]: key, [aggItem.name]: n });
    }

    return out;
  };
};
