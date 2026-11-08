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

import type { Clause } from '../ast.js';
import { relTypeNames } from './adjacency.js';
import type { Params, Row } from './core.js';
import { plainNode, plainRel, sideOfVertex } from './hop-sides.js';
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
