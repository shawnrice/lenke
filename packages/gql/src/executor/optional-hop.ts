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

import type { Edge, Graph, Vertex } from '@lenke/core';

import type { Clause, Projection } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import { edgesOfTypes, relTypeNames } from './adjacency.js';
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
    /*
     * ⚠️ `plainNode` ALREADY COVERS THE PROPERTIES, and a second operand repeating its
     * properties half stood here until item 2392: `plainNode` is
     * `(properties?.length ?? 0) === 0 && where === undefined`, so
     * `node.properties.length > 0` could never decide anything this call had not already
     * decided. Dead, not merely redundant — removing it cannot change a route.
     */
    !plainNode(node)
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
    /*
     * ITEM-2146-CLOSED-FORM: the whole count from THREE O(1) READS, no walk at all.
     *
     * 🔑 THE ARITHMETIC. Each anchor contributes `max(1, degree)` (item 2123), and
     * `Σ max(1, d) = Σ d + |{anchors with d = 0}|`. The first term is every qualifying edge; the second
     * is the anchors that have none:
     *
     * ```text
     *     count = |edges of the type| + (|anchors| - |anchors having ≥1 such edge|)
     * ```
     *
     * Verified against the walk on the bench fixture: 300,000 + (200,000 - 100,000) = **400,000**, which
     * is exactly what the per-anchor walk answers.
     *
     * ⚠️⚠️ **EVERY TERM IS EXACT ONLY UNDER THE FOUR CONDITIONS BELOW, and each one is load-bearing:**
     *
     * - **a VACUOUS or absent anchor label**, so `|anchors|` is `vertexCount` and every edge of the type
     *   leaves an anchor. A selective label would need the edges FROM that label's vertices, which is not
     *   a counter;
     * - **no anchor `WHERE`** (`anchorGate`), for the same reason;
     * - **no FAR label** — "qualifying" would then depend on the far END, which no counter knows;
     * - **exactly ONE edge label in the whole graph**, checked per CALL because a write can add a second
     *   one to a graph this closure was compiled against.
     *
     * ⚠️⚠️ **THE `withEdge` TERM WAS `edgesFromByLabel.size` AND THAT WAS A WRONG ANSWER (item 2162).**
     * That index keeps a vertex's ENTRY after its last edge is removed — only the per-TYPE bucket inside
     * is deleted — so `.size` counts vertices that no longer have any out-edge and the unmatched set was
     * UNDER-counted. Three vertices and one edge, then `removeEdge`, answered **2 where 3 is right**, and
     * both the closed form and the general path were wrong because the general path's own counter read the
     * same `.size`. 🔑 Found while probing `edgesFromByLabel` for a DIFFERENT feature (the `EXISTS` closed
     * form), not by any test — the mutation round at item 2146 asked whether a removed edge is reflected,
     * and it is, as long as some OTHER edge survives on that vertex.
     *
     * 🔑 `verticesHavingType` walks the index and tests `has(type)`, which IS accurate after a removal.
     * ⚠️ That turns an O(1) read into O(entries-with-any-edge) — still far below the whole-vertex walk it
     * replaces, and the row's measurement after the fix is recorded at item 2162.
     */
    if (closedFormFits(graph, anchorGate, far, types, name)) {
      const [type] = types as string[];
      const withEdge = verticesHavingType(
        out ? graph.edgesFromByLabel : graph.edgesToByLabel,
        type,
      );

      return {
        [column]: (graph.edgesByLabel.get(type)?.size ?? 0) + (graph.vertexCount - withEdge),
      };
    }

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
 * May the OPTIONAL hop count be answered from counters alone (item 2146)?
 *
 * 🔑 Each condition makes one term of `|edges| + (|anchors| - |anchors with an edge|)` exact; see the note
 * at the call site for the arithmetic and the measured prices.
 *
 * ⚠️ `edgesByLabel.size === 1` is the subtle one: `edgesFromByLabel` is keyed by VERTEX and its `.size` is
 * "vertices with ANY out-edge". That equals "vertices with an edge of OUR type" only when the graph holds
 * exactly one edge label. 🔑 Checked per CALL, not per compile, because a write can add a second label to
 * a graph this closure was compiled against.
 */
/**
 * How many vertices have at least one edge of `type` on the index's side.
 *
 * ⚠️⚠️ **NOT `index.size`, AND THAT DISTINCTION IS A WRONG ANSWER (item 2162).** The index is
 * `Map<vertexId, Map<label, Set<Edge>>>` and a vertex's OUTER entry survives the removal of its last
 * edge — only the inner per-type bucket is deleted. Measured directly: after `removeEdge` the entry reads
 * `entry=yes, hasT=false`, so `.size` counts a vertex with no edges at all while `has(type)` does not.
 *
 * 🔑 O(entries having ANY edge on that side), which is already far smaller than the vertex count on a
 * sparse graph — and much smaller than the per-anchor walk this closed form exists to avoid.
 */
const verticesHavingType = (index: Map<string, Map<string, Set<Edge>>>, type: string): number => {
  let n = 0;

  for (const byType of index.values()) {
    if (byType.has(type)) {
      n += 1;
    }
  }

  return n;
};

const closedFormFits = (
  graph: Graph,
  /* Only tested for presence, so the gate's own type need not be imported here. */
  anchorGate: unknown,
  far: unknown,
  types: string[] | undefined,
  name: string | undefined,
): boolean =>
  anchorGate === undefined &&
  far === undefined &&
  types?.length === 1 &&
  graph.edgesByLabel.size === 1 &&
  graph.edgesByLabel.has(types[0]) &&
  // A vacuous (or absent) anchor label: every vertex is an anchor, so `vertexCount` is `|anchors|`.
  (name === undefined || graph.verticesByLabel.get(name)?.size === graph.vertexCount);

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
    /*
     * ⚠️ `plainNode` ALREADY COVERS THE PROPERTIES, and a second operand repeating its
     * properties half stood here until item 2392: `plainNode` is
     * `(properties?.length ?? 0) === 0 && where === undefined`, so
     * `node.properties.length > 0` could never decide anything this call had not already
     * decided. Dead, not merely redundant — removing it cannot change a route.
     */
    !plainNode(node)
  ) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const picked = hopKeyedCountStar(ret.projection, v, node.variable);

  if (picked === null) {
    return null;
  }

  const { keyCol, countCol, keyProp, onFar } = picked;
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

      /*
       * ⚠️⚠️ **TWO WALKS, BECAUSE THE KEY'S END DECIDES THE SHAPE** — `detectGroupedHopCount`'s own rule,
       * and the OPTIONAL twin needs it for the same reason.
       *
       * 🔑 START-KEYED: read the anchor's property ONCE and add its whole `max(1, degree)` to that group.
       * O(V), and the degree never has to be itemized.
       *
       * 🔑 FAR-KEYED (item 2124): the anchor's group is not known in advance — each EDGE lands in the
       * group its own far endpoint names, and an anchor with NO qualifying edge contributes one row to
       * the NULL group (verified: `b.k` of a null `b` is NULL). O(V + E).
       *
       * ⚠️ AND A FAR VERTEX WHOSE KEY IS LEGITIMATELY NULL MERGES WITH THAT GROUP — verified against the
       * general path: two edges to null-keyed far ends plus three unmatched anchors answer ONE group of
       * five, not two groups. Keying both through `valueKey(… ?? null)` is what makes that automatic.
       */
      if (!onFar) {
        const d = sideOfVertex(vertex, out, types, far);
        // 🔑 THE `max(1, …)`: an unmatched anchor still contributes its null-filled row, to ITS group.
        const add = d === 0 ? 1 : d;

        bump(groups, vertex.properties[keyProp] ?? null, add);

        continue;
      }

      let matched = 0;

      for (const edge of edgesOfTypes(out ? vertex.adjFrom : vertex.adjTo, types)) {
        const other = out ? edge.to : edge.from;

        // The far label is tested here exactly as `sideOfVertex` tests it, so both walks agree on WHICH
        // edges qualify.
        if (far !== undefined && !matchesLabel(other, far)) {
          continue;
        }

        matched += 1;
        bump(groups, other.properties[keyProp] ?? null, 1);
      }

      if (matched === 0) {
        // ⚠️ THE NULL-FILLED ROW: `b` is null, so `b.k` is NULL and the row groups there.
        bump(groups, null, 1);
      }
    }

    const rows: Row[] = [];

    for (const { key, n } of groups.values()) {
      rows.push({ [keyCol]: key, [countCol]: n });
    }

    return rows;
  };
};

/** Add `n` to the group `key` names, keeping the key value as the group's representative. */
const bump = (groups: Map<string, { key: unknown; n: number }>, key: unknown, n: number): void => {
  const k = valueKey(key);
  const seen = groups.get(k);

  if (seen === undefined) {
    /*
     * ⚠️ INSERTION-ORDERED, and the bucket holds the KEY VALUE as well as the tally: `valueKey` is not
     * reversible, so the representative has to be kept. That is `detectGroupedHopCount`'s own rule.
     */
    groups.set(k, { key, n });
  } else {
    seen.n += n;
  }
};

/**
 * `RETURN <a-or-b>.<k> AS g, count(*) AS c` — the two-item projection this rung answers, or `null`.
 *
 * ⚠️ EXACTLY TWO ITEMS, one a property of the ANCHOR and one a bare `count(*)`. 🔑 `SKIP`/`LIMIT`/`ORDER
 * BY` are refused: the walk emits in group-insertion order, and a page or a sort would make that order
 * decide WHICH rows survive — the same reason items 2119/2120's gates refuse them.
 */
const hopKeyedCountStar = (
  proj: Projection,
  anchorVar: string,
  farVar: string | undefined,
): { keyCol: string; countCol: string; keyProp: string; onFar: boolean } | null => {
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

  if (key.kind !== 'prop' || typeof key.key !== 'string') {
    return null;
  }

  /*
   * ⚠️ THE KEY MUST NAME ONE END OF THIS HOP — the anchor or the far node — and nothing else.
   *
   * ⚠️⚠️ **BOTH CONDITIONS BELOW ARE UNREACHABLE TODAY, AND THEIR MUTANTS SURVIVE BECAUSE OF IT** — not
   * because the tests are weak. Item 2124 checked each candidate instead of asserting teeth it does not
   * have:
   *
   * - A key over the EDGE (`r.k`) needs a named relationship variable, which `rel.variable !== undefined`
   *   refuses ABOVE, before the projection is analyzed. Verified: the query answers correctly via the
   *   general path with the guard mutated away.
   * - A key over an UNBOUND variable (`c.k`) **throws** at validation (`variable \`c\` is not defined`),
   *   before any rung is consulted.
   * - `key.variable` is never `undefined` for a `prop` expression, so the `farVar !== undefined` arm
   *   cannot fire either; it exists so an anonymous far end can never match by comparing
   *   `undefined === undefined`.
   *
   * 🔑 They stay because they are the gate's CONTRACT — the walk below reads one end or the other and has
   * no third behaviour — and because each costs one comparison per COMPILE, not per row. ⚠️ A reader who
   * mutates them and sees a survivor should read this comment rather than conclude the tests are blind.
   */
  const onFar = key.variable === farVar && farVar !== undefined;

  if (!onFar && key.variable !== anchorVar) {
    return null;
  }

  const c = countItem.expr;

  // A BARE `count(*)`, not `count(x)` (which excludes the null row) and not an expression wrapping it.
  if (c.kind !== 'func' || c.name !== 'count' || !c.star || c.distinct) {
    return null;
  }

  return { keyCol: keyItem.alias, countCol: countItem.alias, keyProp: key.key, onFar };
};
