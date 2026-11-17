/**
 * THE OPTIONAL-HOP COUNT RUNG: `OPTIONAL MATCH (a)-[:T]->(b) RETURN count(*)`.
 *
 * ⚠️ AN OPTIONAL HOP COUNTS DIFFERENTLY FROM A PLAIN ONE, AND THAT IS THE WHOLE RUNG. A plain hop
 * drops a row whose pattern finds nothing; an OPTIONAL one KEEPS it with the far side null-filled.
 * So the count is not the edge count — it is the edge count plus one for every start vertex with no
 * qualifying edge. A rung that reused the plain-hop closed form would under-count by exactly the
 * number of unmatched starts, and over a graph where most vertices have no edge of the type that is
 * most of the answer.
 *
 * It is a module of ONE symbol, which is unusual here and deliberate: it has no private machinery
 * (its 149 lines are all its own) and no family to join — the node-scan, grouped-hop, reachability
 * and for-unwind families each have their own, and this belongs to none of them. The alternative
 * was pairing it with `detectCountShortcut` on the strength of both having "count" in the name,
 * which is the kind of grab-bag this split exists to undo.
 */

import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Projection } from '../ast.js';
import { relTypeNames } from './adjacency.js';
import type { Params, Row } from './core.js';
import { plainNode, plainRel, sideOfVertex } from './hop-sides.js';
import { valueKey } from './rows.js';
import { anchorFilterGate, countStarColumn, pageOneRow } from './shortcuts.js';

export const detectOptionalHopCount = (
  clauses: readonly Clause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m, om, ret] = clauses;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    om.kind !== 'match' ||
    !om.optional ||
    om.where !== undefined ||
    om.patterns.length !== 1 ||
    ret.kind !== 'return'
  ) {
    return null;
  }

  const [anchor] = m.patterns;
  const v = anchor.start.variable;

  if (anchor.segments.length !== 0 || anchor.pathVar !== undefined || v === undefined) {
    return null;
  }

  // A FILTERED anchor (item 559). The rung's arithmetic is Σ max(1, degree) over the anchors, so a
  // filter changes WHICH anchors are summed and nothing else — `sideOfVertex` below is untouched.
  // Refusing one cost 191.69 ms against the unfiltered 8.12 at 200,000 vertices, and the INLINE
  // property spelling 391.04, which `plainNode` was refusing on top. All three spellings go
  // through `anchorFilterGate`; `plainNode` is deliberately NOT asked of the anchor any more,
  // since it refuses exactly the inline forms this rung now takes.
  const anchorGate = anchorFilterGate(anchor.start, m.where, v);

  if (anchorGate === null) {
    return null;
  }

  const { label } = anchor.start;

  if (label !== undefined && label.kind !== 'label') {
    return null; // a compound label expression is not a bucket
  }

  const [hop] = om.patterns;

  if (hop.pathVar !== undefined || hop.segments.length !== 1 || hop.start.variable !== v) {
    return null;
  }

  const [seg] = hop.segments;
  const { rel, node } = seg;

  if (
    !plainRel(rel) ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    !plainNode(node) ||
    (node.properties !== undefined && node.properties.length > 0)
  ) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null) {
    return null;
  }

  const proj = ret.projection;
  const out = rel.direction === 'out';
  const far = node.label;
  const name = label?.name;
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

      // The FLOOR is the whole difference from the plain hop count: an anchor with no
      // matching neighbour still contributes its one null-filled row.
      const d = sideOfVertex(vertex, out, types, far);

      total += d === 0 ? 1 : d;
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
 * THE GROUPED OPTIONAL-HOP COUNT: `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(b) RETURN a.k, count(*)`.
 *
 * ⚠️⚠️ **THE PAIR HAD NO RUNG THOUGH EACH HALF DID, AND THAT COST 18x.** `detectOptionalHopCount` above
 * answers the UNGROUPED form and `detectGroupedHopCount` the NON-OPTIONAL grouped one; the combination
 * fell to the general path — one binding and one row per edge, then grouping. Measured at 200,000
 * vertices / 600,000 edges, 97 groups out:
 *
 * ```text
 *     OPTIONAL alone (plain count)      8.6 ms     <- the rung above
 *     grouping alone (MATCH + group)   20.7        <- `detectGroupedHopCount`
 *     OPTIONAL + grouping             378.3        <- 18.3x the grouped MATCH, 44x the OPTIONAL count
 *     OPTIONAL rows (the walk)        129.7        <- so the grouped form cost 2.9x the walk itself
 * ```
 *
 * 🔑 IT IS THE RUNG ABOVE's ARITHMETIC, PER GROUP. That one sums `max(1, degree)` over the anchors; this
 * one adds each anchor's `max(1, degree)` to the group its key names. ⚠️ The `max(1, …)` is the whole
 * difference from the plain grouped count — an anchor with no qualifying edge still contributes its one
 * null-filled row, and to its OWN group. Verified against the general path: three anchors with degrees
 * 2, 1 and 0 over two groups answer `{g:0,c:3}, {g:1,c:2}` where the non-OPTIONAL twin answers 2 and 1.
 *
 * ⚠️ **THE KEY MUST READ ONLY THE ANCHOR.** Grouping happens per anchor vertex in one pass, so a key over
 * the FAR end would need the edges — that is `detectGroupedHopCount`'s far-keyed walk and a different
 * shape. A key reading anything else is refused rather than guessed at.
 *
 * ⚠️ `count(b)` IS NOT THIS RUNG: it excludes the null row (verified — 2 and 1 where `count(*)` gives 3
 * and 2), so it is the plain grouped count's arithmetic and belongs to that rung. Only `count(*)` here.
 */
export const detectOptionalGroupedHopCount = (
  clauses: readonly Clause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m, om, ret] = clauses;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    om.kind !== 'match' ||
    !om.optional ||
    om.where !== undefined ||
    om.patterns.length !== 1 ||
    ret.kind !== 'return'
  ) {
    return null;
  }

  const [anchor] = m.patterns;
  const v = anchor.start.variable;

  if (anchor.segments.length !== 0 || anchor.pathVar !== undefined || v === undefined) {
    return null;
  }

  const anchorGate = anchorFilterGate(anchor.start, m.where, v);

  if (anchorGate === null) {
    return null;
  }

  const { label } = anchor.start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const [hop] = om.patterns;

  if (hop.pathVar !== undefined || hop.segments.length !== 1 || hop.start.variable !== v) {
    return null;
  }

  const [seg] = hop.segments;
  const { rel, node } = seg;

  if (
    !plainRel(rel) ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    !plainNode(node) ||
    (node.properties !== undefined && node.properties.length > 0)
  ) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const picked = anchorKeyedCountStar(ret.projection, v);

  if (picked === null) {
    return null;
  }

  const { keyCol, countCol, keyProp } = picked;
  const out = rel.direction === 'out';
  const far = node.label;
  const name = label?.name;

  return (graph: Graph, params: Params): Row[] => {
    const vertices: Iterable<Vertex> =
      name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
    // ONE binding map for the whole scan, as the ungrouped rung does.
    const binding = new Map<string, unknown>();
    /*
     * ⚠️ INSERTION-ORDERED, and the bucket holds the KEY VALUE as well as the tally: `valueKey` is not
     * reversible, so the representative has to be kept. That is `detectGroupedHopCount`'s own rule.
     */
    const groups = new Map<string, { key: unknown; n: number }>();

    for (const vertex of vertices) {
      if (anchorGate !== undefined && !anchorGate(vertex, binding, params, graph)) {
        continue;
      }

      const d = sideOfVertex(vertex, out, types, far);
      // 🔑 THE `max(1, …)`: an unmatched anchor still contributes its null-filled row, to ITS group.
      const add = d === 0 ? 1 : d;
      const key = vertex.properties[keyProp] ?? null;
      const k = valueKey(key);
      const seen = groups.get(k);

      if (seen === undefined) {
        groups.set(k, { key, n: add });
      } else {
        seen.n += add;
      }
    }

    const rows: Row[] = [];

    for (const { key, n } of groups.values()) {
      rows.push({ [keyCol]: key, [countCol]: n });
    }

    return rows;
  };
};

/**
 * `RETURN <anchor>.<k> AS g, count(*) AS c` — the two-item projection this rung answers, or `null`.
 *
 * ⚠️ EXACTLY TWO ITEMS, one a property of the ANCHOR and one a bare `count(*)`. 🔑 `SKIP`/`LIMIT`/`ORDER
 * BY` are refused: the walk emits in group-insertion order, and a page or a sort would make that order
 * decide WHICH rows survive — the same reason items 2119/2120's gates refuse them.
 */
const anchorKeyedCountStar = (
  proj: Projection,
  anchorVar: string,
): { keyCol: string; countCol: string; keyProp: string } | null => {
  if (
    proj.items.length !== 2 ||
    proj.distinct ||
    proj.star ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  /*
   * ⚠️ EITHER ORDER: `RETURN a.k, count(*)` and `RETURN count(*), a.k` are the same question, and
   * refusing the second would be an equivalent-spelling gap of exactly the kind this repo is organised
   * around. The property item is whichever one IS a property.
   */
  const [a, b] = proj.items;
  let keyItem;

  if (a.expr.kind === 'prop') {
    keyItem = a;
  } else if (b.expr.kind === 'prop') {
    keyItem = b;
  } else {
    return null;
  }

  const countItem = keyItem === a ? b : a;

  if (keyItem.alias === undefined || countItem.alias === undefined) {
    return null;
  }

  const key = keyItem.expr;

  if (key.kind !== 'prop' || key.variable !== anchorVar || typeof key.key !== 'string') {
    return null;
  }

  const c = countItem.expr;

  // A BARE `count(*)`, not `count(x)` (which excludes the null row) and not an expression wrapping it.
  if (c.kind !== 'func' || c.name !== 'count' || !c.star || c.distinct) {
    return null;
  }

  return { keyCol: keyItem.alias, countCol: countItem.alias, keyProp: key.key };
};
