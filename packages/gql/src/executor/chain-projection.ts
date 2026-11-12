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

  return walk(nodes, hops, projection, gate);
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
