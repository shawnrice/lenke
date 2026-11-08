/**
 * THE `FOR` RUNGS: ISO list unwind (`FOR x IN <list>`) counted and projected without the row table.
 *
 * `detectForCount` and `detectForProjection` plus the five symbols only they reach.
 *
 * ⚠️ `FOR` MULTIPLIES THE ROW TABLE, which is what makes a closed form possible and also what makes
 * it easy to get wrong. One row in, one row per list element out — so a COUNT is the sum of the
 * list lengths and never needs the elements, while a PROJECTION does. `perRowForCount` is the first
 * and `forProjectionRows` the second, and they are not variants of each other.
 *
 * ⚠️ `ELEM` AND `ANCHOR` ARE SENTINELS, not values. The unwound element has no name until the
 * clause binds one, and a projection may read the element, the ordinality counter, or the row the
 * `FOR` came from — three different things that all look like "the current value". Naming the two
 * that are not the element is what keeps them apart.
 *
 * ISO calls this `FOR`, not `UNWIND`: the standard's list-unwind clause, and the Cypher name is a
 * different language\'s. The distinction is in CLAUDE.md for a reason.
 */

import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr } from '../ast.js';
import type { CClause, CProjection, CompiledExpr, Params, Row } from './core.js';
import { detectCountShortcut } from './count-shortcut.js';
import { freePredicateVars } from './expr-analysis.js';
import { plainNode } from './hop-sides.js';
import { plainRowProjection, projectRow } from './rows.js';
import { anchorFilterGate, countStarColumn, pageOneRow } from './shortcuts.js';
import { propOf } from './values.js';

/**
 * `MATCH … FOR x IN [a, b, c] RETURN count(*)` — the row multiplier as ARITHMETIC.
 *
 * A `FOR` over a CONSTANT list multiplies every incoming row by the list's length, so the count
 * is the count of the `MATCH` times that length. The general path builds all of them:
 * `MATCH (n:Person) FOR x IN [1, 2, 3] RETURN count(*)` materialized 600,000 rows to count them
 * at **175.1 ms** against the native engine's 3.4 (audit item 515).
 *
 * The base count is the EXISTING shortcut, asked of the clause list with the `FOR` removed —
 * so every shape `detectCountShortcut` already answers (a bare node, a hop, a product, a
 * degree chain) is multiplied, and nothing about counting is re-derived here. The whole rung is
 * "ask the ladder, then multiply".
 *
 * Constant means a LITERAL list whose elements are literals. A per-row list (`FOR t IN n.tags`,
 * 191.1 ms against native's 15.8) needs Σ length over the rows, which is a different walk and
 * is left to the general path; a `$param` list is constant per run but not per compile, and
 * reaching it needs the list evaluated once per execution rather than once per compile.
 */
/**
 * `MATCH (n:L) FOR t IN n.<key> RETURN count(*)` — a PER-ROW list, counted as Σ its lengths.
 *
 * Item 515 took the constant list (one multiplication). A list read from the row needs the
 * anchors walked, but not a row per element: 191.1 ms at 200,000 vertices with three tags each
 * against the native engine's 15.8, because the general path materialized 600,000 rows to count
 * them (audit item 518).
 *
 * ISO's unwind semantics are the whole arithmetic, and each case is a different number:
 *
 *   - a LIST contributes its length (an empty list contributes 0 — the anchor's row disappears);
 *   - NULL or a missing property contributes 0;
 *   - any other scalar contributes 1, because a non-list unwinds as a one-element list.
 *
 * The anchor must be a lone node whose variable the property reads, with no inline properties or
 * `WHERE` — the same admission as item 510's optional count, and for the same reason: its bucket
 * is what this walks.
 */
export const perRowForCount = (
  clauses: readonly Clause[],
  list: Extract<Expr, { kind: 'prop' }>,
  ret: Extract<Clause, { kind: 'return' }>,
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m] = clauses;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1) {
    return null;
  }

  const [pattern] = m.patterns;
  const { start } = pattern;

  if (
    pattern.segments.length !== 0 ||
    pattern.pathVar !== undefined ||
    // The property must read the ANCHOR. Its mutant survives and is equivalent by
    // construction: with ONE lone-node `MATCH` clause the anchor's variable is the only name in
    // scope, so a property on anything else is an unbound reference the compiler rejects before
    // this runs — and a pattern WITH segments (where a second name exists) is refused one line
    // above.
    start.variable !== list.variable
  ) {
    return null;
  }

  // A FILTERED anchor, by item 559's argument on its sibling rung: Σ over the anchors of the
  // list's length is unchanged by WHICH anchors are summed, so a per-anchor gate is all a filter
  // needs. Refusing one cost, at 200,000 vertices with three tags each:
  //
  //   MATCH (n:Person) FOR t IN n.tags RETURN count(*)             3.70 ms
  //   ...WHERE n.age > 60                                         52.75      14.3x
  //   MATCH (n:Person {tag: 'x'}) ...                            125.56      33.9x
  //   MATCH (n:Person WHERE n.age > 60) ...                        52.93      14.3x
  //
  // All three spellings together, for item 559's reason: admitting only the clause form would be
  // the equivalent-spelling bug, and the inline property map was the worst of the three there too.
  const anchorGate = anchorFilterGate(start, m.where, list.variable);

  if (anchorGate === null) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null) {
    return null;
  }

  const proj = ret.projection;
  const name = label?.name;
  const { key } = list;
  const one = (graph: Graph, params: Params): Row => {
    const vertices: Iterable<Vertex> =
      name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
    // ONE binding map for the whole scan, rewritten per anchor — the general path's cost is a
    // fresh `Map` per row, which is what this rung exists to avoid.
    const binding = new Map<string, unknown>();
    let total = 0;

    for (const vertex of vertices) {
      if (anchorGate !== undefined && !anchorGate(vertex, binding, params, graph)) {
        continue;
      }

      const value = vertex.properties[key];

      if (value === null || value === undefined) {
        continue;
      }

      total += Array.isArray(value) ? value.length : 1;
    }

    return { [column]: total };
  };

  if (proj.skip === undefined && proj.limit === undefined) {
    return (graph, params) => [one(graph, params)];
  }

  return (graph, params) =>
    pageOneRow(() => one(graph, params), graph, params, proj.skip, proj.limit);
};
/**
 * `MATCH (n[:L]) FOR t IN <list> RETURN <items>` — the `FOR` PROJECTION off the label bucket.
 *
 * Items 515 and 518 gave the `count(*)` form the arithmetic. The projection has to emit the rows,
 * so there is no arithmetic to replace the walk with — the cost is the walk itself, and the
 * general path pays three allocations an ELEMENT for it: `runFor` copies the whole binding into a
 * `new Map` per element, `elems.map` materializes an array of those per input row, and
 * `mapToRow` walks the surviving map again at the end.
 *
 * Measured at 200,000 vertices with three list elements each (item 528):
 *
 * ```text
 *   MATCH (n:Person) FOR t IN n.tags RETURN t AS t      ts 92.7 ms   native 50.8
 *   MATCH (n:Person) FOR x IN [1, 2, 3] RETURN x AS x   ts 97.4      native 40.1
 *   MATCH (n:Person) RETURN n.age AS k   (no FOR)       ts  9.5      native 11.0
 * ```
 *
 * The third row is the diagnosis: without a `FOR` the TS engine is FASTER than native, so the
 * 2.0-2.4x is not a projection gap — it is the per-element binding machinery, which the plain
 * projection's own rung never touches. 162 ns a row against 48.
 *
 * ONE scratch binding is reused across every element of every anchor, because nothing retains it:
 * `projectRow` reads it and returns a fresh `Row`. The same trick as item 524's landing gate, and
 * for the same reason it is sound there — the only consumer finishes with the binding before the
 * next element overwrites it.
 *
 * The admission:
 *
 *   - exactly `MATCH` / `FOR` / `RETURN`, with a lone plain anchor node (no inline properties, no
 *     clause or inline `WHERE`), since its bucket is what this walks;
 *   - a plain row projection — no `*`, DISTINCT, grouping, ORDER BY or paging, and not
 *     aggregating (items 515 and 518 own the aggregate form);
 *   - the list is either a ROW-INVARIANT expression (`freePredicateVars` empty — evaluated ONCE
 *     and shared, the same invariance check `unwind_rows` makes in the engine, item 519) or a
 *     PROPERTY of the anchor, read straight off the vertex;
 *   - every item's free names are the anchor, the `FOR` variable, or the ordinality variable.
 *     Anything else is not in scope here anyway, but checking is what makes the scratch binding
 *     complete rather than nearly complete.
 *
 * ISO's unwind rule is the same as the counting rungs': a LIST contributes one row per element,
 * an empty list contributes none (the anchor's row disappears), NULL or a missing key contributes
 * none, and any other scalar contributes ONE row — a non-list unwinds as a one-element list.
 */
/**
 * How a `FOR` projection item's cell is produced when the walk already holds the value (item 838):
 * the current list ELEMENT, the ANCHOR vertex, or a property read off that vertex. `undefined`
 * means "not a direct shape", and the item's compiled closure runs as before.
 */
export type ForDirect =
  | { kind: 'elem' }
  | { kind: 'anchor' }
  | { kind: 'prop'; key: string }
  | undefined;
/** The two parameterless variants, allocated once rather than per plan. */
export const ELEM: ForDirect = { kind: 'elem' };
export const ANCHOR: ForDirect = { kind: 'anchor' };
export const detectForProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m, loop, ret] = clauses;
  const [, cloop, cret] = compiled;

  if (m.kind !== 'match' || loop.kind !== 'for' || ret.kind !== 'return') {
    return null;
  }

  if (cloop?.kind !== 'for' || cret?.kind !== 'return' || cret.projection.aggregating) {
    return null;
  }

  if (!plainRowProjection(ret.projection) || m.optional || m.where !== undefined) {
    return null;
  }

  if (m.patterns.length !== 1) {
    return null;
  }

  const [pattern] = m.patterns;
  const { start } = pattern;
  const anchor = start.variable;

  if (
    pattern.segments.length !== 0 ||
    pattern.pathVar !== undefined ||
    anchor === undefined ||
    !plainNode(start) ||
    (start.properties !== undefined && start.properties.length > 0)
  ) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const names = new Set<string>([anchor, loop.alias]);

  if (loop.ordinality !== undefined) {
    names.add(loop.ordinality.var);
  }

  for (const item of ret.projection.items) {
    for (const free of freePredicateVars(item.expr)) {
      if (!names.has(free)) {
        return null;
      }
    }
  }

  // The LIST, in the two forms worth intercepting: row-invariant (one evaluation, shared) or a
  // property of the anchor (read off the vertex, no expression evaluation at all).
  const invariant = freePredicateVars(loop.list).size === 0;
  const key = loop.list.kind === 'prop' && loop.list.variable === anchor ? loop.list.key : null;

  if (!invariant && key === null) {
    return null;
  }

  const name = label?.name;
  const { alias, ordinality } = loop;
  const { projection } = cret;
  const listFn = cloop.list;

  // ITEM 838: the direct read, item 835's lever where the loop holds BOTH variables.
  //
  // Item 832 scoped 835 to a single-variable projection because "a multi-variable projection has
  // no single element to read from". That is true of a HOP, where one end is reached per edge, and
  // false here: this walk holds the anchor vertex and the current list element at once, so every
  // name the admission above permits is already in hand. `compileExpr`'s `var` arm is
  // `(env) => env.binding.get(name)` and its `prop` arm is
  // `(env) => propOf(env.binding.get(variable), key)`, so for these three shapes the closure
  // writes a value into a `Map`, builds an `env` and reads the same value straight back out.
  // Byte-identical by construction: the same value, and `propOf` is the same function on the same
  // vertex.
  //
  // `star` keeps the old path — it projects the BINDING rather than items, so there is nothing to
  // read directly. (`plainRowProjection` already refuses it; this is belt and braces, because the
  // cost of being wrong here is a wrong answer rather than a slow one.)
  const directs: readonly ForDirect[] =
    projection.star || ret.projection.items.length !== projection.items.length
      ? projection.items.map(() => undefined)
      : ret.projection.items.map((it): ForDirect => {
          const e = it.expr;

          if (e.kind === 'prop') {
            return e.variable === anchor ? { kind: 'prop', key: e.key } : undefined;
          }

          if (e.kind !== 'var') {
            return undefined;
          }

          if (e.name === alias) {
            return ELEM;
          }

          return e.name === anchor ? ANCHOR : undefined;
        });

  return (graph, params) =>
    forProjectionRows(graph, params, {
      anchor,
      name,
      alias,
      ordinality,
      projection,
      listFn,
      invariant,
      key,
      cols: projection.items.map((it) => it.name),
      fns: projection.items.map((it) => it.fn),
      directs,
    });
};
/**
 * The per-ROW half of `detectForProjection`, at module scope rather than inside the returned
 * closure: a walk written inline in a closure gives UNRELATED queries a new slow mode (item 268,
 * 4x), and this is a walk over every vertex of a label.
 */
export const forProjectionRows = (
  graph: Graph,
  params: Params,
  plan: {
    anchor: string;
    name: string | undefined;
    alias: string;
    ordinality: { kind: 'ordinality' | 'offset'; var: string } | undefined;
    projection: CProjection;
    listFn: CompiledExpr;
    invariant: boolean;
    key: string | null;
    cols: readonly string[];
    fns: readonly CompiledExpr[];
    directs: readonly ForDirect[];
  },
): Row[] => {
  const { anchor, name, alias, ordinality, projection, listFn, invariant, key } = plan;
  const { cols, fns, directs } = plan;
  const width = cols.length;
  // Item 838. `anyDirect` keeps the untouched shapes on EXACTLY the old path, `projectRow` and
  // all, so a projection this lever cannot serve cannot be slowed by it either.
  const anyDirect = directs.some((d) => d !== undefined);
  const allDirect = width > 0 && directs.every((d) => d !== undefined);
  const vertices: Iterable<Vertex> =
    name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
  const binding = new Map<string, unknown>();
  const out: Row[] = [];
  // A ROW-INVARIANT list is evaluated ONCE, which is the whole point of the check: the engine's
  // `unwind_rows` does the same, and item 519 is the record of what happens when a fast path
  // mirrors an operator's element rule without its invariance rule.
  const shared = invariant ? listFn({ binding, params, graph }) : undefined;

  for (const vertex of vertices) {
    // When every item is direct the binding is never read, so writing it is dead work — item
    // 803's rule, and the same deletion item 835 made at the node-scan site.
    if (!allDirect) {
      binding.set(anchor, vertex);
    }

    const value = key === null ? shared : vertex.properties[key];

    if (value === null || value === undefined) {
      continue;
    }

    const elems: readonly unknown[] = Array.isArray(value) ? value : [value];

    for (let i = 0; i < elems.length; i++) {
      if (!allDirect) {
        binding.set(alias, elems[i]);

        if (ordinality !== undefined) {
          binding.set(ordinality.var, ordinality.kind === 'ordinality' ? i + 1 : i);
        }
      }

      if (!anyDirect) {
        out.push(projectRow(projection, binding, params, graph));
        continue;
      }

      const row: Row = {};

      for (let c = 0; c < width; c++) {
        const d = directs[c];

        if (d === undefined) {
          row[cols[c]] = fns[c]({ binding, params, graph });
        } else if (d.kind === 'elem') {
          row[cols[c]] = elems[i];
        } else if (d.kind === 'anchor') {
          row[cols[c]] = vertex;
        } else {
          row[cols[c]] = propOf(vertex, d.key);
        }
      }

      out.push(row);
    }
  }

  return out;
};
export const detectForCount = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length < 3) {
    return null;
  }

  const ret = clauses[clauses.length - 1];
  const loop = clauses[clauses.length - 2];

  if (ret.kind !== 'return' || loop.kind !== 'for') {
    return null;
  }

  if (loop.list.kind === 'prop') {
    return perRowForCount(clauses, loop.list, ret);
  }

  if (loop.list.kind !== 'list') {
    return null;
  }

  // Only a literal list is constant at compile time. One non-literal element and the length is
  // still known — but an element that FAULTS must fault, and the general path is where that
  // happens, so the whole list has to be inert.
  if (loop.list.items.some((e) => e.kind !== 'lit')) {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null) {
    return null;
  }

  // The base count, asked of the ladder with the `FOR` taken out. `compiled` is sliced the same
  // way so the two lists stay aligned — `detectCountShortcut` reads the compiled start node for
  // its index seeds.
  const base = detectCountShortcut(
    [...clauses.slice(0, -2), ret],
    [...compiled.slice(0, -2), compiled[compiled.length - 1]],
  );

  if (base === null) {
    return null;
  }

  const times = loop.list.items.length;

  return (graph, params) =>
    base(graph, params).map((row) => ({ ...row, [column]: Number(row[column]) * times }));
};
