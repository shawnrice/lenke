import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr, LabelExpr, NodePattern, RelPattern } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import type { CClause, CompiledExpr, CProjection, Params, Row } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import type { AlwaysRowsFn } from './hop-projection.js';
import { plainNode, plainRel } from './hop-sides.js';
import { effectiveLabel } from './labels.js';
import { plainRowProjection, projectRow } from './rows.js';
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
    !plainRowProjection(ret.projection) ||
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
  return farEndOnly(ret.projection.items, where, nodes[nodes.length - 1].variable)
    ? sweep(nodes, hops, projection, gate)
    : walk(nodes, hops, projection, gate);
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

    d.out.push(projectRow(d.projection, d.binding, d.params, d.graph));
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

        s.out.push(projectRow(s.projection, s.binding, s.params, s.graph));
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
