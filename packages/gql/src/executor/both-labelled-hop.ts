import type { Graph } from '@lenke/core';

/**
 * `MATCH (a:L)-[:T]->(b:L) RETURN count(*)` when BOTH endpoints carry the SAME label — counted from the
 * label's COMPLEMENT instead of by testing every edge (item 2194).
 *
 * ⚠️⚠️ **WHY THIS EXISTS: the existing path tests EVERY EDGE'S BOTH ENDPOINTS.** `labelOnlyHopCount`'s two
 * arms need exactly one end labelled (`startWalkFits` / `farWalkFits`), so a pattern with BOTH ends
 * labelled declines to `countEdges(edgesOfTypes(...), nearThenFar(a, b))` — the type's whole edge bucket
 * with two `matchesLabel` calls each. A differential profile at item 2193 put that at **+750.9 ms over 40
 * reps, the entire far-label cost**, against a `bareDegreeSum` that falls to **0.0** when the far label is
 * dropped.
 *
 * ```text
 *     MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b:Person) RETURN count(b)
 *     engine, before        30.83 ms    answer 300000
 *     complement ceiling     1.81 ms    answer 300000   <- item 2193's measured ceiling, 17x
 * ```
 *
 * 🔑 **THE ARITHMETIC IS ASYMMETRIC ON PURPOSE, AND A SYMMETRIC VERSION IS WRONG.** The wanted count is
 * the edges with BOTH endpoints in `L`, so the complement count must be the edges with EITHER endpoint
 * outside it — and summing each off-label vertex's in- and out-degree DOUBLE-COUNTS an edge whose two
 * endpoints are both outside. ⚠️ Item 2193's ceiling probe did exactly that and still got the right
 * answer, because its single off-label vertex had no edges at all.
 *
 * So: for every vertex outside `L`, take ALL of its out-edges of the type, and take its in-edges ONLY
 * when the source IS inside `L`. An edge with its source outside is then counted once (via that source);
 * an edge with only its target outside is counted once (via that target); an edge with both outside is
 * counted once (via its source, because the in-pass excludes it). **Every edge with an endpoint outside
 * `L` is counted exactly once.**
 *
 * ⚠️ **THE GATE IS A SIZE COMPARISON, because this is only a win while the complement is SMALL.**
 * `verticesByLabel` holds the label's MEMBERS, so the complement's size is `vertexCount - members.size`,
 * and iterating it means walking every vertex and testing membership — O(V) with an O(1) test, against
 * the O(E) with two label tests it replaces. A label carried by a minority of vertices must keep the old
 * path.
 */
export const bothLabelledHopCount = (graph: Graph, label: string, type: string): number | null => {
  const members = graph.verticesByLabel.get(label);

  if (members === undefined) {
    /* No vertex carries the label, so no edge can have both endpoints in it. */
    return 0;
  }

  const total = graph.edgesByLabel.get(type)?.size;

  if (total === undefined) {
    return 0;
  }

  const outside = graph.vertexCount - members.size;

  /*
   * ⚠️ THE GATE. The complement pass is O(outside) vertices plus their incident edges of this type; the
   * path it replaces is O(total) edges with two label tests each. Requiring the complement to be a small
   * fraction keeps this a win rather than a coin flip — a label on half the graph would make the two
   * comparable and this one carries an extra `verticesById` walk.
   */
  if (outside * 8 > total) {
    return null;
  }

  let outsideTouching = 0;

  for (const v of graph.verticesById.values()) {
    if (members.has(v)) {
      continue;
    }

    /* ALL out-edges of the type: their source is outside `L`. */
    outsideTouching += graph.edgesFromByLabel.get(v.id)?.get(type)?.size ?? 0;

    /*
     * ⚠️ IN-EDGES ONLY WHERE THE SOURCE IS INSIDE — this is the asymmetry the doc comment explains. An
     * edge with both endpoints outside was already counted by its source's out-pass.
     */
    const incoming = graph.edgesToByLabel.get(v.id)?.get(type);

    if (incoming !== undefined) {
      for (const edge of incoming) {
        if (members.has(edge.from)) {
          outsideTouching += 1;
        }
      }
    }
  }

  return total - outsideTouching;
};
