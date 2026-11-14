import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr, LabelExpr, NodePattern, RelPattern } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import type { OneColumnKeys } from './clauses.js';
import { addOneColumnKey, distinctRows, newOneColumnKeys } from './clauses.js';
import type { CClause, CompiledExpr, CProjection, EvalEnv, Params, Row } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import type { AlwaysRowsFn, RowsFn } from './hop-projection.js';
import { plainNode, plainRel } from './hop-sides.js';
import { effectiveLabel } from './labels.js';
import { outputColumnSorts, sortedRows } from './ordered-rows.js';
import { plainRowProjectionIgnoringDistinct, projectRow, valueKey } from './rows.js';
import { asTruth } from './scalars.js';
import { rowLocal } from './shortcuts.js';

/**
 * `MATCH (a:A)-[:T]->(b:B)-[:U]->(c:C)-[:V]->(d:D) RETURN <items>` — a chain of THREE OR MORE
 * segments returning ROWS, answered by one level walk instead of the generic matcher (item 1814).
 *
 * This is `hop2-projection.ts` at arbitrary depth, and it is that module's shape rule, admission
 * tests and evaluation points verbatim — only the two nested loops become a recursive descent. Read
 * that file's header first; every ⚠️ in it applies here and is not repeated.
 *
 * ⚠️ THE GAP IT CLOSES WAS MEASURED BEFORE IT WAS BUILT, and the instructive part is that the TWO
 * hop shape has had a rung since item 1619 while the three-hop twin fell to the general matcher, so
 * the cliff is between two adjacent shapes rather than between a rung and no rung:
 *
 * ```text
 *    MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k                           65.3 ns/row  hopProjection
 *    MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k              116          hop2Projection
 *    MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d:P) RETURN d.k AS k     2180          THE MATCHER
 * ```
 *
 * The 18.7x between the last two is one segment of difference, measured on the same fixture at
 * 20,000 vertices (`runtime-profile-probe.mjs` `hop2rows` / `hop3rows`, 3 alternated rounds).
 *
 * ⚠️ IT ADMITS THREE SEGMENTS AND UP, NOT TWO, and that boundary is deliberate rather than tidy.
 * `detectHop2Projection` is a shipped, tested rung with its own measured refusals; admitting its
 * shape here would put two detectors on one family and let `runLinear`'s chain order decide which
 * answers it, which is the failure `rung-precedence-decides-speed` records (a WILLING rung starved
 * by a broader one above it, 1.80-6.00x at item 1583). Two hops keep their rung; this one starts
 * where that one stops.
 *
 * ⚠️ WHAT IT DOES *NOT* TAKE, AND THE LARGEST SHAPE IN THE PROBE IS ONE OF THEM. An UNDIRECTED leg
 * declines, via the same direction test `hopOf` applies in the two-hop module — `both`'s contract
 * visits a self-loop from both ends, and a chain of them is a product of interleaved orders. So
 * `hop3rowsboth` (1816 ms over 10 reps, the biggest row in either engine's probe) stays exactly
 * where it is and serves here as a DECLINED CONTROL. Item 1813's specification named it as a thing
 * to measure a win on; that was wrong, and this is the correction — the win is on `hop3rows`.
 *
 * ⚠️ ROW ORDER. Unspecified without an `ORDER BY` (item 198, `order-is-unspecified`), and this walk
 * is start-driven depth-first, which is the order the general matcher already produces — so the two
 * are comparable by eye when a test disagrees. The GQL differential fuzzer was checked rather than
 * assumed before any of this was written: `totallyOrdered` admits a query only when it carries the
 * literal `n.n AS t` AND its final sort key is `t`, so an `ORDER BY`-less chain falls to
 * `resultsEqual`, which sorts the rows away and compares a MULTISET. Paging declines anyway
 * (`plainRowProjection`), which matters more than it looks: a bare `LIMIT` with no `ORDER BY` makes
 * row order decide WHICH rows survive, so admitting it would turn a free choice into an observable
 * one. Item 1781 is the precedent for shipping a route that changes row order, and it needed a
 * multiset-parity probe to do it.
 */
export const detectChainProjection = (
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

  // THREE segments and up. See the header: two belong to `detectHop2Projection`, which still has
  // them. The path-variable refusal is the two-hop module's, for its reason (a `Path` per row), and
  // it pairs with the free-variable test below exactly as it does there.
  if (pattern.pathVar !== undefined || pattern.segments.length < 3) {
    return null;
  }

  const nodes: NodePattern[] = [pattern.start, ...pattern.segments.map((s) => s.node)];

  if (!nodes.every((n: NodePattern) => plainNode(n))) {
    return null;
  }

  const hops: Hop[] = [];

  for (const seg of pattern.segments) {
    const h = hopOf(seg.rel);

    if (h === null) {
      return null;
    }

    hops.push(h);
  }

  // Every node variable in the chain; every projected item and every carried `WHERE` conjunct must
  // read only these. An UNNAMED node is admitted — nothing can read it, so it constrains the walk
  // by label only.
  const named = new Set<string>();

  for (const n of nodes) {
    if (n.variable !== undefined) {
      named.add(n.variable);
    }
  }

  // The AST items, not the compiled ones: `freePredicateVars` walks the AST, and a `CReturnItem`
  // carries a compiled `fn` instead of an `expr`.
  for (const item of ret.projection.items) {
    for (const name of freePredicateVars(item.expr)) {
      if (!named.has(name)) {
        return null;
      }
    }
  }

  const { where } = m;

  if (where !== undefined && !admitsWhere(where, named, nodes[0].variable)) {
    return null;
  }

  const gate = cm.where;

  // A `WHERE` in the AST and no compiled gate (or the reverse) would silently DROP or INVENT a
  // filter. Required to agree rather than assumed to, since the two are read from different places.
  if ((where === undefined) !== (gate === undefined)) {
    return null;
  }

  const { projection } = cret;

  if (
    !plainRowProjectionIgnoringDistinct(ret.projection) ||
    projection.aggregating ||
    projection.items.length === 0
  ) {
    return null;
  }

  // ⚠️ THE TWO WALKS ANSWER THE SAME QUERIES; the gate picks the one that CAN. Item 1816 measured
  // the blocked sweep at 1.49-2.79x of the descent where locality is poor and 0.95-0.97x (ranges
  // overlapping) where it is already good, so it is taken whenever it is applicable rather than
  // behind a topology predictor — the engine has no cheap way to know a graph's locality, and
  // `hasFastPath`-style gating was DECLINED at item 1511.
  /**
   * ⚠️ FUSED ONLY FOR ONE COLUMN — the wider shape keeps the materialize-then-dedupe path below.
   * `projection.items.length === 1` is also what makes the emitted object byte-identical to
   * `projectRow`'s, and `!projection.star` is required because a `star` projection ignores `items`
   * entirely (it copies the binding), so its width is the BINDING's, not one.
   */
  const distinct: DistinctSpec | undefined =
    ret.projection.distinct && !projection.star && projection.items.length === 1
      ? { name: projection.items[0].name, fn: projection.items[0].fn }
      : undefined;

  const rows = farEndOnly(ret.projection.items, where, nodes[nodes.length - 1].variable)
    ? sweep(nodes, hops, projection, gate, distinct)
    : walk(nodes, hops, projection, gate, distinct);

  /**
   * ⚠️ `RETURN DISTINCT` IS ADMITTED AND DEDUPED HERE — item 1820, and the cost of NOT doing this
   * was the whole point: `DISTINCT` used to disqualify this rung outright (it is part of
   * `plainRowProjection`), so a three-hop `RETURN DISTINCT d.n` fell to the general matcher and
   * cost **5.8x MORE than emitting every one of the 625,000 rows it dedupes** — 418.6 ms against
   * this rung's 72.2 ms for the same walk undeduped, to return 8 rows. One hop was unaffected
   * because `hop-projection.ts`'s `distinctShape` already serves it, and that detector refuses
   * `segments.length > 1`, which is exactly the hole.
   *
   * ⚠️ IT CALLS `distinctRows` AND DOES NOT KEY ROWS ITSELF. There is ONE definition of what
   * counts as distinct in this engine (`valueKey`, via `rowKeyOf` and the one-column fast path),
   * it is shared with `UNION`/`EXCEPT`/`INTERSECT`, and it is matched byte-for-byte by the Rust
   * engine. A second keying here would be a cross-engine divergence waiting to happen on exactly
   * the values that are hard — `-0` against `0`, `NaN`, an element keyed by id rather than by
   * object identity, and a string column colliding with an element's key. Items 1561 and 1562 each
   * found a silent answer change in that area; re-deriving it would be the third.
   *
   * ⚠️ AND DEDUPE COMMUTES WITH THE WALK, which is what makes this sound rather than merely
   * faster. The rung's walk order is its own, and `order-is-unspecified` means row order is not
   * part of the answer — so keeping one row per key yields the same SET whichever order they
   * arrive in. That argument does NOT extend to `SKIP`/`LIMIT`, which is why those stay refused:
   * there, order decides WHICH rows survive. See `plainRowProjectionIgnoringDistinct`.
   *
   * ⚠️ ~~THIS MATERIALIZES THE UNDEDUPED ROWS FIRST~~ — TAKEN AT ITEM 1843, for a ONE-COLUMN
   * projection. The dedupe now happens inside both walks (see `emitRow`), so a duplicate never
   * becomes a row object: measured 2.69x here and 2.27x on the two-segment rung, with the
   * undeduped and two-column controls flat. A WIDER projection still materializes and calls
   * `distinctRows` below, because there the key is a `\x01`-joined string over every column and
   * deciding it early buys nothing — that half remains open.
   */
  // Already deduped INSIDE the walk when `distinct` was built; `distinctRows` would then be a
  // second pass over rows that are already unique. The wider projection still needs it.
  return ret.projection.distinct && distinct === undefined
    ? (graph, params) => distinctRows(rows(graph, params))
    : rows;
};

/**
 * A carried clause `WHERE`, under the two-hop module's three conditions.
 *
 * Extracted as its own function only to keep `detectChainProjection` under the complexity gate; the
 * rules and their reasons are `detectHop2Projection`'s, including the one that is a MEASURED refusal
 * rather than a conservative one:
 *
 * ⚠️ A `WHERE` READING THE START VARIABLE DECLINES. The general matcher rejects a start BEFORE
 * expanding it, so a start-anchored predicate costs it one test per VERTEX where this walk pays one
 * per ROW — admitted at two hops it measured a 3.7x REGRESSION. At three hops the ratio of rows to
 * start vertices is strictly larger, so the refusal only gets more right with depth.
 */
const admitsWhere = (
  where: Expr,
  named: ReadonlySet<string>,
  startVar: string | undefined,
): boolean => {
  // Item 175: a zero-variable predicate can still hold a faulting uncorrelated subquery.
  if (!rowLocal(where)) {
    return false;
  }

  const vars = freePredicateVars(where);

  for (const name of vars) {
    if (!named.has(name)) {
      return false;
    }
  }

  return startVar === undefined || !vars.has(startVar);
};

type Hop = { readonly type: string; readonly forward: boolean };

/**
 * One named edge type in one direction, with nothing else on the relationship.
 *
 * `both` is refused by the direction test, and a relationship VARIABLE outright rather than
 * admitted-if-unmentioned — `detectHopProjection` takes that relaxation and its own comment records
 * the subquery-correlation hole it cost (item 444). This module has no need of it.
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
 * Everything the descent reads, built ONCE PER EXECUTION.
 *
 * It is an object rather than nine parameters for two reasons that are both recorded costs: the lint
 * gate caps parameters at six (item 1803 hit it), and `ts-closure-size-is-load-bearing` is the one
 * cost this engine has measured four separate times — a walk written INLINE in a returned closure
 * gave UNRELATED queries a new slow mode at 4x, so the descent is at module scope and takes its
 * state as an argument.
 */
/**
 * THE FUSED `DISTINCT` SINK — item 1843, taking the lever item 1820 left with its number as the
 * floor ("this materializes the undeduped rows first… 625,000 rows are built to return 8").
 *
 * ⚠️ ONE COLUMN ONLY, and that is what makes it sound rather than merely faster. For a
 * single-item projection the ROW key IS the value key: `distinctRows`' own one-column fast path
 * keys a row by `oneColumnValue(r)`, which for a one-item `projectRow` is exactly the value this
 * sink already has in hand before it builds anything. Item 1832 made the same argument in this
 * file for the grouped tally, and items 1561/1562 are why neither re-implements the keying:
 * `addOneColumnKey` is imported, two key spaces and all.
 *
 * A wider projection keeps the materialize-then-`distinctRows` path, because there the key is a
 * `\x01`-joined string over every column and deciding it early buys nothing.
 */
type DistinctSpec = { readonly name: string; readonly fn: (env: EvalEnv) => unknown };

type DistinctSink = DistinctSpec & { readonly keys: OneColumnKeys };

/**
 * The fields both walks' row-building points need. Declared once so `emitRow` is monomorphic over
 * the two states rather than seeing `Descent` and `Sweep` as separate shapes.
 */
type RowSink = {
  readonly graph: Graph;
  readonly params: Params;
  readonly binding: Map<string, unknown>;
  readonly projection: CProjection;
  readonly out: Row[];
  readonly dedup: DistinctSink | undefined;
};

/**
 * ⚠️ AT MODULE SCOPE, NOT INLINE IN THE WALK. `ts-closure-size-is-load-bearing` (item 1570): a
 * walk written inline in a returned closure gave UNRELATED queries a new slow mode at 4x. This is
 * also the single row-building point for BOTH walks, so the deduped and undeduped forms cannot
 * drift apart — the defect item 1832 hit when two copies of a rung needed two copies of a test.
 */
const emitRow = (s: RowSink): void => {
  const { dedup } = s;

  if (dedup === undefined) {
    s.out.push(projectRow(s.projection, s.binding, s.params, s.graph));

    return;
  }

  const v = dedup.fn({ binding: s.binding, params: s.params, graph: s.graph });

  // Byte-identical to `projectRow` for a one-item, non-star projection: it builds `{}` and assigns
  // `row[item.name] = item.fn(env)`, which is this object literal.
  if (addOneColumnKey(dedup.keys, v)) {
    s.out.push({ [dedup.name]: v });
  }
};

type Descent = {
  readonly graph: Graph;
  readonly params: Params;
  readonly hops: readonly Hop[];
  readonly labels: readonly (LabelExpr | undefined)[];
  readonly vars: readonly (string | undefined)[];
  readonly last: number;
  readonly binding: Map<string, unknown>;
  readonly projection: CProjection;
  readonly gate: CompiledExpr | undefined;
  readonly out: Row[];
  readonly dedup: DistinctSink | undefined;
};

/**
 * One level of the chain: expand `v` by `hops[level]`, land on `level + 1`, and either recurse or
 * emit.
 *
 * Depth is the chain's segment count, so the recursion is as deep as the query is long and cannot
 * grow with the DATA — the thing that would make a stack a requirement rather than a style choice.
 */
const descend = (level: number, v: Vertex, d: Descent): void => {
  const hop = d.hops[level];
  const bucket = (hop.forward ? v.adjFrom : v.adjTo)?.get(hop.type);

  if (bucket === undefined) {
    return;
  }

  const landed = level + 1;
  const label = d.labels[landed];
  const variable = d.vars[landed];
  const emitting = landed === d.last;

  for (const e of bucket) {
    const w: Vertex = hop.forward ? e.to : e.from;

    if (!matchesLabel(w, label)) {
      continue;
    }

    if (variable !== undefined) {
      d.binding.set(variable, w);
    }

    if (!emitting) {
      descend(landed, w, d);
      continue;
    }

    /**
     * ⚠️ `asTruth(...) !== true` is the test rather than a falsy check: a clause `WHERE` keeps only
     * rows whose predicate is definitely TRUE, so UNKNOWN (a null comparison) drops like FALSE.
     * `filters.ts`'s rule, and why the comparison is to `true` and not to `false`.
     */
    if (
      d.gate !== undefined &&
      asTruth(d.gate({ binding: d.binding, params: d.params, graph: d.graph })) !== true
    ) {
      continue;
    }

    emitRow(d);
  }
};

/**
 * The BLOCKED LEVEL-SYNCHRONOUS sweep's state. Separate from `Descent` because the two walks need
 * different things: the descent carries a path's worth of bindings, this carries two frontier
 * buffers and only the far variable.
 */
type Sweep = {
  graph: Graph;
  params: Params;
  hops: readonly Hop[];
  labels: readonly (LabelExpr | undefined)[];
  last: number;
  farVar: string | undefined;
  binding: Map<string, unknown>;
  projection: CProjection;
  gate: CompiledExpr | undefined;
  out: Row[];
  dedup: DistinctSink | undefined;
  cur: Vertex[];
  nxt: Vertex[];
};

/**
 * How many starts one sweep carries. Chosen so the live frontier stays small enough to be resident
 * rather than sized to the graph: item 1816 measured the unblocked whole-graph frontier LOSING
 * 1.4-1.7x against the depth-first descent at 200,000 vertices on a cache-friendly topology, because
 * it allocates an array per level for a walk already running at ~16 ns/row. Blocking is what keeps
 * the batching while giving that back — same measurement, 0.95-0.97x on the cells where the
 * unblocked form lost, and 1.49-2.79x where it won.
 */
const SWEEP_BLOCK = 4096;

/**
 * One block, level by level: expand `cur[0..len)` into `nxt`, swap, and emit at the deepest level.
 *
 * ⚠️ AT MODULE SCOPE ON PURPOSE. `ts-closure-size-is-load-bearing` records a walk written INLINE in
 * a returned closure giving UNRELATED queries a new slow mode at 4x, so this is hoisted exactly as
 * `descend` is.
 *
 * ⚠️ THE ROW ORDER DIFFERS FROM `descend`'S and that is free here, not overlooked: row order is
 * unspecified (item 198) and `plainRowProjection` declines every pager, so nothing can observe which
 * rows survive. A bare `LIMIT` is the case that would make order observable and it is already
 * refused one level up.
 */
const sweepBlock = (s: Sweep, len: number): void => {
  let curLen = len;

  for (let level = 0; level < s.last; level += 1) {
    const hop = s.hops[level];
    const landed = level + 1;
    const label = s.labels[landed];
    const emitting = landed === s.last;
    let nxtLen = 0;

    for (let i = 0; i < curLen; i += 1) {
      const v = s.cur[i];
      const bucket = (hop.forward ? v.adjFrom : v.adjTo)?.get(hop.type);

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        const w: Vertex = hop.forward ? e.to : e.from;

        if (!matchesLabel(w, label)) {
          continue;
        }

        if (!emitting) {
          if (nxtLen === s.nxt.length) {
            s.nxt.push(w);
          } else {
            s.nxt[nxtLen] = w;
          }

          nxtLen += 1;
          continue;
        }

        if (s.farVar !== undefined) {
          s.binding.set(s.farVar, w);
        }

        /** `asTruth(...) !== true` for the same reason `descend` uses it: UNKNOWN drops like FALSE. */
        if (
          s.gate !== undefined &&
          asTruth(s.gate({ binding: s.binding, params: s.params, graph: s.graph })) !== true
        ) {
          continue;
        }

        emitRow(s);
      }
    }

    if (emitting) {
      return;
    }

    const swap = s.cur;

    s.cur = s.nxt;
    s.nxt = swap;
    curLen = nxtLen;
  }
};

/**
 * The blocked sweep, for a chain NOTHING BUT THE FAR END READS.
 *
 * ⚠️ WHY IT NEEDS ITS OWN GATE AND CANNOT REPLACE `descend`. A level-synchronous walk batches a
 * whole level, which DISCARDS the path that reached each vertex — so the moment a projected item or
 * a carried `WHERE` reads an INTERIOR variable (`RETURN b.k, d.k` over a four-node chain, which the
 * rung admits today), the information needed to answer is already gone. Carrying it back would mean
 * materializing a path per frontier entry, which is the allocation this arm exists to avoid.
 *
 * ⚠️ ITEM 1813 SPECIFIED EXACTLY THIS CONDITION — "a far-end-only projection needs no path
 * enumeration" — and item 1814 OVERRODE it, correctly, because the general rung admits interior
 * reads on the same guarantees. It returns here as the gate rather than the shape rule: 1813's
 * insight was about which walks can skip the path, not about which queries the rung should admit.
 */
const sweep = (
  nodes: readonly NodePattern[],
  hops: readonly Hop[],
  projection: CProjection,
  gate: CompiledExpr | undefined,
  distinct: DistinctSpec | undefined,
): AlwaysRowsFn => {
  const rawLabels = nodes.map((n) => n.label);
  const last = nodes.length - 1;
  const farVar = nodes[last].variable;

  return (graph: Graph, params: Params): Row[] => {
    const labels = rawLabels.map((l) => effectiveLabel(graph, l));
    const out: Row[] = [];
    const s: Sweep = {
      graph,
      params,
      hops,
      labels,
      last,
      farVar,
      binding: new Map<string, unknown>(),
      projection,
      gate,
      out,
      dedup: distinct && { ...distinct, keys: newOneColumnKeys() },
      cur: [],
      nxt: [],
    };
    const [startLabel] = labels;
    let len = 0;

    for (const a of graph.vertices) {
      if (!matchesLabel(a, startLabel)) {
        continue;
      }

      if (len === s.cur.length) {
        s.cur.push(a);
      } else {
        s.cur[len] = a;
      }

      len += 1;

      if (len === SWEEP_BLOCK) {
        sweepBlock(s, len);
        len = 0;
      }
    }

    if (len > 0) {
      sweepBlock(s, len);
    }

    return out;
  };
};

/**
 * Does nothing but the FAR variable get read? The gate for `sweep` above.
 *
 * An unnamed or unread interior variable is fine — what matters is whether anything READS one, since
 * that is what the batched walk cannot answer. A projected item reading no variable at all (a
 * literal) is admitted for the same reason.
 */
export const farEndOnly = (
  items: readonly { readonly expr: unknown }[],
  where: unknown,
  farVar: string | undefined,
): boolean => {
  if (farVar === undefined) {
    return false;
  }

  for (const item of items) {
    for (const name of freePredicateVars(item.expr as never)) {
      if (name !== farVar) {
        return false;
      }
    }
  }

  if (where !== undefined) {
    for (const name of freePredicateVars(where as never)) {
      if (name !== farVar) {
        return false;
      }
    }
  }

  return true;
};

/**
 * The level walk. ONE `Binding` allocated per call and mutated per row — the reuse every walk in
 * `hop-projection.ts` makes, and `projectRow`'s own header states it never retains the binding.
 *
 * ⚠️ THE LABEL TESTS ARE HOISTED PER CALL, and `effectiveLabel` drops a label carried by EVERY
 * vertex (items 1551/1552/1609). That matters more with depth than anywhere: a three-hop walk tests
 * FOUR labels per row, and item 1609 measured the elision per-ELEMENT costing a control 1.32x — so
 * it is resolved once per execution, not per element and not per compile.
 */
const walk = (
  nodes: readonly NodePattern[],
  hops: readonly Hop[],
  projection: CProjection,
  gate: CompiledExpr | undefined,
  distinct: DistinctSpec | undefined,
): AlwaysRowsFn => {
  const vars = nodes.map((n) => n.variable);
  const rawLabels = nodes.map((n) => n.label);
  const last = nodes.length - 1;
  const [startVar] = vars;

  return (graph: Graph, params: Params): Row[] => {
    const labels = rawLabels.map((l) => effectiveLabel(graph, l));
    const out: Row[] = [];
    const d: Descent = {
      graph,
      params,
      hops,
      labels,
      vars,
      last,
      binding: new Map<string, unknown>(),
      projection,
      gate,
      out,
      // ⚠️ A FRESH KEY SET PER RUN, not per plan: the keys are run state, and sharing them across
      // two executions of one compiled plan would silently drop every row the FIRST run emitted.
      dedup: distinct && { ...distinct, keys: newOneColumnKeys() },
    };
    const [startLabel] = labels;

    for (const a of graph.vertices) {
      if (!matchesLabel(a, startLabel)) {
        continue;
      }

      if (startVar !== undefined) {
        d.binding.set(startVar, a);
      }

      descend(0, a, d);
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
 * `MATCH <chain of 3+ segments> RETURN count(DISTINCT <expr over the far end>)` — item 1824.
 *
 * ⚠️ WHY THIS EXISTS, with the number. `rung-gap-screen.mjs` flagged `count(DISTINCT far.k)` at
 * **4.8x, 6.8x, 10.1x and 10.3x its own undeduped `rows` cell** at depths 2-5, RISING with depth
 * (28.2 -> 56.7 ms) while the `rows` cell stayed flat at ~5 ms. `distinctShape(…, 'count')` serves
 * ONE hop (0.5 ms); every deeper width fell to the general matcher, because this rung and
 * `hop2-projection.ts` both refuse an aggregating projection outright.
 *
 * ⚠️ AND `detectMultiHopAggregate` DOES NOT SERVE THEM, which was established by deletion rather
 * than read off its gate: a `throw` at its ADMISSION point (not its entry — item 1820's lesson)
 * left `count(DISTINCT x.k)` at depths 1, 2 and 3 all answering normally, along with `count(*)` and
 * `sum` at depth 2. So there was no rung to widen, only a hole to fill.
 *
 * ⚠️ IT REUSES `detectChainProjection`'S ENTIRE GATE BY HANDING IT A SYNTHETIC PROJECTION rather
 * than restating the shape rule. Two copies of one shape rule is how the far endpoint ended up on a
 * per-edge tally once before (`detectDistinctCount`'s own note), and this rung's admission tests —
 * three-plus segments, plain nodes, directed single-type hops, the `WHERE`/gate agreement check,
 * the `farEndOnly` sweep-vs-walk decision — are subtle enough that a second copy would drift. The
 * synthetic projection replaces only the COMPILED side's `items`, so the walk builds one column of
 * the aggregate's ARGUMENT; the AST side is untouched, which is what keeps `farEndOnly` reading the
 * real item's free variables.
 *
 * ⚠️ THE NULL RULE IS NOT RE-DERIVED EITHER, AND IT IS THE TRAP HERE. `count(DISTINCT x)` EXCLUDES
 * nulls while `RETURN DISTINCT x` keeps null as a row — over `1, null, absent, 2, 1` the count is 2
 * and the rows are three. So the obvious implementation, `distinctRows(rows).length`, is a SILENT
 * WRONG ANSWER on any fixture carrying a null or an absent property. This folds through
 * `distinctCountFold` itself — the same object the general path uses, keying by `valueKey` — so the
 * two cannot disagree about what counts as distinct, or about nulls.
 */
export const detectChainFoldedAggregate = (
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
    /**
     * ⚠️ THE ITEM MUST *BE* THE AGGREGATE, NOT AN EXPRESSION WRAPPING IT. `count(DISTINCT x) + 1`
     * folds the same aggregate, but the row's value is the arithmetic — answering the fold's result
     * directly would silently drop the `+ 1`. `foldedAggs[].expr` is documented as "the aggregate's
     * own AST node", so identity against the projected item's expression is the exact test.
     */
    ret.projection.items[0].expr !== agg.expr
  ) {
    return null;
  }

  const outName = proj.items[0].name;
  const column = '__chainDistinctCountArg';
  const synthetic: CProjection = {
    ...proj,
    aggregating: false,
    distinct: false,
    items: [{ name: column, fn: agg.argFn, isAgg: false }],
    foldedAggs: undefined,
    groupKeys: [],
  };
  const rows = detectChainProjection(
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

      // Nullish never reaches `step` on the general path either (`stepFolded`'s `isNullish`), and
      // it must not: a null in the set would make a later non-null the SECOND distinct value where
      // it is the first.
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
 * `MATCH <chain> RETURN <items> ORDER BY <output columns>` — item 1827 (three-plus segments).
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
export const detectChainOrderedProjection = (
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

  const rows = detectChainProjection(
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
export const detectChainGroupedCount = (
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
  const rows = detectChainProjection(
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
